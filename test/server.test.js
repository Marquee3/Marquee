import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, dealIdsFromSyncRequest } from '../src/server.js';

async function withServer(options, fn) {
  const enqueued = [];
  const ran = [];
  const queue = {
    pending: 0,
    enqueue: (id) => enqueued.push(id),
    run: async (id, opts) => {
      ran.push({ id, ...opts });
      return { dealId: id, outcome: 'synced', message: 'ok', plan: {} };
    },
  };
  const server = createServer({ queue, ...options });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, enqueued, ran });
  } finally {
    server.close();
  }
}

const signed = (secret, url, body, timestamp = Date.now()) => ({
  'x-hubspot-request-timestamp': String(timestamp),
  'x-hubspot-signature-v3': createHmac('sha256', secret).update(`POST${url}${body}${timestamp}`).digest('base64'),
});

test('queues deals from a signed webhook', async () => {
  const publicUrl = 'https://line-items.example.com';
  await withServer({ clientSecret: 's3cret', publicUrl }, async ({ base, enqueued }) => {
    const body = JSON.stringify([
      { subscriptionType: 'deal.propertyChange', objectId: 42, propertyName: 'licence_seats' },
      { subscriptionType: 'deal.propertyChange', objectId: 42, propertyName: 'services_days' },
    ]);
    const res = await fetch(`${base}/webhooks/hubspot`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', ...signed('s3cret', `${publicUrl}/webhooks/hubspot`, body) },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { queued: 1 });
    assert.deepEqual(enqueued, ['42']);
  });
});

test('rejects unsigned or wrongly signed webhooks', async () => {
  await withServer({ clientSecret: 's3cret', publicUrl: 'https://h.example.com' }, async ({ base, enqueued }) => {
    const body = '[{"subscriptionType":"deal.propertyChange","objectId":1}]';
    const bad = await fetch(`${base}/webhooks/hubspot`, { method: 'POST', body, headers: signed('wrong', 'https://h.example.com/webhooks/hubspot', body) });
    assert.equal(bad.status, 401);
    const missing = await fetch(`${base}/webhooks/hubspot`, { method: 'POST', body });
    assert.equal(missing.status, 401);
    assert.deepEqual(enqueued, []);
  });
});

test('refuses webhooks when no client secret is configured, unless explicitly allowed', async () => {
  const body = '[{"subscriptionType":"deal.propertyChange","objectId":1}]';
  await withServer({}, async ({ base }) => {
    assert.equal((await fetch(`${base}/webhooks/hubspot`, { method: 'POST', body })).status, 500);
  });
  await withServer({ allowUnsigned: true }, async ({ base, enqueued }) => {
    assert.equal((await fetch(`${base}/webhooks/hubspot`, { method: 'POST', body })).status, 200);
    assert.deepEqual(enqueued, ['1']);
  });
});

test('/sync needs the API key and can wait for the result', async () => {
  await withServer({ syncApiKey: 'key-1' }, async ({ base, enqueued, ran }) => {
    const body = JSON.stringify({ dealId: '9' });
    assert.equal((await fetch(`${base}/sync`, { method: 'POST', body })).status, 401);
    assert.equal((await fetch(`${base}/sync`, { method: 'POST', body, headers: { authorization: 'Bearer nope' } })).status, 401);

    const queued = await fetch(`${base}/sync`, { method: 'POST', body, headers: { authorization: 'Bearer key-1' } });
    assert.equal(queued.status, 202);
    assert.deepEqual(enqueued, ['9']);

    const waited = await fetch(`${base}/sync?wait=true&force=true`, { method: 'POST', body, headers: { 'x-api-key': 'key-1' } });
    assert.deepEqual(await waited.json(), { results: [{ dealId: '9', outcome: 'synced', message: 'ok' }] });
    assert.deepEqual(ran, [{ id: '9', force: true }]);
  });
});

test('/sync is disabled without an API key', async () => {
  await withServer({}, async ({ base }) => {
    assert.equal((await fetch(`${base}/sync`, { method: 'POST', body: '{"dealId":"1"}' })).status, 404);
  });
});

test('bad JSON gets a 400', async () => {
  await withServer({ allowUnsigned: true }, async ({ base }) => {
    assert.equal((await fetch(`${base}/webhooks/hubspot`, { method: 'POST', body: 'not json' })).status, 400);
  });
});

test('reads deal IDs from the shapes a workflow webhook can send', () => {
  assert.deepEqual(dealIdsFromSyncRequest({ dealId: 5 }), ['5']);
  assert.deepEqual(dealIdsFromSyncRequest({ dealIds: ['1', '2', 'x'] }), ['1', '2']);
  assert.deepEqual(dealIdsFromSyncRequest({ objectId: 6 }), ['6']);
  assert.deepEqual(dealIdsFromSyncRequest({ properties: { hs_object_id: { value: '8' } } }), ['8']);
  assert.deepEqual(dealIdsFromSyncRequest({ hs_object_id: '9' }), ['9']);
  assert.deepEqual(dealIdsFromSyncRequest({}), []);
});
