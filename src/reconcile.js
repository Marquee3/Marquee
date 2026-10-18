import { LINE_ITEM_KEY } from './properties.js';

// Line item properties the app compares or writes.
export const LINE_ITEM_READ_PROPERTIES = [
  LINE_ITEM_KEY,
  'hs_product_id',
  'quantity',
  'price',
  'name',
  'description',
  'hs_position_on_quote',
];

const NUMERIC_PROPERTIES = new Set(['quantity', 'price', 'hs_position_on_quote']);

/** HubSpot properties for a new line item. */
export function toLineItemProperties(line, { currency } = {}) {
  const properties = {
    [LINE_ITEM_KEY]: line.key,
    hs_product_id: String(line.productId),
    ...managedProperties(line),
  };
  if (currency) properties.hs_line_item_currency_code = currency;
  return properties;
}

// The properties the app owns on an existing line item. Price, name and
// description are only managed when the calculator config sets them;
// otherwise the values HubSpot copied from the product library are kept.
// Discounts, tax and anything else the team edits are never touched.
function managedProperties(line) {
  const properties = { quantity: String(line.quantity) };
  if (line.position !== null && line.position !== undefined) properties.hs_position_on_quote = String(line.position);
  if (line.price !== null) properties.price = String(line.price);
  if (line.name !== null) properties.name = line.name;
  if (line.description !== null) properties.description = line.description;
  return properties;
}

/** The calculator id part of a line key ("licences:seats" -> "licences"). */
export function calculatorIdOf(key) {
  return String(key).split(':')[0];
}

/**
 * Compare the line items a deal should have with the ones it has, and work
 * out the changes.
 *
 * Never touched:
 *   - line items without a calculator line key (added by hand);
 *   - line items from calculators that aren't in the config (`calculatorIds`),
 *     so removing a calculator file, or a deploy that loads no calculators,
 *     can't strip line items from deals. These are listed in `orphans`.
 *
 * `scope` (a Set of line keys, or null for all) limits which desired lines
 * are re-applied: lines whose calculated values haven't changed since the
 * last sync are left as the team may have edited (or deleted) them.
 * Duplicates, and lines a calculator no longer produces, are always removed.
 *
 * @param desired  [{ key, productId, quantity, price, name, description, position }]
 * @param existing [{ id, properties }] line items currently on the deal
 */
export function planReconciliation(desired, existing, { calculatorIds = null, scope = null } = {}) {
  const known = (key) => !calculatorIds || calculatorIds.has(calculatorIdOf(key));
  const managed = groupByKey(existing);
  const plan = { create: [], update: [], reorder: [], archive: [], keep: [], orphans: [] };

  for (const [key, items] of managed) {
    if (!known(key)) {
      plan.orphans.push(...items.map((item) => ({ id: item.id, key })));
      managed.delete(key);
      continue;
    }
    for (const duplicate of items.slice(1)) plan.archive.push({ id: duplicate.id, key, reason: 'duplicate' });
  }

  const wanted = new Set();
  for (const line of desired) {
    wanted.add(line.key);
    const current = managed.get(line.key)?.[0];
    if (scope && !scope.has(line.key)) {
      // Unchanged since the last sync: keep whatever is on the deal,
      // including a line the team deliberately deleted. Only its position
      // follows the config, so lines added or removed around it can't leave
      // two lines in the same place.
      if (current) {
        const position = line.position ?? null;
        if (position !== null && !sameNumber(current.properties?.hs_position_on_quote ?? null, String(position))) {
          plan.reorder.push({ id: current.id, key: line.key, properties: { hs_position_on_quote: String(position) } });
        } else {
          plan.keep.push({ id: current.id, key: line.key });
        }
      }
      continue;
    }
    if (!current) {
      plan.create.push(line);
    } else if (String(current.properties?.hs_product_id ?? '') !== String(line.productId)) {
      // HubSpot copies product details (name, SKU, billing terms) when a line
      // item is created, so a product swap is a replace, not an update.
      plan.archive.push({ id: current.id, key: line.key, reason: 'product changed' });
      plan.create.push(line);
    } else {
      const changes = diff(current.properties ?? {}, managedProperties(line));
      if (Object.keys(changes).length) {
        plan.update.push({
          id: current.id,
          key: line.key,
          changes,
          properties: Object.fromEntries(Object.entries(changes).map(([name, [, to]]) => [name, to])),
        });
      } else {
        plan.keep.push({ id: current.id, key: line.key });
      }
    }
  }

  for (const [key, items] of managed) {
    if (!wanted.has(key)) plan.archive.push({ id: items[0].id, key, reason: 'no longer in calculator output' });
  }
  return plan;
}

export function isEmptyPlan(plan) {
  return !plan.create.length && !plan.update.length && !plan.archive.length && !(plan.reorder?.length);
}

/**
 * Extra copies of the same calculator line on a deal. The copy with the
 * lowest ID is kept, so two processes cleaning up at the same time both
 * remove the same extras and never delete every copy. Lines from
 * calculators not in `calculatorIds` are left alone.
 */
export function findDuplicates(lineItems, { calculatorIds = null } = {}) {
  return [...groupByKey(lineItems)]
    .filter(([key]) => !calculatorIds || calculatorIds.has(calculatorIdOf(key)))
    .flatMap(([, items]) => items.slice(1));
}

function groupByKey(lineItems) {
  const groups = new Map();
  for (const item of lineItems) {
    const key = item.properties?.[LINE_ITEM_KEY];
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const items of groups.values()) items.sort((a, b) => compareIds(a.id, b.id));
  return groups;
}

function compareIds(a, b) {
  const x = String(a);
  const y = String(b);
  if (/^\d+$/.test(x) && /^\d+$/.test(y)) {
    const [bx, by] = [BigInt(x), BigInt(y)];
    return bx < by ? -1 : bx > by ? 1 : 0;
  }
  return x.localeCompare(y);
}

function diff(current, target) {
  const changes = {};
  for (const [name, to] of Object.entries(target)) {
    const from = current[name] ?? null;
    const same = NUMERIC_PROPERTIES.has(name) ? sameNumber(from, to) : (from ?? '') === to;
    if (!same) changes[name] = [from, to];
  }
  return changes;
}

function sameNumber(a, b) {
  if (a === null || a === '' || b === null || b === '') return a === b;
  return Math.abs(Number(a) - Number(b)) < 1e-9;
}
