import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';
import { DealPoller } from '../src/poller.js';
import { FakeHubSpot } from './fake-hubspot.js';

const MINUTE = 60_000;
const T0 = Date.parse('2026-10-18T09:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

const CONFIG = parseConfig({
  calculators: [{ id: 'a', appliesWhen: 'seats > 0', lineItems: [{ key: 'x', product: { id: '1' }, quantity: 'seats' }] }],
});

function setup(deals, { config = CONFIG, maxPages, quietMs = 0 } = {}) {
  let clock = T0;
  const hubspot = new FakeHubSpot({ now: () => clock });
  for (const [id, properties] of Object.entries(deals)) hubspot.deals.set(id, { id, properties: { ...properties } });
  const enqueued = [];
  const poller = new DealPoller({
    hubspot,
    queue: { enqueue: (id) => enqueued.push(id) },
    config,
    intervalMs: MINUTE,
    lookbackMs: 60 * MINUTE,
    overlapMs: 2 * MINUTE,
    quietMs,
    errorRecheckMinutes: 3,
    maxPages,
    now: () => clock,
  });
  // Searches for changed deals (not the periodic "Needs attention" re-check).
  const searches = () =>
    hubspot.calls
      .filter((c) => c.name === 'searchDeals' && c.args[0][0].filters.some((f) => f.propertyName === 'hs_lastmodifieddate'))
      .map((c) => c.args[0]);
  return { hubspot, poller, enqueued, searches, tick: (ms) => (clock += ms), setClock: (ms) => (clock = ms) };
}

const since = (filterGroups) => Number(filterGroups[0].filters.find((f) => f.propertyName === 'hs_lastmodifieddate').value);

test('queues changed deals that need a sync, and nothing else', async () => {
  const { poller, enqueued, searches } = setup({
    1: { hs_lastmodifieddate: iso(T0 - 5 * MINUTE), seats: '3' },
    2: { hs_lastmodifieddate: iso(T0 - 4 * MINUTE), seats: '' },
    3: { hs_lastmodifieddate: iso(T0 - 3 * MINUTE), calc_line_items_status: 'error', calc_line_items_message: 'old' },
    4: { hs_lastmodifieddate: iso(T0 - 90 * MINUTE), seats: '9' },
  });
  await poller.sweep();
  assert.deepEqual(enqueued, ['1', '3'], 'deal 2 uses no calculator; deal 4 is older than the lookback');
  assert.equal(since(searches()[0]), T0 - 60 * MINUTE);
});

test('deals whose calculator output is already applied are not queued again', async () => {
  // A synced deal's status write changes its last-modified time; the poller
  // must recognise there is nothing to do without another sync.
  const { hubspot, poller, enqueued, tick } = setup({ 1: { hs_lastmodifieddate: iso(T0 - MINUTE), seats: '3' } });
  await poller.sweep();
  assert.deepEqual(enqueued, ['1']);
  const { LineItemSync } = await import('../src/sync.js');
  const { ProductResolver } = await import('../src/products.js');
  await new LineItemSync({ hubspot, config: CONFIG, products: new ProductResolver(hubspot) }).syncDeal('1');
  tick(MINUTE);
  await poller.sweep();
  assert.deepEqual(enqueued, ['1'], 'status write seen, but triage says unchanged');
});

test('calculators that apply when inputs are blank are picked up', async () => {
  const config = parseConfig({
    calculators: [
      { id: 'fee', lineItems: [{ key: 'setup', product: { id: '1' }, quantity: 1 }] },
      { id: 'opt', appliesWhen: '!opted_out', lineItems: [{ key: 'x', product: { id: '1' }, quantity: 'coalesce(units, 1)' }] },
    ],
  });
  const { poller, enqueued } = setup({ 1: { hs_lastmodifieddate: iso(T0 - MINUTE) } }, { config });
  await poller.sweep();
  assert.deepEqual(enqueued, ['1']);
});

test('deals modified mid-sweep do not make others get skipped', async () => {
  // HubSpot's search pages by offset. If deals already returned are modified
  // again before the next page, they move to the end and shift the offsets.
  const deals = {};
  for (let i = 1; i <= 450; i++) deals[i] = { hs_lastmodifieddate: iso(T0 - 30 * MINUTE + i * 1000), seats: '1' };
  const { hubspot, poller, enqueued } = setup(deals);
  let pages = 0;
  hubspot.beforeSearchPage = () => {
    if (++pages === 2) for (let i = 1; i <= 5; i++) hubspot.editDeal(String(i), { seats: '2' });
  };
  await poller.sweep();
  const missed = Object.keys(deals).filter((id) => !enqueued.includes(id));
  assert.deepEqual(missed, []);
});

test('the window moves using HubSpot timestamps only, never the server clock', async () => {
  const { poller, searches, tick } = setup({ 1: { hs_lastmodifieddate: iso(T0 - 10 * MINUTE), seats: '1' } });
  await poller.sweep();
  tick(MINUTE);
  await poller.sweep();
  tick(10 * MINUTE);
  await poller.sweep(); // nothing new: window stays put even though time moved on
  const sinces = searches().map(since);
  assert.equal(sinces[1], T0 - 12 * MINUTE, 'newest seen minus the 2 minute overlap');
  assert.equal(sinces[2], sinces[1]);
});

test('a deal changed very recently waits for the next sweep (quiet period)', async () => {
  const { poller, enqueued, tick } = setup({ 1: { hs_lastmodifieddate: iso(T0 - 1000), seats: '1' } }, { quietMs: 5000 });
  await poller.sweep();
  assert.deepEqual(enqueued, []);
  tick(MINUTE);
  await poller.sweep();
  assert.deepEqual(enqueued, ['1']);
});

test('failed syncs are retried on later sweeps, then given up', async () => {
  const { poller, enqueued } = setup({});
  for (let attempt = 1; attempt <= 5; attempt++) {
    poller.handleResult('9', { outcome: 'error', retry: true });
    await poller.sweep();
  }
  assert.equal(enqueued.filter((id) => id === '9').length, 5, 'five attempts');
  poller.handleResult('9', { outcome: 'error', retry: true });
  await poller.sweep();
  assert.equal(enqueued.filter((id) => id === '9').length, 5, 'then it gives up');

  poller.handleResult('8', { retry: true });
  poller.handleResult('8', { outcome: 'synced' });
  enqueued.length = 0;
  await poller.sweep();
  assert.deepEqual(enqueued, [], 'success clears the retry');
});

test('deals needing attention are re-checked periodically', async () => {
  // e.g. a missing product was added to the library: the deal itself didn't
  // change, so only this re-check brings it back.
  const { poller, enqueued, tick } = setup({
    1: { hs_lastmodifieddate: iso(T0 - 300 * MINUTE), calc_line_items_status: 'error' },
    2: { hs_lastmodifieddate: iso(T0 - 300 * MINUTE), calc_line_items_status: 'synced' },
  });
  for (let i = 0; i < 3; i++) {
    await poller.sweep();
    tick(MINUTE);
  }
  assert.deepEqual(enqueued, ['1'], 'every 3rd sweep with errorRecheckMinutes 3');
});

test('when there are more changes than one sweep covers, the next sweep carries on', async () => {
  const deals = {};
  for (let i = 1; i <= 1000; i++) deals[i] = { hs_lastmodifieddate: iso(T0 - 30 * MINUTE + i * 100), seats: '1' };
  const { poller, enqueued, tick } = setup(deals, { maxPages: 2 });
  await poller.sweep();
  assert.ok(enqueued.length >= 350 && enqueued.length < 1000, `first sweep queued ${enqueued.length}`);
  for (let i = 0; i < 5; i++) {
    tick(MINUTE);
    await poller.sweep();
  }
  assert.equal(new Set(enqueued).size, 1000);
});

test('accepts epoch-millisecond timestamps', async () => {
  const { poller, enqueued } = setup({ 9: { hs_lastmodifieddate: String(T0 - MINUTE), seats: '2' } });
  await poller.sweep();
  assert.deepEqual(enqueued, ['9']);
});

test('a failed search leaves the window where it was', async () => {
  const { hubspot, poller, searches } = setup({ 1: { hs_lastmodifieddate: iso(T0 - MINUTE), seats: '1' } });
  await poller.sweep();
  hubspot.beforeSearchPage = () => {
    throw new Error('HubSpot down');
  };
  await assert.rejects(poller.sweep(), /HubSpot down/);
  hubspot.beforeSearchPage = null;
  await poller.sweep();
  const sinces = searches().map(since);
  assert.equal(sinces[2], sinces[1]);
});
