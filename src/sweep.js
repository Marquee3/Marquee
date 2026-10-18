// Finding deals that need a sync, using HubSpot's deal search. Shared by
// the Node poller (src/poller.js) and the Cloudflare Worker's cron trigger
// (src/worker.js), and by the CLI's backfill.
//
// Each deal found is triaged on the properties the search returns (see
// src/triage.js), so deals that don't need a sync cost no further API calls.

import { DEAL, STATUS } from './properties.js';
import { triage, triageProperties } from './triage.js';

const PAGE_SIZE = 200;

/**
 * Deals modified at or after `sinceMs` that need a sync, oldest first.
 *
 * Pages by timestamp (keyset), not by result offset: a deal modified again
 * while paging moves to the end of the results and would shift an offset,
 * silently skipping others. Calls onDeal(id, modified) for each deal that
 * needs a sync.
 *
 * quietMs: deals changed more recently than this are left for the next
 * sweep, so a calculator that writes several properties in quick
 * succession is synced once it has finished.
 * seen: optional Map(dealId -> hs_lastmodifieddate) of versions already
 * handled; updated as deals are passed to onDeal.
 *
 * Returns { scanned, found, cursor, capped }: cursor is the timestamp
 * reached, capped is true when maxPages ran out before the end.
 */
export async function findChangedDeals({ hubspot, config, sinceMs, maxPages = 50, quietMs = 0, now = Date.now(), seen, onDeal }) {
  const properties = triageProperties(config);
  let cursor = sinceMs;
  let after;
  let pages = 0;
  let scanned = 0;
  let found = 0;
  // Deals at a page-boundary timestamp come back on the next page too.
  // Keyed by version, so a deal changed again while paging is still seen.
  const handled = new Map();

  for (;;) {
    const page = await hubspot.searchDeals({
      filterGroups: [{ filters: [{ propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: String(cursor) }] }],
      sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
      properties,
      after,
      limit: PAGE_SIZE,
    });
    pages++;

    let lastMs = null;
    for (const deal of page.results) {
      scanned++;
      const id = String(deal.id);
      const modified = deal.properties?.hs_lastmodifieddate ?? null;
      const modifiedMs = toMs(modified);
      // Results are oldest first, so from the first deal still in its quiet
      // period, every later one is too. Stop there: the cursor then can't
      // move past deals that haven't been looked at yet.
      if (Number.isFinite(modifiedMs) && now - modifiedMs < quietMs) {
        return { scanned, found, cursor: modifiedMs, capped: false };
      }
      if (Number.isFinite(modifiedMs)) lastMs = modifiedMs;
      if (handled.get(id) === modified || (seen && modified && seen.get(id) === modified)) continue;
      handled.set(id, modified);
      seen?.set(id, modified);
      if (triage(config, deal.properties ?? {}).action === 'skip') continue;
      found++;
      await onDeal(id, modified);
    }

    if (!page.after || !page.results.length) return { scanned, found, cursor: lastMs ?? cursor, capped: false };
    if (pages >= maxPages) return { scanned, found, cursor: lastMs ?? cursor, capped: true };
    if (lastMs !== null && lastMs > cursor) {
      // Start the next page from the newest timestamp seen. Deals at exactly
      // that timestamp come back again; `seen` (or the triage) skips them.
      cursor = lastMs;
      after = undefined;
    } else {
      // A whole page shares one timestamp: step through it by offset.
      after = page.after;
    }
  }
}

/**
 * Deals whose last sync ended in "Needs attention", re-checked periodically
 * because the fix is often outside the deal (a product added to the
 * library, a calculator file corrected), which doesn't change the deal and
 * so doesn't bring it back into the modified-since window. Deals that
 * triage can rule out (closed deals excluded by syncWhen, or an input error
 * the deal already shows) are skipped, so they aren't re-queued forever.
 */
export async function findErrorDeals({ hubspot, config, maxPages = 10, onDeal }) {
  // Most recently changed first, so when there are more than the page
  // budget covers, it's the old, long-standing ones that wait.
  const properties = triageProperties(config);
  let found = 0;
  let after;
  for (let pages = 0; pages < maxPages; pages++) {
    const page = await hubspot.searchDeals({
      filterGroups: [{ filters: [{ propertyName: DEAL.status, operator: 'EQ', value: STATUS.error }] }],
      sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
      properties,
      after,
      limit: PAGE_SIZE,
    });
    for (const deal of page.results) {
      if (triage(config, deal.properties ?? {}).action === 'skip') continue;
      found++;
      await onDeal(String(deal.id));
    }
    after = page.after;
    if (!after || !page.results.length) return { found, capped: false };
  }
  return { found, capped: true };
}

/**
 * Deals that have any of `inputProperties` filled in, or that the app has
 * synced before, for backfilling after a calculator is added or changed.
 * With skipTriage (for --force), deals whose lines already match are passed
 * on as well.
 */
export async function findDealsWithInputs({ hubspot, config, inputProperties, includeSynced = false, skipTriage = false, maxPages = Infinity, onDeal }) {
  const groups = inputProperties.map((name) => [{ propertyName: name, operator: 'HAS_PROPERTY' }]);
  if (includeSynced) groups.push([{ propertyName: DEAL.status, operator: 'HAS_PROPERTY' }]);
  const properties = triageProperties(config);
  let scanned = 0;
  let found = 0;
  const seen = new Set();
  // HubSpot allows 5 filter groups (ORed) per search, so search in batches.
  for (let i = 0; i < groups.length; i += 5) {
    const result = await searchByObjectId({
      hubspot,
      groups: groups.slice(i, i + 5),
      properties,
      maxPages,
      onDeal: async (deal) => {
        // A deal matching several batches is handled once.
        if (seen.has(String(deal.id))) return;
        seen.add(String(deal.id));
        scanned++;
        const t = triage(config, deal.properties ?? {});
        // Forced, deals whose lines already match are re-applied too; deals
        // syncWhen excludes, or that no calculator applies to, never are.
        if (t.action === 'skip' && !(skipTriage && t.reason === 'unchanged')) return;
        found++;
        await onDeal(String(deal.id));
      },
    });
    if (result.capped) return { scanned, found, capped: true };
  }
  return { scanned, found, capped: false };
}

// Search by object ID order, paging with "hs_object_id > last seen" so
// results can't shift between pages. Each group gets the ID condition.
async function searchByObjectId({ hubspot, groups, properties, maxPages, onDeal }) {
  let lastId = '0';
  for (let pages = 0; ; ) {
    const page = await hubspot.searchDeals({
      filterGroups: groups.map((filters) => ({ filters: [...filters, { propertyName: 'hs_object_id', operator: 'GT', value: lastId }] })),
      sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }],
      properties,
      limit: PAGE_SIZE,
    });
    pages++;
    for (const deal of page.results) await onDeal(deal);
    if (!page.results.length || !page.after) return { capped: false };
    if (pages >= maxPages) return { capped: true };
    lastId = String(page.results.at(-1).id);
  }
}

// HubSpot returns datetimes as ISO strings; accept epoch milliseconds too.
export function toMs(value) {
  if (value === null || value === undefined || value === '') return NaN;
  return /^\d+$/.test(String(value)) ? Number(value) : Date.parse(value);
}
