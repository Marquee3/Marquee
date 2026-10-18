import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { dealIdsFromEvents, verifySignatureV3 } from '../src/webhooks.js';

const secret = 'client-secret';
const sign = (method, uri, body, timestamp) =>
  createHmac('sha256', secret).update(`${method}${uri}${body}${timestamp}`).digest('base64');

test('accepts a valid v3 signature', () => {
  const now = 1_760_000_000_000;
  const body = '[{"objectId":1}]';
  const url = 'https://line-items.example.com/webhooks/hubspot';
  const result = verifySignatureV3({
    clientSecret: secret,
    method: 'POST',
    url,
    rawBody: body,
    signature: sign('POST', url, body, now),
    timestamp: String(now),
    now: now + 1000,
  });
  assert.deepEqual(result, { ok: true });
});

test('decodes the characters HubSpot decodes before signing', () => {
  const now = Date.now();
  const signedUri = 'https://h.example.com/webhooks/hubspot?a=b:c';
  const result = verifySignatureV3({
    clientSecret: secret,
    method: 'POST',
    url: 'https://h.example.com/webhooks/hubspot?a=b%3Ac',
    rawBody: '',
    signature: sign('POST', signedUri, '', now),
    timestamp: String(now),
    now,
  });
  assert.equal(result.ok, true);
});

test('rejects bad, missing and stale signatures', () => {
  const now = Date.now();
  const base = { clientSecret: secret, method: 'POST', url: 'https://h.example.com/x', rawBody: '[]', timestamp: String(now), now };
  assert.equal(verifySignatureV3({ ...base, signature: sign('POST', 'https://h.example.com/x', '[] ', now) }).ok, false);
  assert.equal(verifySignatureV3({ ...base, signature: 'bm90IGl0' }).ok, false);
  assert.equal(verifySignatureV3({ ...base, signature: undefined }).ok, false);
  const old = now - 6 * 60_000;
  const stale = verifySignatureV3({ ...base, timestamp: String(old), signature: sign('POST', base.url, '[]', old) });
  assert.match(stale.reason, /5 minutes/);
});

test('extracts deal IDs from classic and generic subscription events', () => {
  const ids = dealIdsFromEvents([
    { subscriptionType: 'deal.propertyChange', objectId: 11, propertyName: 'licence_seats', portalId: 5 },
    { subscriptionType: 'deal.propertyChange', objectId: 11, propertyName: 'services_days', portalId: 5 },
    { subscriptionType: 'object.propertyChange', objectTypeId: '0-3', objectId: 12, portalId: 5 },
    { subscriptionType: 'object.propertyChange', objectTypeId: '0-1', objectId: 13, portalId: 5 },
    { subscriptionType: 'deal.deletion', objectId: 14, portalId: 5 },
    { subscriptionType: 'deal.creation', objectId: 15, portalId: 6 },
    { subscriptionType: 'contact.propertyChange', objectId: 16, portalId: 5 },
  ]);
  assert.deepEqual(ids, ['11', '12', '15']);
});

test('ignores events from other HubSpot accounts when a portal ID is set', () => {
  const ids = dealIdsFromEvents(
    [
      { subscriptionType: 'deal.propertyChange', objectId: 1, portalId: 5 },
      { subscriptionType: 'deal.propertyChange', objectId: 2, portalId: 6 },
    ],
    { portalId: '5' },
  );
  assert.deepEqual(ids, ['1']);
});
