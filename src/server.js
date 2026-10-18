import { createServer as createHttpServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { logger } from './logger.js';
import { DealPoller } from './poller.js';
import { DealSyncQueue } from './queue.js';
import { createApp, loadEnv, readServerSettings } from './runtime.js';
import { dealIdsFromEvents, verifySignatureV3 } from './webhooks.js';

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * HTTP endpoints:
 *   GET  /health            liveness check
 *   POST /webhooks/hubspot  HubSpot webhook subscriptions (signed with the app's client secret)
 *   POST /sync              sync one or more deals on demand, e.g. from a workflow
 *                           "Send a webhook" action. Requires SYNC_API_KEY.
 */
export function createServer({ queue, clientSecret, publicUrl, portalId, syncApiKey, allowUnsigned = false, logger }) {
  return createHttpServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    try {
      if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true, pending: queue.pending });

      if (req.method === 'POST' && path === '/webhooks/hubspot') {
        const rawBody = await readBody(req);
        if (clientSecret) {
          const check = verifySignatureV3({
            clientSecret,
            method: req.method,
            url: requestUrl(req, publicUrl),
            rawBody,
            signature: req.headers['x-hubspot-signature-v3'],
            timestamp: req.headers['x-hubspot-request-timestamp'],
          });
          if (!check.ok) {
            logger?.warn('rejected webhook', { reason: check.reason });
            return send(res, 401, { error: 'invalid signature' });
          }
        } else if (!allowUnsigned) {
          return send(res, 500, { error: 'HUBSPOT_CLIENT_SECRET is not configured' });
        }
        const dealIds = dealIdsFromEvents(parseJson(rawBody), { portalId });
        dealIds.forEach((id) => queue.enqueue(id));
        logger?.info('webhook received', { dealIds });
        // Answer straight away: HubSpot retries deliveries that are slow to respond.
        return send(res, 200, { queued: dealIds.length });
      }

      if (req.method === 'POST' && path === '/sync') {
        if (!syncApiKey) return send(res, 404, { error: 'not found' });
        if (!apiKeyMatches(req, syncApiKey)) return send(res, 401, { error: 'invalid API key' });
        const body = parseJson(await readBody(req));
        const dealIds = dealIdsFromSyncRequest(body);
        if (!dealIds.length) return send(res, 400, { error: 'send {"dealId": "..."} or a HubSpot workflow webhook payload' });
        const query = new URL(req.url, 'http://localhost').searchParams;
        const force = query.get('force') === 'true';
        if (query.get('wait') === 'true') {
          const results = await Promise.all(dealIds.map((id) => queue.run(id, { force })));
          return send(res, 200, { results: results.map(({ dealId, outcome, message }) => ({ dealId, outcome, message })) });
        }
        // force=true skips the debounce so the forced run isn't merged away.
        dealIds.forEach((id) => (force ? queue.run(id, { force }).catch(() => {}) : queue.enqueue(id)));
        return send(res, 202, { queued: dealIds.length });
      }

      return send(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof RequestError) return send(res, err.status, { error: err.message });
      logger?.error('request failed', { path, error: err?.stack ?? String(err) });
      return send(res, 500, { error: 'internal error' });
    }
  });
}

/** Deal IDs from a /sync body: {"dealId"}, {"dealIds": []} or a workflow webhook payload. */
export function dealIdsFromSyncRequest(body) {
  if (!body || typeof body !== 'object') return [];
  const candidates = Array.isArray(body.dealIds)
    ? body.dealIds
    : [body.dealId ?? body.objectId ?? body.hs_object_id ?? body.properties?.hs_object_id?.value ?? body.properties?.hs_object_id];
  return candidates.filter((id) => /^\d+$/.test(String(id ?? ''))).map(String);
}

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new RequestError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestError(400, 'body must be JSON');
  }
}

// The URL HubSpot signed. Behind a proxy or load balancer the Host header
// may not match the public hostname, so PUBLIC_URL can pin it.
function requestUrl(req, publicUrl) {
  if (publicUrl) return `${publicUrl.replace(/\/+$/, '')}${req.url}`;
  const proto = String(req.headers['x-forwarded-proto'] ?? 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host).split(',')[0].trim();
  return `${proto}://${host}${req.url}`;
}

function apiKeyMatches(req, expected) {
  const header = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? req.headers['x-api-key'] ?? '';
  const given = Buffer.from(String(header));
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function main() {
  loadEnv();
  const { sync, config, hubspot } = await createApp();
  const settings = readServerSettings();
  const queue = new DealSyncQueue((dealId, options) => sync.syncDeal(dealId, options), {
    debounceMs: settings.debounceMs,
    concurrency: settings.concurrency,
    logger,
  });
  const poller =
    settings.pollSeconds > 0
      ? new DealPoller({
          hubspot,
          queue,
          config,
          intervalMs: settings.pollSeconds * 1000,
          lookbackMs: settings.pollLookbackMinutes * 60_000,
          logger,
        })
      : null;
  const server = createServer({ queue, logger, ...settings });
  server.listen(settings.port, () => {
    logger.info('listening', {
      port: settings.port,
      calculators: config.calculators.map((c) => c.id),
      pollSeconds: poller ? settings.pollSeconds : 'off',
      signedWebhooks: Boolean(settings.clientSecret),
      syncEndpoint: Boolean(settings.syncApiKey),
    });
    if (!config.calculators.length) {
      logger.warn('no calculators configured yet; add a file to config/calculators/ (npm run new-calculator)');
    }
    poller?.start();
  });

  const shutdown = () => {
    logger.info('shutting down; finishing queued syncs');
    poller?.stop();
    server.close();
    queue.flush().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
