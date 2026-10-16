import { createHash } from 'node:crypto';
import { evaluateCalculators } from './calculators.js';
import { ExpressionError, normalizeValues, truthy } from './expression.js';
import { DEAL, STATUS } from './properties.js';
import {
  LINE_ITEM_READ_PROPERTIES,
  findDuplicates,
  isEmptyPlan,
  planReconciliation,
  toLineItemProperties,
} from './reconcile.js';
import { silentLogger } from './logger.js';

const MAX_MESSAGE_LENGTH = 2000;
const REVIEW_HINT = 'Review them, then create the quote.';

/**
 * Brings a deal's calculator line items in line with its calculator output.
 *
 * Outcomes:
 *   synced     line items were created, updated or removed
 *   unchanged  line items already match the calculator output
 *   skipped    the deal is frozen, already has a quote, or fails settings.syncWhen
 *   noop       no calculator applies and the app has never touched the deal
 *   error      nothing (or not everything) could be applied; see message
 */
export class LineItemSync {
  constructor({ hubspot, config, products, logger = silentLogger, now = () => new Date() }) {
    this.hubspot = hubspot;
    this.config = config;
    this.products = products;
    this.logger = logger;
    this.now = now;
  }

  async syncDeal(dealId, { dryRun = false, force = false } = {}) {
    dealId = String(dealId);
    let deal;
    try {
      deal = await this.hubspot.getDeal(dealId, this.#dealPropertiesToRead());
    } catch (err) {
      return this.#log({ dealId, outcome: 'error', message: `Could not read deal: ${describeError(err)}` });
    }

    try {
      return this.#log(await this.#sync(deal, { dryRun, force }));
    } catch (err) {
      const message = `Line items may be only partly updated: ${describeError(err)}`;
      await this.#writeStatus(deal, { status: STATUS.error, message }, dryRun);
      return this.#log({ dealId, outcome: 'error', message, dryRun });
    }
  }

  async #sync(deal, { dryRun, force }) {
    const dealId = String(deal.id);
    const properties = deal.properties ?? {};
    const values = normalizeValues(properties);
    const result = (outcome, message, extra = {}) => ({ dealId, outcome, message, dryRun, ...extra });

    const { syncWhen, skipWhenQuoteExists, setLineOrder } = this.config.settings;
    let inScope = true;
    try {
      inScope = !syncWhen || truthy(syncWhen.evaluate(values));
    } catch (err) {
      if (!(err instanceof ExpressionError)) throw err;
      const message = `Line items were not changed: settings.syncWhen: ${err.message}`;
      await this.#writeStatus(deal, { status: STATUS.error, message }, dryRun);
      return result('error', message);
    }
    if (!inScope) {
      // Not written to the deal: syncWhen typically excludes most deals
      // (e.g. closed ones) and a status on each would just be noise.
      return result('skipped', 'Deal does not match settings.syncWhen.');
    }

    if (truthy(values[DEAL.frozen])) {
      const message = 'Line items are frozen on this deal, so they were not updated. Untick "Calculator line items: freeze" to re-sync them.';
      await this.#writeStatus(deal, { status: STATUS.skipped, message }, dryRun);
      return result('skipped', message);
    }

    // 1. Work out the line items the deal should have.
    const evaluation = evaluateCalculators(this.config, properties);
    const skus = evaluation.lines.filter((line) => line.product.sku).map((line) => line.product.sku);
    const { products, errors: productErrors } = skus.length
      ? await this.products.resolve(skus)
      : { products: new Map(), errors: [] };
    const errors = [...evaluation.errors, ...productErrors];
    if (errors.length) {
      const message = `Line items were not changed because the calculator output couldn't be turned into line items:\n• ${errors.join('\n• ')}`;
      await this.#writeStatus(deal, { status: STATUS.error, message }, dryRun);
      return result('error', message, { errors });
    }

    const desired = evaluation.lines.map((line, index) => ({
      ...line,
      productId: line.product.id ?? products.get(line.product.sku).id,
      position: setLineOrder ? index : null,
    }));
    const fingerprint = fingerprintOf(desired);

    // 2. Nothing to do if the calculator output is what was last applied.
    // This also leaves the team's manual edits alone when an unrelated
    // property change triggers a sync.
    if (!force && fingerprint === properties[DEAL.fingerprint]) {
      if (properties[DEAL.status] !== STATUS.synced) {
        await this.#writeStatus(deal, { status: STATUS.synced, message: `Line items already match the calculator. ${REVIEW_HINT}`, fingerprint }, dryRun);
      }
      return result('unchanged', 'Calculator output is unchanged since the last sync.', { desired });
    }

    // 3. Compare with the deal's current line items.
    const existing = await this.#readLineItems(dealId);
    const plan = planReconciliation(desired, existing);

    if (isEmptyPlan(plan)) {
      if (!desired.length && !properties[DEAL.fingerprint] && !properties[DEAL.status]) {
        // A deal the app has never touched and no calculator applies to.
        return result('noop', 'No calculator applies to this deal.', { desired, plan });
      }
      const message = desired.length
        ? `Line items already match the calculator. ${REVIEW_HINT}`
        : 'No calculator applies to this deal, so it has no calculator line items.';
      await this.#writeStatus(deal, { status: STATUS.synced, message, fingerprint }, dryRun);
      return result('unchanged', message, { desired, plan });
    }

    // 4. Don't change line items under a quote the team has already built.
    if (skipWhenQuoteExists) {
      const quotes = await this.hubspot.getAssociatedIds('deals', dealId, 'quotes', { max: 1 });
      if (quotes.length) {
        const message =
          'The calculator output changed, but this deal already has a quote, so its line items were left as they are. ' +
          'Update them by hand, or delete the quote and then tick and untick "Calculator line items: freeze" to re-sync.';
        await this.#writeStatus(deal, { status: STATUS.skipped, message }, dryRun);
        return result('skipped', message, { desired, plan });
      }
    }

    const calculatorNames = this.#calculatorNames(plan);
    if (dryRun) return result('synced', describePlan(plan, calculatorNames), { desired, plan });

    // 5. Apply.
    if (plan.archive.length) await this.hubspot.archiveLineItems(plan.archive.map((item) => item.id));
    if (plan.update.length) await this.hubspot.updateLineItems(plan.update);
    let duplicatesRemoved = 0;
    if (plan.create.length) {
      const currency = properties.deal_currency_code || undefined;
      await this.hubspot.createLineItems(dealId, plan.create.map((line) => toLineItemProperties(line, { currency })));
      // If another sync of this deal ran at the same moment (a second server
      // instance, or a retried request that had in fact succeeded), both may
      // have created the same lines. Re-read and keep one of each.
      const duplicates = findDuplicates(await this.#readLineItems(dealId));
      if (duplicates.length) {
        await this.hubspot.archiveLineItems(duplicates.map((item) => item.id));
        duplicatesRemoved = duplicates.length;
      }
    }

    const message = describePlan(plan, calculatorNames, duplicatesRemoved);
    await this.#writeStatus(deal, { status: STATUS.synced, message, fingerprint }, dryRun);
    return result('synced', message, { desired, plan, duplicatesRemoved });
  }

  async #readLineItems(dealId) {
    const ids = await this.hubspot.getAssociatedIds('deals', dealId, 'line_items');
    return ids.length ? this.hubspot.readLineItems(ids, LINE_ITEM_READ_PROPERTIES) : [];
  }

  async #writeStatus(deal, { status, message, fingerprint }, dryRun) {
    if (dryRun) return;
    const properties = {
      [DEAL.status]: status,
      [DEAL.message]: truncate(message),
      [DEAL.syncedAt]: this.now().toISOString(),
    };
    if (fingerprint !== undefined) properties[DEAL.fingerprint] = fingerprint;
    // An error clears the fingerprint so the next trigger retries in full.
    if (status === STATUS.error) properties[DEAL.fingerprint] = '';
    try {
      await this.hubspot.updateDeal(deal.id, properties);
    } catch (err) {
      this.logger.error('could not write sync status to deal', { dealId: deal.id, error: describeError(err) });
    }
  }

  // Names of the calculators whose line items the plan changes.
  #calculatorNames(plan) {
    const ids = new Set([...plan.create, ...plan.update, ...plan.archive].map((item) => item.key.split(':')[0]));
    return this.config.calculators.filter((calc) => ids.has(calc.id)).map((calc) => calc.name);
  }

  #dealPropertiesToRead() {
    return [...new Set([...this.config.dealProperties, ...Object.values(DEAL), 'deal_currency_code'])];
  }

  #log(result) {
    const { dealId, outcome, message, dryRun } = result;
    const level = outcome === 'error' ? 'error' : 'info';
    this.logger[level]('deal sync', { dealId, outcome, dryRun: dryRun || undefined, message });
    return result;
  }
}

/** Stable fingerprint of the line items a deal should have. */
export function fingerprintOf(desired) {
  const canonical = desired.map((line) => [
    line.key,
    String(line.productId),
    line.quantity,
    line.price,
    line.name,
    line.description,
    line.position,
  ]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32);
}

function describePlan(plan, calculatorNames, duplicatesRemoved = 0) {
  const replaced = plan.archive.filter((item) => item.reason === 'product changed').length;
  const removed = plan.archive.filter((item) => item.reason === 'no longer in calculator output').length;
  const duplicates = plan.archive.filter((item) => item.reason === 'duplicate').length + duplicatesRemoved;
  const parts = [];
  if (plan.create.length - replaced > 0) parts.push(`added ${plan.create.length - replaced}`);
  if (plan.update.length) parts.push(`updated ${plan.update.length}`);
  if (replaced) parts.push(`swapped the product on ${replaced}`);
  if (removed) parts.push(`removed ${removed}`);
  const summary = parts.length ? `${capitalize(joinList(parts))} line item${plural(plan.create.length + plan.update.length + removed)}` : 'No line item changes';
  const from = calculatorNames.length ? ` from ${joinList(calculatorNames)}` : '';
  const dupes = duplicates ? ` Removed ${duplicates} duplicate${plural(duplicates)}.` : '';
  return `${summary}${from}.${dupes} ${REVIEW_HINT}`;
}

function describeError(err) {
  const message = err?.message ?? String(err);
  if (/calc_line|PROPERTY_DOESNT_EXIST|does not exist/i.test(message)) {
    return `${message} (have the app's custom properties been created? Run "npm run setup".)`;
  }
  return message;
}

function truncate(text) {
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : text;
}

function joinList(items) {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function plural(n) {
  return n === 1 ? '' : 's';
}
