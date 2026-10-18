// Cloudflare Workers version of the service. Same sync logic as the Node
// server; different plumbing:
//
//   fetch      HubSpot webhooks and POST /sync -> messages on a Cloudflare Queue
//   scheduled  cron trigger (every minute) -> finds changed deals -> queue
//   queue      one message = one deal sync; Cloudflare retries failed ones
//
// The queue consumer runs one message at a time (max_concurrency 1 in
// wrangler.jsonc), so syncs of the same deal never overlap. Calculator files
// are validated and bundled in at deploy time (scripts/bundle-config.js).

import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { parseConfig } from './config.js';
import { HubSpotClient } from './hubspot.js';
import { logger } from './logger.js';
import { ProductResolver } from './products.js';
import { findChangedDeals, findErrorDeals } from './sweep.js';
import { LineItemSync } from './sync.js';
import { dealIdsFromEvents, dealIdsFromSyncRequest, verifySignatureV3 } from './webhooks.js';

const DEFAULTS = {
  // Each cron run looks back this far. Being stateless, it must cover the
  // gap between runs plus HubSpot's search index lag; deals already synced
  // are skipped without further API calls. Kept short because a deal still
  // waiting in the queue is sent again by each run whose window it's in.
  windowMinutes: 3,
  // Every 30 minutes, look back further, to catch anything missed while
  // cron runs were delayed or failing. 65 minutes means every moment is
  // covered by two catch-ups, so one failed catch-up leaves no gap.
  catchUpMinutes: 65,
  catchUpEveryMinutes: 30,
  errorRecheckMinutes: 15,
  debounceSeconds: 5,
  retryDelaySeconds: 60,
  // Search pages per cron run (200 deals each). Deals are queued page by
  // page, so a run cut short still keeps what it found.
  maxPagesPerRun: 10,
};
const QUEUE_BATCH = 100;
const WAIT_LIMIT = 3;

export function createWorker(rawConfig, { createClient = (env) => defaultClient(env) } = {}) {
  const config = parseConfig(rawConfig);
  let app = null;

  // One HubSpot client, product cache and sync engine per isolate.
  const appFor = (env) => {
    if (!app || app.env !== env) {
      const hubspot = createClient(env);
      app = { env, hubspot, sync: new LineItemSync({ hubspot, config, products: new ProductResolver(hubspot), logger }) };
    }
    return app;
  };

  const settings = (env) => ({
    windowMinutes: positive(env.SYNC_POLL_WINDOW_MINUTES, DEFAULTS.windowMinutes),
    catchUpMinutes: positive(env.SYNC_CATCH_UP_MINUTES, DEFAULTS.catchUpMinutes),
    errorRecheckMinutes: positive(env.SYNC_ERROR_RECHECK_MINUTES, DEFAULTS.errorRecheckMinutes),
    debounceSeconds: positive(env.SYNC_DEBOUNCE_SECONDS, DEFAULTS.debounceSeconds, { allowZero: true }),
    maxPagesPerRun: positive(env.SYNC_MAX_PAGES_PER_RUN, DEFAULTS.maxPagesPerRun),
  });

  async function enqueue(env, dealIds, { delaySeconds = 0, force = false } = {}) {
    const unique = [...new Set(dealIds.map(String))];
    for (let i = 0; i < unique.length; i += QUEUE_BATCH) {
      await env.SYNC_QUEUE.sendBatch(
        unique.slice(i, i + QUEUE_BATCH).map((dealId) => ({ body: { dealId, ...(force ? { force } : {}) }, delaySeconds })),
      );
    }
    return unique.length;
  }

  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      try {
        if (request.method === 'GET' && url.pathname === '/health') {
          return json(200, { ok: true, calculators: config.calculators.map((c) => c.id) });
        }

        if (request.method === 'POST' && url.pathname === '/webhooks/hubspot') {
          const rawBody = await request.text();
          if (env.HUBSPOT_CLIENT_SECRET) {
            const check = verifySignatureV3({
              clientSecret: env.HUBSPOT_CLIENT_SECRET,
              method: request.method,
              url: request.url,
              rawBody,
              signature: request.headers.get('x-hubspot-signature-v3'),
              timestamp: request.headers.get('x-hubspot-request-timestamp'),
            });
            if (!check.ok) {
              logger.warn('rejected webhook', { reason: check.reason });
              return json(401, { error: 'invalid signature' });
            }
          } else if (env.ALLOW_UNSIGNED_WEBHOOKS !== 'true') {
            return json(500, { error: 'HUBSPOT_CLIENT_SECRET is not configured' });
          }
          const payload = parseJson(rawBody);
          if (payload === undefined) return json(400, { error: 'body must be JSON' });
          const dealIds = dealIdsFromEvents(payload, { portalId: env.HUBSPOT_PORTAL_ID });
          const queued = await enqueue(env, dealIds, { delaySeconds: settings(env).debounceSeconds });
          logger.info('webhook received', { dealIds });
          return json(200, { queued });
        }

        if (request.method === 'POST' && url.pathname === '/sync') {
          if (!env.SYNC_API_KEY) return json(404, { error: 'not found' });
          if (!apiKeyMatches(request, env.SYNC_API_KEY)) return json(401, { error: 'invalid API key' });
          const body = parseJson(await request.text());
          const dealIds = dealIdsFromSyncRequest(body);
          if (!dealIds.length) return json(400, { error: 'send {"dealId": "..."} or a HubSpot workflow webhook payload' });
          const force = url.searchParams.get('force') === 'true';
          if (url.searchParams.get('wait') === 'true') {
            // A few deals at most: each sync makes several HubSpot calls, and a
            // request has a limited number of outbound calls.
            const { sync } = appFor(env);
            const results = [];
            for (const id of dealIds.slice(0, WAIT_LIMIT)) {
              const { dealId, outcome, message, retry } = await sync.syncDeal(id, { force });
              if (retry) await enqueue(env, [dealId], { delaySeconds: DEFAULTS.retryDelaySeconds, force });
              results.push({ dealId, outcome, message, ...(retry ? { retryQueued: true } : {}) });
            }
            const rest = dealIds.slice(WAIT_LIMIT);
            if (rest.length) await enqueue(env, rest, { force });
            return json(200, { results, ...(rest.length ? { queued: rest.length } : {}) });
          }
          return json(202, { queued: await enqueue(env, dealIds, { force }) });
        }

        return json(404, { error: 'not found' });
      } catch (err) {
        logger.error('request failed', { path: url.pathname, error: err?.stack ?? String(err) });
        return json(500, { error: 'internal error' });
      }
    },

    async scheduled(controller, env) {
      const now = controller.scheduledTime ?? Date.now();
      const s = settings(env);
      const minute = Math.floor(now / 60_000);
      const catchUp = minute % DEFAULTS.catchUpEveryMinutes === 0;
      const lookback = catchUp ? s.catchUpMinutes : s.windowMinutes;
      const { hubspot } = appFor(env);

      // Queue deals as they're found, so a run that's cut short (CPU limit,
      // a HubSpot error on a later page) keeps what it already found.
      let pending = [];
      let queued = 0;
      const flush = async () => {
        if (!pending.length) return;
        const batch = pending;
        pending = [];
        queued += await enqueue(env, batch);
      };
      const found = async (id) => {
        pending.push(id);
        if (pending.length >= QUEUE_BATCH) await flush();
      };

      let scanned = 0;
      try {
        const result = await findChangedDeals({
          hubspot,
          config,
          sinceMs: now - lookback * 60_000,
          maxPages: s.maxPagesPerRun,
          quietMs: s.debounceSeconds * 1000,
          now,
          onDeal: found,
        });
        scanned = result.scanned;
        if (result.capped) logger.warn('more changed deals than one cron run covers; later runs and catch-ups continue', { scanned });

        // On its own minutes, not with a catch-up, to keep each run small.
        if (minute % s.errorRecheckMinutes === s.errorRecheckMinutes - 1) {
          await findErrorDeals({ hubspot, config, onDeal: found });
        }
      } finally {
        await flush();
      }
      if (queued) logger.info('deal poll', { scanned, queued, lookbackMinutes: lookback });
    },

    async queue(batch, env) {
      const { sync } = appFor(env);
      for (const message of batch.messages) {
        const { dealId, force } = message.body ?? {};
        if (!dealId) {
          message.ack();
          continue;
        }
        try {
          const result = await sync.syncDeal(dealId, { force: Boolean(force) });
          if (result.retry) message.retry({ delaySeconds: DEFAULTS.retryDelaySeconds });
          else message.ack();
        } catch (err) {
          logger.error('deal sync crashed', { dealId, error: err?.stack ?? String(err) });
          message.retry({ delaySeconds: DEFAULTS.retryDelaySeconds });
        }
      }
    },
  };
}

function defaultClient(env) {
  return new HubSpotClient({
    accessToken: env.HUBSPOT_ACCESS_TOKEN,
    ...(env.HUBSPOT_API_VERSION ? { apiVersion: env.HUBSPOT_API_VERSION } : {}),
    ...(env.HUBSPOT_API_BASE_URL ? { baseUrl: env.HUBSPOT_API_BASE_URL } : {}),
    // Fewer in-request retries than on Node: each retry is an outbound
    // request, and the queue retries the whole sync anyway.
    maxRetries: 2,
  });
}

function apiKeyMatches(request, expected) {
  const header = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? request.headers.get('x-api-key') ?? '';
  const given = Buffer.from(String(header));
  const wanted = Buffer.from(String(expected));
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function positive(raw, fallback, { allowZero = false } = {}) {
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && (value > 0 || (allowZero && value === 0)) ? value : fallback;
}
