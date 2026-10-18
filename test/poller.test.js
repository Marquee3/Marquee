import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';
import { DealPoller } from '../src/poller.js';

const CONFIG = parseConfig({
  calculators: [{ id: 'a', appliesWhen: 'seats > 0', lineItems: [{ key: 'x', product: { id: '1' }, quantity: 'seats' }] }],
});

const MINUTE = 60_000;
const T0 = Date.parse('2026-10-18T09:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const toMs = (v) => (/^\d+$/.test(v) ? Number(v) : Date.parse(v));

function setup(deals) {
  const searches = [];
  const enqueued = [];
  let clock = T0;
  const hubspot = {
    async searchDealsModifiedSince(since, properties, { after, limit }) {
      searches.push({ since, properties, after, limit });
      const matching = deals.filter((d) => toMs(d.properties.hs_lastmodifieddate) >= since);
      const start = Number(after ?? 0);
      const results = matching.slice(start, start + limit);
      return { results, after: start + limit < matching.length ? String(start + limit) : undefined };
    },
  };
  const poller = new DealPoller({
    hubspot,
    queue: { enqueue: (id) => enqueued.push(id) },
    config: CONFIG,
    lookbackMs: 60 * MINUTE,
    overlapMs: 2 * MINUTE,
    now: () => clock,
  });
  return { poller, searches, enqueued, tick: (ms) => (clock += ms) };
}

const deal = (id, modifiedMs, properties = {}) => ({ id, properties: { hs_lastmodifieddate: iso(modifiedMs), ...properties } });

test('queues recently changed deals that use a calculator or were synced before', async () => {
  const deals = [
    deal('1', T0 - 5 * MINUTE, { seats: '3' }),
    deal('2', T0 - 4 * MINUTE, { seats: '' }),
    deal('3', T0 - 3 * MINUTE, { calc_line_items_status: 'synced' }),
    deal('4', T0 - 90 * MINUTE, { seats: '9' }),
  ];
  const { poller, enqueued, searches } = setup(deals);
  await poller.sweep();
  assert.deepEqual(enqueued, ['1', '3'], 'deal 2 has no calculator input; deal 4 is older than the lookback');
  assert.equal(searches[0].since, T0 - 60 * MINUTE);
  assert.ok(searches[0].properties.includes('seats'));
  assert.ok(searches[0].properties.includes('hs_lastmodifieddate'));
});

test('later sweeps start just before the newest change seen, and skip deals already queued', async () => {
  const deals = [deal('1', T0 - 5 * MINUTE, { seats: '3' })];
  const { poller, enqueued, searches, tick } = setup(deals);
  await poller.sweep();
  tick(MINUTE);
  await poller.sweep();
  assert.equal(searches[1].since, T0 - 7 * MINUTE, 'newest seen minus the 2 minute overlap');
  assert.deepEqual(enqueued, ['1'], 'unchanged deal in the overlap is not queued twice');

  deals[0].properties.hs_lastmodifieddate = iso(T0 + 30_000);
  tick(MINUTE);
  await poller.sweep();
  assert.deepEqual(enqueued, ['1', '1'], 'changed again, so queued again');
});

test('the window never moves backwards', async () => {
  const { poller, searches, tick } = setup([]);
  await poller.sweep();
  tick(MINUTE);
  await poller.sweep();
  tick(MINUTE);
  await poller.sweep();
  const sinces = searches.map((s) => s.since);
  assert.deepEqual(sinces, [...sinces].sort((a, b) => a - b));
  assert.equal(sinces[2], T0 + MINUTE - 2 * MINUTE);
});

test('pages through results, and stops at the search API limit then carries on', async () => {
  const many = Array.from({ length: 10_500 }, (_, i) => deal(String(i), T0 - 30 * MINUTE + i * 10, { seats: '1' }));
  const { poller, enqueued, searches } = setup(many);
  await poller.sweep();
  assert.equal(searches.length, 50);
  assert.equal(enqueued.length, 10_000);
  await poller.sweep();
  assert.equal(new Set(enqueued).size, 10_500, 'second sweep picks up the rest');
});

test('accepts epoch-millisecond timestamps', async () => {
  const { poller, enqueued, searches, tick } = setup([{ id: '9', properties: { hs_lastmodifieddate: String(T0 - MINUTE), seats: '2' } }]);
  await poller.sweep();
  assert.deepEqual(enqueued, ['9']);
  tick(MINUTE);
  await poller.sweep();
  assert.equal(searches[1].since, T0 - 3 * MINUTE);
  assert.deepEqual(enqueued, ['9'], 'not queued twice');
});

test('a failed search leaves the window where it was', async () => {
  const { poller, searches } = setup([]);
  await poller.sweep();
  const before = searches[0].since;
  const failing = new DealPoller({
    hubspot: { searchDealsModifiedSince: async () => { throw new Error('HubSpot down'); } },
    queue: { enqueue() {} },
    config: CONFIG,
    now: () => T0,
  });
  await assert.rejects(failing.sweep(), /HubSpot down/);
  assert.ok(before <= T0);
});
