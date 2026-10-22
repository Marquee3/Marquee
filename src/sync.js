import { normalizeValues, truthy } from './expression.js';
import { HubSpotError } from './hubspot.js';
import { silentLogger } from './logger.js';
import { DEAL, LINE_ITEM_KEY, STATUS } from './properties.js';
import {
  LINE_ITEM_READ_PROPERTIES,
  findDuplicates,
  isEmptyPlan,
  planReconciliation,
  toLineItemProperties,
} from './reconcile.js';
import {
  MESSAGES,
  REVIEW_HINT,
  afterSyncDue,
  changedKeys,
  digestOf,
  formatFingerprint,
  knownEntries,
  lineFingerprints,
  parseFingerprint,
  pendingAfterSync,
  sameText,
  triage,
  triageProperties,
  truncate,
} from './triage.js';

/**
 * Brings a deal's calculator line items in line with its calculator output.
 *
 * Outcomes:
 *   synced     line items were created, updated or removed
 *   unchanged  line items already match the calculator output
 *
 * Either way, settings.afterSync is saved with the status (result.afterSync
 * lists what was set).
 *   skipped    the deal is frozen, already has a quote, or fails settings.syncWhen
 *   noop       no calculator applies and the app has never touched the deal
 *   error      nothing (or not everything) could be applied; see message
 *
 * A result with retry: true failed for a reason that may pass (HubSpot
 * unavailable, rate limited) and should be tried again later.
 */
export class LineItemSync {
  constructor({ hubspot, config, products, logger = silentLogger, now = () => new Date() }) {
    this.hubspot = hubspot;
    this.config = config;
    this.products = products;
    this.logger = logger;
    this.now = now;
    this.calculatorIds = new Set(config.calculators.map((calc) => calc.id));
  }

  async syncDeal(dealId, { dryRun = false, force = false } = {}) {
    dealId = String(dealId);
    let deal;
    try {
      deal = await this.hubspot.getDeal(dealId, triageProperties(this.config).concat('deal_currency_code'));
    } catch (err) {
      // A deleted deal (404) is not worth retrying.
      const retry = !(err instanceof HubSpotError && err.status === 404);
      return this.#log({ dealId, outcome: 'error', message: `Could not read deal: ${describeError(err)}`, retry });
    }

    try {
      return this.#log(await this.#sync(deal, { dryRun, force }));
    } catch (err) {
      // fingerprintAfterFailure is only set once applying changes had started.
      const started = err?.fingerprintAfterFailure !== undefined;
      const message = `${started ? 'Line items may be only partly updated' : 'Line items were not changed'}: ${describeError(err)}`;
      // If applying had started, the lines being changed are in an unknown
      // state: forget just their fingerprints so the next sync re-checks
      // them. Otherwise the stored fingerprint still describes what's on the
      // deal, and is kept.
      const saved = await this.#writeStatus(deal, { status: STATUS.error, message, fingerprint: err?.fingerprintAfterFailure }, dryRun);
      // Until the error is saved, the deal may show "synced" over lines that
      // were partly changed, so try again later.
      return this.#log({ dealId, outcome: 'error', message, dryRun, retry: isTransient(err) || !saved.ok });
    }
  }

  async #sync(deal, { dryRun, force }) {
    const dealId = String(deal.id);
    const properties = deal.properties ?? {};
    // Line items not from a calculator, listed by dry runs (plan) so leftover
    // lines that the calculator lines replace can be spotted.
    let unmanaged = null;
    const result = (outcome, message, extra = {}) => ({
      dealId,
      outcome,
      message,
      dryRun,
      ...(dryRun && unmanaged?.length ? { unmanaged } : {}),
      ...extra,
    });
    // A real run stops at a quote hold (below); a dry run goes on to show the
    // plan, but mustn't report afterSync values a real run wouldn't set.
    const t = triage(this.config, properties);
    const noAfterSync = dryRun && !force && t.reason === 'quote';
    // dealText is what the deal shows, when it differs from the result message.
    const status = async (outcome, statusValue, message, extra = {}, fingerprint, dealText = message) => {
      const saved = await this.#writeStatus(deal, { status: statusValue, message: dealText, fingerprint }, dryRun);
      // If the status couldn't be recorded, try again later: until it is,
      // the deal may not show what was applied (or that it has calculator
      // lines at all).
      if (!saved.ok) return result('error', `${message} (but the status could not be saved; will retry)`, { ...extra, retry: true });
      if (saved.afterSyncError) return result('error', saved.afterSyncError, extra);
      return result(outcome, message, { ...extra, ...(noAfterSync ? {} : afterSyncResult(saved.afterSync)) });
    };

    // 1. Decide from the deal's own properties (the poller does the same).
    if (t.reason === 'syncWhen') {
      // Not written to the deal: syncWhen typically excludes most deals
      // (e.g. closed ones) and a status on each would just be noise.
      return result('skipped', 'Deal does not match settings.syncWhen.');
    }
    if (t.reason === 'syncWhenError') return status('error', STATUS.error, t.syncWhenError);
    if (t.reason === 'noop') {
      if (!force) return result('noop', 'No calculator applies to this deal.', { desired: [] });
      // --force skips the shortcut, but never a freeze.
      if (truthy(normalizeValues(properties)[DEAL.frozen])) return status('skipped', STATUS.skipped, MESSAGES.frozen);
    }
    if (t.reason === 'frozen') return status('skipped', STATUS.skipped, MESSAGES.frozen);

    const { evaluation } = t;
    if (evaluation.errors.length) {
      return status('error', STATUS.error, MESSAGES.inputErrors(evaluation.errors), { errors: evaluation.errors });
    }

    // The go-ahead was given again with nothing to change: just save
    // settings.afterSync. The deal's message still describes its lines.
    if (!force && t.reason === 'afterSync') {
      const dealText = properties[DEAL.message] || MESSAGES.alreadyMatch;
      return status('unchanged', STATUS.synced, 'No line item changes needed.', { desired: evaluation.lines }, undefined, dealText);
    }

    // Nothing to do if every line is what was last applied (decided before
    // any API call). This leaves the team's edits alone when something
    // unrelated changes on the deal.
    if (!force && !dryRun && (t.reason === 'unchanged' || t.reason === 'quote')) {
      const message = t.reason === 'quote' ? quoteMessage(t.stored) : 'Calculator output is unchanged since the last sync.';
      return result(t.reason === 'quote' ? 'skipped' : 'unchanged', message, { desired: evaluation.lines });
    }

    // 2. Resolve products and work out the line items the deal should have.
    const skus = evaluation.lines.filter((line) => line.product.sku).map((line) => line.product.sku);
    const { products, errors: productErrors } = skus.length
      ? await this.products.resolve(skus)
      : { products: new Map(), errors: [] };
    if (productErrors.length) {
      return status('error', STATUS.error, MESSAGES.inputErrors(productErrors), { errors: productErrors });
    }
    const { setLineOrder, skipWhenQuoteExists } = this.config.settings;
    const desired = evaluation.lines.map((line, index) => ({
      ...line,
      productId: line.product.id ?? products.get(line.product.sku).id,
      position: setLineOrder ? index : null,
    }));
    // Fingerprints: what each line should be now, and what was last applied.
    // Entries for calculators no longer in the config are carried over
    // untouched, so restoring a calculator doesn't make its lines look new.
    const fingerprints = t.fingerprints ?? lineFingerprints(evaluation.lines);
    const storedAll = parseFingerprint(properties[DEAL.fingerprint]);
    const stored = storedAll && knownEntries(storedAll, this.calculatorIds);
    const orphanEntries = storedAll ? [...storedAll].filter(([key]) => !stored.has(key)) : [];
    const fingerprint = formatFingerprint(new Map([...orphanEntries, ...fingerprints]));

    // 3. Every line already matches what was last applied (the status just
    // needs to say so, e.g. after an error was fixed).
    const upToDate = !force && stored && changedKeys(stored, fingerprints).size === 0;
    if (upToDate && !dryRun) return status('unchanged', STATUS.synced, MESSAGES.alreadyMatch, { desired }, fingerprint);

    // 4. Compare with the deal's current line items. Only lines whose
    // calculated values changed are re-applied (all of them when forced, or
    // when there's no usable fingerprint from an earlier sync).
    const scope = force || !stored ? null : changedKeys(stored, fingerprints);
    const existing = await this.#readLineItems(dealId);
    unmanaged = existing
      .filter((item) => !item.properties?.[LINE_ITEM_KEY])
      .map(({ id, properties: p = {} }) => ({ id: String(id), name: p.name ?? '', productId: p.hs_product_id ?? null, quantity: p.quantity ?? null, price: p.price ?? null }));
    const plan = planReconciliation(desired, existing, { calculatorIds: this.calculatorIds, scope });
    // A dry run reads the lines so plan can list them, but reports what a
    // real run does (step 3): nothing changed.
    if (upToDate) {
      const keep = [...plan.keep, ...plan.reorder, ...plan.archive].map(({ id, key }) => ({ id, key }));
      const shown = { ...plan, create: [], update: [], reorder: [], archive: [], keep };
      return status('unchanged', STATUS.synced, MESSAGES.alreadyMatch, { desired, plan: shown }, fingerprint);
    }

    if (isEmptyPlan(plan)) {
      // A forced sync of a deal the service doesn't manage leaves no trace.
      if (t.reason === 'noop') return result('noop', 'No calculator applies to this deal.', { desired, plan });
      const message = desired.length
        ? MESSAGES.alreadyMatch
        : plan.orphans.length
          ? MESSAGES.orphansLeft(plan.orphans.length)
          : MESSAGES.noCalculator;
      return status('unchanged', STATUS.synced, message, { desired, plan }, fingerprint);
    }

    // 5. Don't change line items under a quote the team has already built.
    // The fingerprint keeps what was last applied, plus a marker for the
    // output held back, so the deal isn't re-checked until that changes.
    if (skipWhenQuoteExists) {
      const quotes = await this.hubspot.getAssociatedIds('deals', dealId, 'quotes', { max: 1 });
      if (quotes.length) {
        const held = formatFingerprint(storedAll ?? new Map(), { quote: digestOf(fingerprints) });
        return status('skipped', STATUS.skipped, quoteMessage(stored), { desired, plan }, held);
      }
    }

    const calculatorNames = this.#calculatorNames(plan);
    if (dryRun) {
      const afterSync = !noAfterSync && afterSyncDue(this.config, properties) ? pendingAfterSync(this.config, properties) : {};
      return result('synced', describePlan(plan, calculatorNames), { desired, plan, ...afterSyncResult(afterSync) });
    }

    // 6. Apply.
    let duplicatesRemoved = 0;
    try {
      if (plan.archive.length) await this.hubspot.archiveLineItems(plan.archive.map((item) => item.id));
      if (plan.update.length || plan.reorder.length) await this.hubspot.updateLineItems([...plan.update, ...plan.reorder]);
      if (plan.create.length) {
        const currency = properties.deal_currency_code || undefined;
        await this.hubspot.createLineItems(dealId, plan.create.map((line) => toLineItemProperties(line, { currency })));
        // If another sync of this deal ran at the same moment (a second server
        // instance, or a retried request that had in fact succeeded), both may
        // have created the same lines. Re-read and keep one of each.
        const duplicates = findDuplicates(await this.#readLineItems(dealId), { calculatorIds: this.calculatorIds });
        if (duplicates.length) {
          await this.hubspot.archiveLineItems(duplicates.map((item) => item.id));
          duplicatesRemoved = duplicates.length;
        }
      }
    } catch (err) {
      // Lines being changed are in an unknown state: mark them so the next
      // sync re-checks them, whether or not the output still includes them.
      const uncertain = scope ?? new Set([...(stored?.keys() ?? []), ...fingerprints.keys()]);
      const known = [...(storedAll ?? [])].filter(([key]) => !uncertain.has(key));
      err.fingerprintAfterFailure = formatFingerprint(new Map([...known, ...[...uncertain].map((key) => [key, UNKNOWN])]));
      throw err;
    }

    const message = describePlan(plan, calculatorNames, duplicatesRemoved);
    return status('synced', STATUS.synced, message, { desired, plan, duplicatesRemoved, changed: true }, fingerprint);
  }

  async #readLineItems(dealId) {
    const ids = await this.hubspot.getAssociatedIds('deals', dealId, 'line_items');
    return ids.length ? this.hubspot.readLineItems(ids, LINE_ITEM_READ_PROPERTIES) : [];
  }

  /**
   * Write the sync status to the deal, plus settings.afterSync when the
   * status is synced and afterSync is due. Returns { ok: false } if the write
   * failed, and an afterSyncError if HubSpot refused the afterSync values.
   */
  async #writeStatus(deal, { status, message, fingerprint }, dryRun) {
    const text = truncate(message);

    // Skip the write when the deal already says this. Every write changes
    // the deal's last-modified time, which would make the poller pick the
    // deal up again and again.
    const current = deal.properties ?? {};
    const synced = status === STATUS.synced;
    const sameStatus = current[DEAL.status] === status && sameText(current[DEAL.message], text);
    const sameFingerprint = fingerprint === undefined || (current[DEAL.fingerprint] ?? '') === fingerprint;
    let afterSync = synced && afterSyncDue(this.config, current) ? pendingAfterSync(this.config, current) : {};
    if (sameStatus && sameFingerprint && !Object.keys(afterSync).length) return { ok: true };
    if (dryRun) return { ok: true, afterSync };
    if (Object.keys(afterSync).length) {
      // If the calculator values or the go-ahead changed while this sync ran,
      // don't use up the go-ahead (or overwrite a newer status) with output
      // this sync didn't apply. The change itself brings the deal back.
      const names = [...this.config.dealProperties, ...Object.keys(this.config.settings.afterSync)];
      let fresh;
      try {
        fresh = (await this.hubspot.getDeal(deal.id, names)).properties ?? {};
      } catch (err) {
        this.logger.error('could not re-read deal before saving settings.afterSync', { dealId: deal.id, error: describeError(err) });
        return { ok: false };
      }
      if (names.some((name) => (fresh[name] ?? '') !== (current[name] ?? ''))) {
        this.logger.info('deal changed during sync; settings.afterSync left for the next sync', { dealId: deal.id });
        afterSync = {};
        if (sameStatus && sameFingerprint) return { ok: true, afterSync };
      }
    }
    const properties = {
      [DEAL.status]: status,
      [DEAL.message]: text,
      [DEAL.syncedAt]: this.now().toISOString(),
    };
    if (fingerprint !== undefined) properties[DEAL.fingerprint] = fingerprint;
    try {
      await this.hubspot.updateDeal(deal.id, { ...properties, ...afterSync });
      return { ok: true, afterSync };
    } catch (err) {
      if (!Object.keys(afterSync).length || isTransient(err)) {
        this.logger.error('could not write sync status to deal', { dealId: deal.id, error: describeError(err) });
        return { ok: false };
      }
      // Probably an afterSync value HubSpot won't accept (e.g. not one of a
      // dropdown's options). Show that on the deal instead; if this write
      // fails too, the problem was something else.
      const afterSyncError = truncate(MESSAGES.afterSyncFailed(describeError(err, { setupHint: false })));
      const shown = current[DEAL.status] === STATUS.error && sameText(current[DEAL.message], afterSyncError) && sameFingerprint;
      if (shown) return { ok: true, afterSyncError };
      try {
        await this.hubspot.updateDeal(deal.id, { ...properties, [DEAL.status]: STATUS.error, [DEAL.message]: afterSyncError });
        return { ok: true, afterSyncError };
      } catch (again) {
        this.logger.error('could not write sync status to deal', { dealId: deal.id, error: describeError(again) });
        return { ok: false };
      }
    }
  }

  // Names of the calculators whose line items the plan changes.
  #calculatorNames(plan) {
    const ids = new Set([...plan.create, ...plan.update, ...plan.archive].map((item) => item.key.split(':')[0]));
    return this.config.calculators.filter((calc) => ids.has(calc.id)).map((calc) => calc.name);
  }

  #log(result) {
    const { dealId, outcome, message, dryRun, retry } = result;
    const level = outcome === 'error' ? 'error' : 'info';
    this.logger[level]('deal sync', { dealId, outcome, dryRun: dryRun || undefined, retry: retry || undefined, message });
    return result;
  }
}

function describePlan(plan, calculatorNames, duplicatesRemoved = 0) {
  const replaced = plan.archive.filter((item) => item.reason === 'product changed').length;
  const removed = plan.archive.filter((item) => item.reason === 'no longer in calculator output').length;
  const duplicates = plan.archive.filter((item) => item.reason === 'duplicate').length + duplicatesRemoved;
  const reordered = plan.reorder?.length ?? 0;
  const parts = [];
  if (plan.create.length - replaced > 0) parts.push(`added ${plan.create.length - replaced}`);
  if (plan.update.length) parts.push(`updated ${plan.update.length}`);
  if (replaced) parts.push(`swapped the product on ${replaced}`);
  if (removed) parts.push(`removed ${removed}`);
  if (reordered) parts.push(`reordered ${reordered}`);
  const total = plan.create.length + plan.update.length + removed + reordered;
  const summary = parts.length ? `${capitalize(joinList(parts))} line item${plural(total)}` : 'No line item changes';
  const from = calculatorNames.length ? ` from ${joinList(calculatorNames)}` : '';
  const dupes = duplicates ? ` Removed ${duplicates} duplicate${plural(duplicates)}.` : '';
  return `${summary}${from}.${dupes} ${REVIEW_HINT}`;
}

// Worth retrying: rate limits, HubSpot outages and network failures.
// Held back by a quote: before any line was added, or after (stored is
// what was last applied).
function quoteMessage(stored) {
  return stored?.size ? MESSAGES.quote : MESSAGES.quoteFirst;
}

// Fingerprint value for a line whose last update may have partly failed.
const UNKNOWN = 'unknown';

// settings.afterSync values set (or that a dry run would set), if any.
function afterSyncResult(values) {
  return values && Object.keys(values).length ? { afterSync: values } : {};
}

function isTransient(err) {
  if (err instanceof HubSpotError) return err.status === 429 || err.status >= 500;
  const detail = `${err?.message ?? ''} ${err?.cause?.code ?? ''}`;
  return /fetch failed|network|socket|terminated|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(detail);
}

function describeError(err, { setupHint = true } = {}) {
  const message = err?.message ?? String(err);
  if (err instanceof HubSpotError && err.status === 403) {
    return `${message} (the access token lacks a permission this needs; "npm run check" lists what's missing)`;
  }
  if (setupHint && /calc_line|PROPERTY_DOESNT_EXIST|does not exist/i.test(message)) {
    return `${message} (have the app's custom properties been created? Run "npm run setup".)`;
  }
  return message;
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
