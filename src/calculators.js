import { ExpressionError, normalizeValues, truthy } from './expression.js';

/**
 * Work out which line items a deal should have, from its properties and the
 * calculator config. Pure: no HubSpot calls. Products referenced by SKU are
 * resolved to IDs separately.
 *
 * @returns {{
 *   lines: Array<{ key, calculatorId, product, quantity, price, name, description }>,
 *   calculators: Array<{ id, name }>,   // calculators that applied to this deal
 *   errors: string[],
 * }}
 */
export function evaluateCalculators(config, dealProperties) {
  const values = normalizeValues(dealProperties);
  const lines = [];
  const calculators = [];
  const errors = [];

  for (const calc of config.calculators) {
    let applies = true;
    if (calc.appliesWhen) {
      try {
        applies = truthy(calc.appliesWhen.evaluate(values));
      } catch (err) {
        errors.push(`${calc.name}: appliesWhen: ${messageOf(err)}`);
        continue;
      }
    }
    if (!applies) continue;
    calculators.push({ id: calc.id, name: calc.name });

    for (const line of calc.lineItems) {
      try {
        const result = evaluateLine(line, values);
        if (result) lines.push({ key: line.fullKey, calculatorId: calc.id, ...result });
      } catch (err) {
        errors.push(`${calc.name} › ${line.key}: ${messageOf(err)}`);
      }
    }
  }

  return { lines, calculators, errors };
}

function evaluateLine(line, values) {
  if (line.includeWhen && !truthy(field('includeWhen', () => line.includeWhen.evaluate(values)))) return null;

  const quantity = clean(field('quantity', () => line.quantity.evaluateNumber(values)));
  if (quantity < 0) throw new ExpressionError(`quantity is negative (${quantity})`);
  // A zero quantity means "not needed on this deal", e.g. no heaters for a
  // summer event, so the line is left off rather than added at 0.
  if (quantity === 0) return null;

  let price = null;
  if (line.unitPrice) price = field('unitPrice', () => line.unitPrice.evaluateNumber(values));
  if (line.totalPrice) price = field('totalPrice', () => line.totalPrice.evaluateNumber(values)) / quantity;
  if (price !== null) {
    price = clean(price);
    if (price < 0) throw new ExpressionError(`price is negative (${price}); HubSpot line item prices can't be negative`);
  }

  return {
    product: line.product.skuFrom ? { sku: field('product', () => skuIn(values, line.product.skuFrom)) } : line.product,
    quantity,
    price,
    name: textOrNull(line.name && field('name', () => line.name.render(values))),
    description: textOrNull(line.description && field('description', () => line.description.render(values))),
  };
}

// The SKU in a deal property: the whole value, or the part in brackets at
// the end of one like "Delivery – 81–200m vehicle (DEL-81200)".
function skuIn(values, name) {
  const value = values[name];
  if (value === null || value === undefined) throw new ExpressionError(`deal property "${name}" is empty`);
  const text = String(value).trim();
  const sku = (text.match(/\(([^()]*)\)$/)?.[1] ?? text).trim();
  if (!sku) throw new ExpressionError(`deal property "${name}" has no SKU in it ("${text}")`);
  return sku;
}

function field(label, fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ExpressionError) throw new ExpressionError(`${label}: ${err.message}`);
    throw err;
  }
}

// Trim floating point noise (0.1 + 0.2) so values compare and display cleanly.
function clean(n) {
  return Number(n.toFixed(6));
}

function textOrNull(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  return trimmed ? trimmed : null;
}

function messageOf(err) {
  if (err instanceof ExpressionError) return err.message;
  throw err;
}
