import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';
import { findDealsWithInputs, findErrorDeals } from '../src/sweep.js';
import { FakeHubSpot } from './fake-hubspot.js';

const CONFIG = parseConfig({
  calculators: [
    {
      id: 'many',
      appliesWhen: 'p1 > 0 || p2 > 0 || p3 > 0 || p4 > 0 || p5 > 0 || p6 > 0',
      lineItems: [{ key: 'x', product: { id: '1' }, quantity: 'coalesce(p1, 0) + coalesce(p6, 0) + 1' }],
    },
  ],
});

function hubspotWith(count, propertiesFor) {
  const hubspot = new FakeHubSpot();
  for (let i = 1; i <= count; i++) hubspot.deals.set(String(i), { id: String(i), properties: propertiesFor(i) });
  return hubspot;
}

test('backfill finds every deal with any calculator input, across search batches and pages', async () => {
  // 6 input properties: more than the 5 filter groups one search allows.
  const hubspot = hubspotWith(450, (i) => ({ [`p${(i % 6) + 1}`]: '2' }));
  hubspot.deals.set('999', { id: '999', properties: { other: 'x' } });
  const found = [];
  const result = await findDealsWithInputs({ hubspot, config: CONFIG, inputProperties: CONFIG.inputProperties, onDeal: (id) => found.push(id) });
  assert.equal(new Set(found).size, 450);
  assert.ok(!found.includes('999'));
  assert.equal(result.scanned, found.length);
  const searches = hubspot.calls.filter((c) => c.name === 'searchDeals');
  assert.ok(searches.every((c) => c.args[0].length <= 5), 'at most 5 filter groups per search');
});

test('backfill skips deals whose lines already match', async () => {
  const hubspot = hubspotWith(3, () => ({ p1: '2' }));
  const { lineFingerprints, formatFingerprint } = await import('../src/triage.js');
  const { evaluateCalculators } = await import('../src/calculators.js');
  const applied = formatFingerprint(lineFingerprints(evaluateCalculators(CONFIG, { p1: '2' }).lines));
  Object.assign(hubspot.deals.get('2').properties, { calc_line_items_status: 'synced', calc_line_items_fingerprint: applied });
  const found = [];
  await findDealsWithInputs({ hubspot, config: CONFIG, inputProperties: ['p1'], onDeal: (id) => found.push(id) });
  assert.deepEqual(found, ['1', '3']);
});

test('error re-check finds deals needing attention, except ones triage rules out', async () => {
  const config = parseConfig({
    settings: { syncWhen: 'dealstage != "closedlost"' },
    calculators: [{ id: 'c', appliesWhen: 'seats > 0', lineItems: [{ key: 'x', product: { sku: 'S' }, quantity: 'seats', unitPrice: 'rate' }] }],
  });
  const { MESSAGES } = await import('../src/triage.js');
  const hubspot = hubspotWith(5, (i) => ({ calc_line_items_status: i % 2 ? 'error' : 'synced', seats: '2', rate: '1' }));
  // Closed lost: excluded by syncWhen, so re-checking it would never change anything.
  Object.assign(hubspot.deals.get('3').properties, { dealstage: 'closedlost' });
  // Already shows the same input error.
  Object.assign(hubspot.deals.get('5').properties, {
    rate: '',
    calc_line_items_message: MESSAGES.inputErrors(['c › x: unitPrice: deal property "rate" is empty']),
  });
  const found = [];
  await findErrorDeals({ hubspot, config, onDeal: (id) => found.push(id) });
  assert.deepEqual(found, ['1']);
});

test('backfill with skipTriage passes every deal on (for --force)', async () => {
  const hubspot = hubspotWith(3, () => ({ p1: '2' }));
  const { lineFingerprints, formatFingerprint } = await import('../src/triage.js');
  const { evaluateCalculators } = await import('../src/calculators.js');
  const applied = formatFingerprint(lineFingerprints(evaluateCalculators(CONFIG, { p1: '2' }).lines));
  for (const id of ['1', '2', '3']) Object.assign(hubspot.deals.get(id).properties, { calc_line_items_status: 'synced', calc_line_items_fingerprint: applied });
  const normal = [];
  await findDealsWithInputs({ hubspot, config: CONFIG, inputProperties: ['p1'], onDeal: (id) => normal.push(id) });
  const forced = [];
  await findDealsWithInputs({ hubspot, config: CONFIG, inputProperties: ['p1'], skipTriage: true, onDeal: (id) => forced.push(id) });
  assert.deepEqual(normal, []);
  assert.deepEqual(forced, ['1', '2', '3']);
});

test('error re-check looks at the most recently changed deals first', async () => {
  const hubspot = new FakeHubSpot();
  const old = Date.parse('2026-01-01T00:00:00Z');
  for (let i = 1; i <= 250; i++) {
    hubspot.deals.set(String(i), { id: String(i), properties: { calc_line_items_status: 'error', p1: '1', hs_lastmodifieddate: new Date(old + i).toISOString() } });
  }
  hubspot.deals.set('9999', { id: '9999', properties: { calc_line_items_status: 'error', p1: '1', hs_lastmodifieddate: new Date().toISOString() } });
  const found = [];
  await findErrorDeals({ hubspot, config: CONFIG, maxPages: 1, onDeal: (id) => found.push(id) });
  assert.equal(found[0], '9999');
});

test('forced backfill still skips deals no calculator applies to', async () => {
  const config = parseConfig({ calculators: [{ id: 'c', appliesWhen: 'p1 > 5', lineItems: [{ key: 'x', product: { id: '1' }, quantity: 1 }] }] });
  const hubspot = hubspotWith(2, (i) => ({ p1: i === 1 ? '1' : '9' }));
  const found = [];
  await findDealsWithInputs({ hubspot, config, inputProperties: ['p1'], skipTriage: true, onDeal: (id) => found.push(id) });
  assert.deepEqual(found, ['2']);
});
