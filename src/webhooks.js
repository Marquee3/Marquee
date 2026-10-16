import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_TIMESTAMP_AGE_MS = 5 * 60_000;
const DEAL_OBJECT_TYPE_ID = '0-3';

// Characters HubSpot decodes in the request URI before signing (v3).
const URI_DECODE = {
  '%3A': ':', '%2F': '/', '%3F': '?', '%40': '@', '%21': '!', '%24': '$',
  '%27': "'", '%28': '(', '%29': ')', '%2A': '*', '%2C': ',', '%3B': ';',
};

/**
 * Check HubSpot's v3 request signature: base64(HMAC-SHA256(client secret,
 * method + uri + body + timestamp)), and reject requests older than 5 minutes.
 * `url` must be the full URL HubSpot called (https://your-host/path).
 */
export function verifySignatureV3({ clientSecret, method, url, rawBody, signature, timestamp, now = Date.now() }) {
  if (!signature || !timestamp) return { ok: false, reason: 'missing signature headers' };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_TIMESTAMP_AGE_MS) {
    return { ok: false, reason: 'timestamp is missing or more than 5 minutes old' };
  }
  const uri = url.replace(/%(3A|2F|3F|40|21|24|27|28|29|2A|2C|3B)/gi, (match) => URI_DECODE[match.toUpperCase()]);
  const expected = createHmac('sha256', clientSecret).update(`${method}${uri}${rawBody}${timestamp}`).digest();
  const given = Buffer.from(String(signature), 'base64');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'signature does not match' };
  }
  return { ok: true };
}

/**
 * Deal IDs to sync from a HubSpot webhook payload (an array of events).
 * Handles classic subscriptions ("deal.propertyChange") and the newer
 * generic ones ("object.propertyChange" with objectTypeId 0-3).
 */
export function dealIdsFromEvents(payload, { portalId } = {}) {
  const events = Array.isArray(payload) ? payload : [payload];
  const ids = new Set();
  for (const event of events) {
    if (!event || typeof event !== 'object' || event.objectId === undefined) continue;
    if (portalId && String(event.portalId) !== String(portalId)) continue;
    const [scope, action] = String(event.subscriptionType ?? '').split('.');
    const isDeal = scope === 'deal' || (scope === 'object' && String(event.objectTypeId) === DEAL_OBJECT_TYPE_ID);
    if (isDeal && ['propertyChange', 'creation', 'restore'].includes(action)) ids.add(String(event.objectId));
  }
  return [...ids];
}
