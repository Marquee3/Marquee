import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicates, planReconciliation, toLineItemProperties } from '../src/reconcile.js';

const line = (key, overrides = {}) => ({
  key,
  productId: '1',
  quantity: 1,
  price: null,
  name: null,
  description: null,
  position: 0,
  ...overrides,
});

const item = (id, properties) => ({ id: String(id), properties });

test('creates lines that are missing', () => {
  const plan = planReconciliation([line('m:a'), line('m:b', { position: 1 })], []);
  assert.deepEqual(plan.create.map((l) => l.key), ['m:a', 'm:b']);
  assert.equal(plan.update.length + plan.archive.length, 0);
});

test('keeps lines that already match, ignoring number formatting', () => {
  const plan = planReconciliation(
    [line('m:a', { quantity: 2, price: 10 })],
    [item(5, { calc_line_key: 'm:a', hs_product_id: '1', quantity: '2.0', price: '10.00', hs_position_on_quote: '0' })],
  );
  assert.deepEqual(plan.keep, [{ id: '5', key: 'm:a' }]);
  assert.equal(plan.create.length + plan.update.length + plan.archive.length, 0);
});

test('updates only the properties that changed', () => {
  const plan = planReconciliation(
    [line('m:a', { quantity: 3, price: 10, name: 'New name' })],
    [item(5, { calc_line_key: 'm:a', hs_product_id: '1', quantity: '2', price: '10', name: 'Old', hs_position_on_quote: '0' })],
  );
  assert.deepEqual(plan.update, [
    { id: '5', key: 'm:a', changes: { quantity: ['2', '3'], name: ['Old', 'New name'] }, properties: { quantity: '3', name: 'New name' } },
  ]);
});

test('leaves price alone when the config does not set one', () => {
  const plan = planReconciliation(
    [line('m:a')],
    [item(5, { calc_line_key: 'm:a', hs_product_id: '1', quantity: '1', price: '99', hs_position_on_quote: '0' })],
  );
  assert.equal(plan.update.length, 0);
});

test('replaces a line whose product changed', () => {
  const plan = planReconciliation(
    [line('m:a', { productId: '2' })],
    [item(5, { calc_line_key: 'm:a', hs_product_id: '1', quantity: '1', hs_position_on_quote: '0' })],
  );
  assert.deepEqual(plan.archive, [{ id: '5', key: 'm:a', reason: 'product changed' }]);
  assert.deepEqual(plan.create.map((l) => l.key), ['m:a']);
});

test('removes managed lines no longer produced, never manual ones', () => {
  const plan = planReconciliation(
    [],
    [item(5, { calc_line_key: 'm:a', hs_product_id: '1' }), item(6, { calc_line_key: null, hs_product_id: '1' }), item(7, { hs_product_id: '3' })],
  );
  assert.deepEqual(plan.archive, [{ id: '5', key: 'm:a', reason: 'no longer in calculator output' }]);
});

test('duplicates: keeps the lowest ID and removes the rest', () => {
  const existing = [
    item(30, { calc_line_key: 'm:a', hs_product_id: '1', quantity: '1', hs_position_on_quote: '0' }),
    item(9, { calc_line_key: 'm:a', hs_product_id: '1', quantity: '1', hs_position_on_quote: '0' }),
    item(100, { calc_line_key: 'm:a', hs_product_id: '1', quantity: '1', hs_position_on_quote: '0' }),
  ];
  const plan = planReconciliation([line('m:a')], existing);
  assert.deepEqual(plan.keep, [{ id: '9', key: 'm:a' }]);
  assert.deepEqual(plan.archive.map((a) => [a.id, a.reason]), [['30', 'duplicate'], ['100', 'duplicate']]);
  assert.deepEqual(findDuplicates(existing).map((i) => i.id), ['30', '100']);
});

test('IDs compare numerically, not as text', () => {
  const existing = [item('99999999999999999999', { calc_line_key: 'k' }), item('100000000000000000000', { calc_line_key: 'k' })];
  assert.deepEqual(findDuplicates(existing).map((i) => i.id), ['100000000000000000000']);
});

test('new line item properties', () => {
  assert.deepEqual(toLineItemProperties(line('m:a', { quantity: 2, price: 5.5, position: 3 }), { currency: 'GBP' }), {
    calc_line_key: 'm:a',
    hs_product_id: '1',
    quantity: '2',
    hs_position_on_quote: '3',
    price: '5.5',
    hs_line_item_currency_code: 'GBP',
  });
});

test('lines from calculators not in the config are orphans, never touched', () => {
  const existing = [
    item(5, { calc_line_key: 'gone:a', hs_product_id: '1' }),
    item(6, { calc_line_key: 'gone:a', hs_product_id: '1' }),
    item(7, { calc_line_key: 'm:a', hs_product_id: '1', quantity: '1', hs_position_on_quote: '0' }),
  ];
  const plan = planReconciliation([line('m:a')], existing, { calculatorIds: new Set(['m']) });
  assert.deepEqual(plan.orphans, [{ id: '5', key: 'gone:a' }, { id: '6', key: 'gone:a' }]);
  assert.deepEqual(plan.archive, [], 'not even their duplicates');
  assert.deepEqual(findDuplicates(existing, { calculatorIds: new Set(['m']) }), []);
});

test('scope: unchanged lines are kept as the team left them', () => {
  const existing = [
    item(5, { calc_line_key: 'm:a', hs_product_id: '1', quantity: '9', hs_position_on_quote: '0' }),
    item(6, { calc_line_key: 'm:b', hs_product_id: '1', quantity: '1', hs_position_on_quote: '1' }),
    item(7, { calc_line_key: 'm:old', hs_product_id: '1' }),
  ];
  const desired = [line('m:a', { quantity: 2 }), line('m:b', { quantity: 3, position: 1 }), line('m:deleted-by-team', { position: 2 })];
  const plan = planReconciliation(desired, existing, { calculatorIds: new Set(['m']), scope: new Set(['m:b']) });
  assert.deepEqual(plan.keep, [{ id: '5', key: 'm:a' }], 'a was hand-edited to 9 and its output did not change');
  assert.deepEqual(plan.update.map((u) => [u.key, u.properties]), [['m:b', { quantity: '3' }]]);
  assert.deepEqual(plan.create, [], 'a line the team deleted is not recreated unless its output changes');
  assert.deepEqual(plan.archive, [{ id: '7', key: 'm:old', reason: 'no longer in calculator output' }]);
});
