import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createWorker } from '../src/worker.js';
import { FakeHubSpot } from './fake-hubspot.js';

const RAW_CONFIG = {
  calculators: [
    { id: 'lic', name: 'Licence calculator', appliesWhen: 'seats > 0', lineItems: [{ key: 'seats', product: { sku: 'SEAT' }, quantity: 'seats' }] },
  ],
};
const T0 = Date.parse('2026-10-18T09:07:30Z'); // not on the hour (that run looks back further)

function setup({ env: extra = {} } = {}) {
  let clock = T0;
  const hubspot = new FakeHubSpot({ products: [{ id: '1', hs_sku: 'SEAT', name: 'Seat', price: '10' }], now: () => clock });
  const sent = [];
  const env = {
    HUBSPOT_ACCESS_TOKEN: 'pat-test',
    SYNC_QUEUE: { sendBatch: async (messages) => sent.push(...messages) },
    ...extra,
  };
  const worker = createWorker(RAW_CONFIG, { createClient: () => hubspot });
  return { hubspot, worker, env, sent, tick: (ms) => (clock += ms), now: () => clock };
}

function message(body) {
  const m = { body, acked: false, retried: null, ack() { m.acked = true; }, retry(options) { m.retried = options ?? {}; } };
  return m;
}

const sign = (secret, url, body, timestamp) =>
  createHmac('sha256', secret).update(`POST${url}${body}${timestamp}`).digest('base64');

test('health check', async () => {
  const { worker, env } = setup();
  const res = await worker.fetch(new Request('https://w.example.com/health'), env);
  assert.deepEqual(await res.json(), { ok: true, calculators: ['lic'] });
});

test('signed webhooks put deals on the queue, delayed to let changes settle', async () => {
  const { worker, env, sent } = setup({ env: { HUBSPOT_CLIENT_SECRET: 's3cret' } });
  const url = 'https://w.example.com/webhooks/hubspot';
  const body = JSON.stringify([
    { subscriptionType: 'object.propertyChange', objectTypeId: '0-3', objectId: 7, propertyName: 'seats' },
    { subscriptionType: 'deal.propertyChange', objectId: 7, propertyName: 'rate' },
  ]);
  const ts = String(Date.now());
  const res = await worker.fetch(
    new Request(url, { method: 'POST', body, headers: { 'x-hubspot-request-timestamp': ts, 'x-hubspot-signature-v3': sign('s3cret', url, body, ts) } }),
    env,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(sent, [{ body: { dealId: '7' }, delaySeconds: 5 }]);

  const forged = await worker.fetch(new Request(url, { method: 'POST', body, headers: { 'x-hubspot-request-timestamp': ts, 'x-hubspot-signature-v3': 'Zm9v' } }), env);
  assert.equal(forged.status, 401);
  assert.equal(sent.length, 1);
});

test('webhooks are refused when no client secret is set', async () => {
  const { worker, env } = setup();
  const res = await worker.fetch(new Request('https://w.example.com/webhooks/hubspot', { method: 'POST', body: '[]' }), env);
  assert.equal(res.status, 500);
});

test('/sync needs the API key; wait=true syncs immediately', async () => {
  const { worker, env, sent, hubspot } = setup({ env: { SYNC_API_KEY: 'k' } });
  hubspot.deals.set('7', { id: '7', properties: { seats: '3', hs_lastmodifieddate: new Date(T0).toISOString() } });
  const post = (path, headers = {}) => worker.fetch(new Request(`https://w.example.com${path}`, { method: 'POST', body: '{"dealId":"7"}', headers }), env);
  assert.equal((await post('/sync')).status, 401);
  assert.equal((await post('/sync', { authorization: 'Bearer k' })).status, 202);
  assert.deepEqual(sent, [{ body: { dealId: '7' }, delaySeconds: 0 }]);
  const waited = await (await post('/sync?wait=true', { 'x-api-key': 'k' })).json();
  assert.equal(waited.results[0].outcome, 'synced');
  assert.equal(hubspot.dealLineItems('7').length, 1);
});

test('cron run queues changed deals that need a sync, and skips the rest', async () => {
  const { worker, env, sent, hubspot, now, tick } = setup();
  const minutesAgo = (m) => new Date(now() - m * 60_000).toISOString();
  hubspot.deals.set('1', { id: '1', properties: { seats: '3', hs_lastmodifieddate: minutesAgo(2) } });
  hubspot.deals.set('2', { id: '2', properties: { other: 'x', hs_lastmodifieddate: minutesAgo(1) } });
  hubspot.deals.set('3', { id: '3', properties: { seats: '3', hs_lastmodifieddate: minutesAgo(20) } });

  await worker.scheduled({ scheduledTime: now() }, env);
  assert.deepEqual(sent.map((m) => m.body.dealId), ['1'], 'deal 2 uses no calculator; deal 3 is outside the 5 minute window');

  // The queue consumer syncs it; the next cron run sees the status write but
  // knows there's nothing to do, so queues nothing.
  const m = message({ dealId: '1' });
  await worker.queue({ messages: [m] }, env);
  assert.equal(m.acked, true);
  assert.equal(hubspot.dealLineItems('1').length, 1);
  sent.length = 0;
  tick(60_000);
  await worker.scheduled({ scheduledTime: now() }, env);
  assert.deepEqual(sent, []);
});

test('cron run picks a deal up when a syncWhen gate opens, not before', async () => {
  let clock = T0;
  const hubspot = new FakeHubSpot({ products: [{ id: '1', hs_sku: 'SEAT', name: 'Seat', price: '10' }], now: () => clock });
  const sent = [];
  const env = { HUBSPOT_ACCESS_TOKEN: 'pat-test', SYNC_QUEUE: { sendBatch: async (messages) => sent.push(...messages) } };
  const worker = createWorker({ ...RAW_CONFIG, settings: { syncWhen: 'pricing_status == "add_line_items"' } }, { createClient: () => hubspot });
  hubspot.deals.set('1', { id: '1', properties: { seats: '3', pricing_status: 'in_progress', hs_lastmodifieddate: new Date(clock - 120_000).toISOString() } });

  await worker.scheduled({ scheduledTime: clock }, env);
  assert.deepEqual(sent, []);

  hubspot.editDeal('1', { pricing_status: 'add_line_items' });
  clock += 60_000;
  await worker.scheduled({ scheduledTime: clock }, env);
  assert.deepEqual(sent.map((m) => m.body.dealId), ['1']);
});

test('catch-up runs look further back; deals needing attention are re-checked on their own minutes', async () => {
  const { worker, env, sent, hubspot } = setup();
  const top = Date.parse('2026-10-18T10:00:00Z');
  hubspot.deals.set('1', { id: '1', properties: { seats: '3', hs_lastmodifieddate: new Date(top - 30 * 60_000).toISOString() } });
  hubspot.deals.set('2', { id: '2', properties: { seats: '3', calc_line_items_status: 'error', hs_lastmodifieddate: new Date(top - 300 * 60_000).toISOString() } });
  const run = async (minutesPastTen) => {
    sent.length = 0;
    await worker.scheduled({ scheduledTime: top + minutesPastTen * 60_000 }, env);
    return sent.map((m) => m.body.dealId).sort();
  };
  assert.deepEqual(await run(0), ['1'], ':00 is a catch-up (65 minutes back)');
  assert.deepEqual(await run(7), [], 'an ordinary run looks back 5 minutes');
  assert.deepEqual(await run(14), ['2'], 'the error re-check runs at :14, :29, :44, :59');
  assert.deepEqual(await run(30), ['1'], ':30 is a catch-up too');
});

test('a cron run that fails part-way keeps the deals it already queued', async () => {
  const { worker, env, sent, hubspot, now } = setup({ env: { SYNC_MAX_PAGES_PER_RUN: '5' } });
  for (let i = 1; i <= 450; i++) {
    hubspot.deals.set(String(i), { id: String(i), properties: { seats: '1', hs_lastmodifieddate: new Date(now() - 150_000 + i * 100).toISOString() } });
  }
  let pages = 0;
  hubspot.beforeSearchPage = () => {
    if (++pages === 3) throw new Error('HubSpot 502');
  };
  await assert.rejects(worker.scheduled({ scheduledTime: now() }, env), /502/);
  assert.ok(sent.length >= 300, `queued ${sent.length} before the failure`);
});

test('/sync?wait=true syncs a few deals, queues the rest, and queues retries', async () => {
  const { worker, env, sent, hubspot } = setup({ env: { SYNC_API_KEY: 'k' } });
  for (const id of ['1', '2', '3', '4']) hubspot.deals.set(id, { id, properties: { seats: '1' } });
  hubspot.failUpdateDeal = (id) => {
    if (id === '2') throw Object.assign(new Error('503'), { status: 503 });
  };
  const res = await worker.fetch(
    new Request('https://w.example.com/sync?wait=true', { method: 'POST', body: '{"dealIds":["1","2","3","4"]}', headers: { authorization: 'Bearer k' } }),
    env,
  );
  const body = await res.json();
  assert.deepEqual(body.results.map((r) => [r.dealId, r.outcome, Boolean(r.retryQueued)]), [['1', 'synced', false], ['2', 'error', true], ['3', 'synced', false]]);
  assert.equal(body.queued, 1);
  assert.deepEqual(sent.map((m) => [m.body.dealId, m.delaySeconds]), [['2', 60], ['4', 0]]);
});

test('queue messages are retried when a sync fails for a reason that may pass', async () => {
  const { worker, env, hubspot } = setup();
  hubspot.deals.set('1', { id: '1', properties: { seats: '3' } });
  hubspot.failUpdateDeal = () => {
    throw Object.assign(new Error('503'), { status: 503 });
  };
  const m = message({ dealId: '1' });
  await worker.queue({ messages: [m] }, env);
  assert.deepEqual(m.retried, { delaySeconds: 60 });
  assert.equal(m.acked, false);

  hubspot.getDeal = async () => {
    throw new TypeError('boom is not a function');
  };
  const crash = message({ dealId: '1' });
  await worker.queue({ messages: [crash] }, env);
  assert.equal(crash.acked, false, 'a read failure is retried by the queue');
});

test('the deploy-time bundle loads into the Worker', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const examples = fileURLToPath(new URL('../examples', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, ['scripts/bundle-config.js'], { cwd: root, env: { PATH: process.env.PATH, CONFIG_DIR: examples } });
  assert.match(stdout, /Bundled 2 calculator\(s\): licences, services/);
  const { default: raw } = await import(`${pathToFileURL(`${root}build/config.js`).href}?t=${Date.now()}`);
  const worker = createWorker(raw, { createClient: () => new FakeHubSpot() });
  const res = await worker.fetch(new Request('https://w.example.com/health'), {});
  assert.deepEqual((await res.json()).calculators, ['licences', 'services']);
  // Put the real config's bundle back.
  await promisify(execFile)(process.execPath, ['scripts/bundle-config.js'], { cwd: root, env: { PATH: process.env.PATH } });
});
