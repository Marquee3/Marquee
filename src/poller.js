// Node version of the change poller (the Cloudflare Worker uses a cron
// trigger instead; see src/worker.js). Every interval it searches HubSpot for
// deals modified since the last sweep and queues those that need a sync, so
// any calculator, including one added later, is picked up without webhook
// subscriptions. It also catches what webhooks miss, such as changes made
// while the service was down.

import { findChangedDeals, findErrorDeals, toMs } from './sweep.js';

const MAX_RETRIES = 5;

export class DealPoller {
  #hubspot;
  #queue;
  #config;
  #intervalMs;
  #lookbackMs;
  #overlapMs;
  #quietMs;
  #maxPages;
  #errorRecheckEvery;
  #logger;
  #now;
  #since = null;
  #seen = new Map(); // dealId -> hs_lastmodifieddate already queued
  #retries = new Map(); // dealId -> attempts so far
  #sweeps = 0;
  #timer = null;
  #stopped = false;

  constructor({
    hubspot,
    queue,
    config,
    intervalMs = 60_000,
    lookbackMs = 60 * 60_000,
    overlapMs = 2 * 60_000,
    quietMs = 5_000,
    errorRecheckMinutes = 15,
    maxPages = 50,
    logger,
    now = Date.now,
  }) {
    this.#hubspot = hubspot;
    this.#queue = queue;
    this.#config = config;
    this.#intervalMs = intervalMs;
    this.#lookbackMs = lookbackMs;
    // HubSpot's search index trails writes slightly, so each sweep looks a
    // little further back than where the last one ended.
    this.#overlapMs = overlapMs;
    this.#quietMs = quietMs;
    this.#maxPages = maxPages;
    this.#errorRecheckEvery = Math.max(1, Math.round((errorRecheckMinutes * 60_000) / intervalMs));
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

  /**
   * Ask for a deal to be synced again on the next sweep, after a sync that
   * failed for a reason that may pass (see `retry` in LineItemSync results).
   */
  retryLater(dealId) {
    const attempts = (this.#retries.get(String(dealId)) ?? 0) + 1;
    if (attempts > MAX_RETRIES) {
      this.#retries.delete(String(dealId));
      this.#logger?.error('giving up retrying deal sync', { dealId, attempts: MAX_RETRIES });
      return;
    }
    this.#retries.set(String(dealId), attempts);
  }

  /** Queue a sync for every deal changed since the last sweep that needs one. */
  async sweep() {
    const startedAt = this.#now();
    this.#since ??= startedAt - this.#lookbackMs;
    this.#sweeps++;

    // Retries first, so a failed sweep doesn't drop them.
    const retrying = [...this.#retries.keys()];
    for (const id of retrying) {
      this.#seen.delete(id);
      this.#queue.enqueue(id);
    }

    const result = await findChangedDeals({
      hubspot: this.#hubspot,
      config: this.#config,
      sinceMs: this.#since,
      quietMs: this.#quietMs,
      maxPages: this.#maxPages,
      now: startedAt,
      seen: this.#seen,
      onDeal: (id) => this.#queue.enqueue(id),
    });

    // Move the window forward using HubSpot's own timestamps, never the
    // server clock, so clock drift can't skip changes. When the page budget
    // ran out, carry on from exactly where it stopped.
    const next = result.capped ? result.cursor : result.cursor - this.#overlapMs;
    this.#since = Math.max(this.#since, next);
    if (result.capped) this.#logger?.warn('many deals changed; continuing next sweep', { scanned: result.scanned });
    for (const [id, modified] of this.#seen) {
      if (!(toMs(modified) >= this.#since)) this.#seen.delete(id);
    }

    let errorsRequeued = 0;
    if (this.#sweeps % this.#errorRecheckEvery === 0) {
      await findErrorDeals({
        hubspot: this.#hubspot,
        onDeal: (id) => {
          errorsRequeued++;
          this.#queue.enqueue(id);
        },
      });
    }

    const queued = result.found + retrying.length + errorsRequeued;
    if (queued) this.#logger?.info('deal poll', { scanned: result.scanned, queued, retried: retrying.length || undefined, errorsRequeued: errorsRequeued || undefined });
    return { scanned: result.scanned, queued, since: this.#since };
  }

  /** Record a sync outcome: clears or schedules retries. */
  handleResult(dealId, result) {
    if (result?.retry) this.retryLater(dealId);
    else this.#retries.delete(String(dealId));
  }
}
