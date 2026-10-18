// Finds recently changed deals by polling HubSpot's search API, so that
// any calculator, including one added later, is picked up without
// subscribing to its properties in the HubSpot app's webhook settings.
// It also catches anything webhooks miss, such as changes made while the
// service was down, or calculation properties that don't send webhooks.

import { DEAL } from './properties.js';

// HubSpot's search API returns at most 10,000 results per query.
const MAX_PAGES = 50;
const PAGE_SIZE = 200;

export class DealPoller {
  #hubspot;
  #queue;
  #config;
  #intervalMs;
  #lookbackMs;
  #overlapMs;
  #logger;
  #now;
  #since = null;
  #seen = new Map(); // dealId -> hs_lastmodifieddate already queued
  #timer = null;
  #stopped = false;

  constructor({ hubspot, queue, config, intervalMs = 60_000, lookbackMs = 60 * 60_000, overlapMs = 2 * 60_000, logger, now = Date.now }) {
    this.#hubspot = hubspot;
    this.#queue = queue;
    this.#config = config;
    this.#intervalMs = intervalMs;
    this.#lookbackMs = lookbackMs;
    // HubSpot's search index trails writes slightly, so each sweep looks a
    // little further back than where the last one ended.
    this.#overlapMs = overlapMs;
    this.#logger = logger;
    this.#now = now;
  }

  start() {
    this.#stopped = false;
    const loop = async () => {
      try {
        await this.sweep();
      } catch (err) {
        this.#logger?.error('deal poll failed; will retry', { error: err?.message ?? String(err) });
      }
      if (!this.#stopped) this.#timer = setTimeout(loop, this.#intervalMs);
    };
    this.#timer = setTimeout(loop, 0);
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
  }

  /** Queue a sync for every relevant deal modified since the last sweep. */
  async sweep() {
    const startedAt = this.#now();
    this.#since ??= startedAt - this.#lookbackMs;
    const properties = [...new Set([...this.#config.inputProperties, DEAL.status, DEAL.fingerprint, 'hs_lastmodifieddate'])];

    let after;
    let pages = 0;
    let capped = false;
    let latest = null;
    let scanned = 0;
    let queued = 0;
    do {
      const page = await this.#hubspot.searchDealsModifiedSince(this.#since, properties, { after, limit: PAGE_SIZE });
      for (const deal of page.results) {
        scanned++;
        const modified = deal.properties?.hs_lastmodifieddate ?? null;
        const modifiedMs = toMs(modified);
        if (Number.isFinite(modifiedMs)) latest = Math.max(latest ?? modifiedMs, modifiedMs);
        // Seen in an earlier sweep's overlap with no change since.
        if (modified && this.#seen.get(String(deal.id)) === modified) continue;
        this.#seen.set(String(deal.id), modified);
        if (!isRelevant(deal.properties ?? {}, this.#config)) continue;
        this.#queue.enqueue(String(deal.id));
        queued++;
      }
      after = page.after;
      if (after && ++pages >= MAX_PAGES) {
        capped = true;
        this.#logger?.warn('more deals changed than one search can return; continuing next sweep', { scanned });
        break;
      }
    } while (after);

    // Move the window forward. Results are oldest first, so when capped,
    // the next sweep carries on from the last deal reached.
    const end = latest === null ? startedAt : Math.min(latest, startedAt);
    this.#since = Math.max(this.#since, capped ? end : end - this.#overlapMs);
    for (const [id, modified] of this.#seen) {
      if (!(toMs(modified) >= this.#since)) this.#seen.delete(id);
    }

    if (queued) this.#logger?.info('deal poll', { scanned, queued });
    return { scanned, queued, since: this.#since };
  }
}

// Worth a sync: a calculator input is filled in, or the app has synced the
// deal before (so it may need lines removed). Everything else is skipped
// without another API call.
function isRelevant(properties, config) {
  if (properties[DEAL.status] || properties[DEAL.fingerprint]) return true;
  return config.inputProperties.some((name) => {
    const value = properties[name];
    return value !== null && value !== undefined && value !== '';
  });
}

// HubSpot returns datetimes as ISO strings; accept epoch milliseconds too.
function toMs(value) {
  if (value === null || value === undefined || value === '') return NaN;
  return /^\d+$/.test(String(value)) ? Number(value) : Date.parse(value);
}
