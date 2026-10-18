import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';
import { MESSAGES, changedKeys, formatFingerprint, lineFingerprints, parseFingerprint, triage } from '../src/triage.js';

const CONFIG = parseConfig({
  settings: { syncWhen: 'dealstage != "closedwon"' },
  calculators: [
    { id: 'lic', appliesWhen: 'seats > 0', lineItems: [{ key: 'seats', product: { sku: 'S' }, quantity: 'seats', unitPrice: 'rate' }] },
  ],
});

const fp = (seats, rate) => formatFingerprint(lineFingerprints([{ key: 'lic:seats', product: { sku: 'S' }, quantity: seats, price: rate, name: null, description: null }]));

test('fingerprints round-trip and pinpoint changed lines', () => {
  const a = lineFingerprints([
    { key: 'x:a', product: { sku: 'A' }, quantity: 1, price: null, name: null, description: null },
    { key: 'x:b', product: { id: '9' }, quantity: 2, price: 5, name: 'B', description: null },
  ]);
  const text = formatFingerprint(a);
  assert.match(text, /^v2;x:a=[0-9a-f]{12};x:b=[0-9a-f]{12}$/);
  assert.deepEqual(parseFingerprint(text), a);
  const b = new Map(a);
  b.set('x:b', 'changed');
  b.set('x:c', 'new');
  b.delete('x:a');
  assert.deepEqual([...changedKeys(a, b)].sort(), ['x:a', 'x:b', 'x:c']);
  assert.equal(parseFingerprint(''), null);
  assert.equal(parseFingerprint('0123456789abcdef'), null);
  assert.deepEqual(parseFingerprint('v2'), new Map());
});

test('triage mirrors what a sync would do', () => {
  const cases = [
    [{ dealstage: 'closedwon', seats: '3', rate: '1' }, 'skip', 'syncWhen'],
    [{ seats: '' }, 'skip', 'noop'],
    [{ seats: '3', rate: '1' }, 'sync', 'changed'],
    [{ seats: '3', rate: '' }, 'sync', 'errors'],
    [{ seats: '3', rate: '', calc_line_items_status: 'error', calc_line_items_message: MESSAGES.inputErrors(['lic › seats: unitPrice: deal property "rate" is empty']) }, 'skip', 'errors'],
    [{ seats: '3', rate: '1', calc_line_items_frozen: 'true' }, 'sync', 'frozen'],
    [{ seats: '3', rate: '1', calc_line_items_frozen: 'true', calc_line_items_status: 'skipped', calc_line_items_message: MESSAGES.frozen }, 'skip', 'frozen'],
    [{ seats: '3', rate: '1', calc_line_items_status: 'synced', calc_line_items_fingerprint: fp(3, 1) }, 'skip', 'unchanged'],
    [{ seats: '4', rate: '1', calc_line_items_status: 'synced', calc_line_items_fingerprint: fp(3, 1) }, 'sync', 'changed'],
    [{ seats: '3', rate: '1', calc_line_items_status: 'skipped', calc_line_items_fingerprint: fp(3, 1) }, 'sync', 'changed'],
    [{ seats: '', calc_line_items_status: 'synced', calc_line_items_fingerprint: fp(3, 1) }, 'sync', 'changed'],
  ];
  for (const [properties, action, reason] of cases) {
    const t = triage(CONFIG, properties);
    assert.deepEqual([t.action, t.reason], [action, reason], JSON.stringify(properties));
  }
});

test('a broken syncWhen is reported once', () => {
  const config = parseConfig({ settings: { syncWhen: 'a * b > 0' }, calculators: [] });
  const first = triage(config, { a: '1' });
  assert.deepEqual([first.action, first.reason], ['sync', 'syncWhenError']);
  const again = triage(config, { a: '1', calc_line_items_status: 'error', calc_line_items_message: first.syncWhenError });
  assert.deepEqual([again.action, again.reason], ['skip', 'syncWhenError']);
});
