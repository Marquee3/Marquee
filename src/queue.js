// Debounces and serializes syncs per deal.
//
// A calculator usually writes several properties at once, and HubSpot sends
// one webhook event per property. Waiting for a quiet period turns that
// burst into a single sync. Syncs of the same deal never overlap, so two
// events can't both see "no line items yet" and both create them.

export class DealSyncQueue {
  #worker;
  #debounceMs;
  #concurrency;
  #logger;
  #timers = new Map();
  #queued = new Map(); // dealId -> promise of a run that hasn't started yet
  #chains = new Map(); // dealId -> promise that settles when its last run ends
  #active = 0;
  #waiting = [];

  constructor(worker, { debounceMs = 5000, concurrency = 2, logger } = {}) {
    this.#worker = worker;
    this.#debounceMs = debounceMs;
    this.#concurrency = concurrency;
    this.#logger = logger;
  }

  /** Sync the deal once things go quiet for it. */
  enqueue(dealId) {
    dealId = String(dealId);
    clearTimeout(this.#timers.get(dealId));
    this.#timers.set(
      dealId,
      setTimeout(() => {
        this.#timers.delete(dealId);
        this.#schedule(dealId, {}, { coalesce: true }).catch(() => {});
      }, this.#debounceMs),
    );
  }

  /** Sync the deal now (after any sync of it already running) and return the result. */
  run(dealId, options = {}) {
    return this.#schedule(String(dealId), options, { coalesce: false });
  }

  /** Run any debounced syncs immediately and wait for everything to finish. */
  async flush() {
    for (const [dealId, timer] of this.#timers) {
      clearTimeout(timer);
      this.#timers.delete(dealId);
      this.#schedule(dealId, {}, { coalesce: true }).catch(() => {});
    }
    await Promise.all(this.#chains.values());
  }

  get pending() {
    return this.#timers.size + this.#chains.size;
  }

  #schedule(dealId, options, { coalesce }) {
    // A run that is queued but hasn't started will read the deal fresh when
    // it does, so later events can share it.
    if (coalesce && this.#queued.has(dealId)) return this.#queued.get(dealId);

    const previous = this.#chains.get(dealId) ?? Promise.resolve();
    const run = previous.then(() => {
      if (this.#queued.get(dealId) === run) this.#queued.delete(dealId);
      return this.#withSlot(() => this.#worker(dealId, options));
    });
    if (coalesce) this.#queued.set(dealId, run);

    const settled = run.then(
      () => {},
      (err) => this.#logger?.error('deal sync crashed', { dealId, error: err?.stack ?? String(err) }),
    );
    this.#chains.set(dealId, settled);
    settled.then(() => {
      if (this.#chains.get(dealId) === settled) this.#chains.delete(dealId);
    });
    return run;
  }

  async #withSlot(fn) {
    while (this.#active >= this.#concurrency) await new Promise((resolve) => this.#waiting.push(resolve));
    this.#active++;
    try {
      return await fn();
    } finally {
      this.#active--;
      this.#waiting.shift()?.();
    }
  }
}
