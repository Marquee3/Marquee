import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';
import { ProductResolver } from '../src/products.js';
import { LineItemSync } from '../src/sync.js';
import { FakeHubSpot } from './fake-hubspot.js';

const CONFIG = {
  settings: { syncWhen: 'dealstage != "closedwon"' },
  calculators: [
    {
      id: 'marquee',
      name: 'Marquee calculator',
      appliesWhen: 'width > 0 && length > 0',
      lineItems: [
        { key: 'structure', product: { sku: 'MQ-STRUCTURE' }, quantity: 'width * length', unitPrice: 'rate' },
        { key: 'lighting', product: { sku: 'MQ-LIGHT' }, quantity: 'ceil(width * length / 20)' },
      ],
    },
    {
      id: 'furniture',
      name: 'Furniture calculator',
      appliesWhen: 'guests > 0',
      lineItems: [{ key: 'chairs', product: { sku: 'FURN-CHAIR' }, quantity: 'guests' }],
    },
  ],
};

const PRODUCTS = [
  { id: '1', hs_sku: 'MQ-STRUCTURE', name: 'Marquee structure', price: '0' },
  { id: '2', hs_sku: 'MQ-LIGHT', name: 'Lighting rig', price: '45' },
  { id: '3', hs_sku: 'FURN-CHAIR', name: 'Chair', price: '2.5' },
  { id: '4', hs_sku: 'MQ-LIGHT-LED', name: 'LED lighting rig', price: '60' },
];

function setup(dealProperties = {}, { config = CONFIG } = {}) {
  const hubspot = new FakeHubSpot({
    deals: { 7: { dealstage: 'qualified', width: '6', length: '12', rate: '9.5', guests: '80', ...dealProperties } },
    products: PRODUCTS,
  });
  const sync = new LineItemSync({
    hubspot,
    config: parseConfig(config),
    products: new ProductResolver(hubspot),
    now: () => new Date('2026-10-16T12:00:00Z'),
  });
  return { hubspot, sync, deal: () => hubspot.deals.get('7').properties, lines: () => summary(hubspot.dealLineItems('7')) };
}

const summary = (items) =>
  items
    .map((li) => ({ key: li.properties.calc_line_key ?? null, product: li.properties.hs_product_id, quantity: li.properties.quantity, price: li.properties.price }))
    .sort((a, b) => String(a.key).localeCompare(String(b.key)));

test('creates line items from calculator output and marks the deal ready for review', async () => {
  const { sync, deal, lines } = setup();
  const result = await sync.syncDeal('7');

  assert.equal(result.outcome, 'synced');
  assert.deepEqual(lines(), [
    { key: 'furniture:chairs', product: '3', quantity: '80', price: '2.5' },
    { key: 'marquee:lighting', product: '2', quantity: '4', price: '45' },
    { key: 'marquee:structure', product: '1', quantity: '72', price: '9.5' },
  ]);
  assert.equal(deal().calc_line_items_status, 'synced');
  assert.equal(
    deal().calc_line_items_message,
    'Added 3 line items from Marquee calculator and Furniture calculator. Review them, then create the quote.',
  );
  assert.equal(deal().calc_line_items_synced_at, '2026-10-16T12:00:00.000Z');
  assert.match(deal().calc_line_items_fingerprint, /^[0-9a-f]{32}$/);
});

test('running again creates no duplicates and makes no writes', async () => {
  const { hubspot, sync, lines } = setup();
  await sync.syncDeal('7');
  const before = lines();
  hubspot.calls = [];

  const result = await sync.syncDeal('7');
  assert.equal(result.outcome, 'unchanged');
  assert.deepEqual(lines(), before);
  assert.deepEqual(hubspot.writeCalls(), []);
  assert.deepEqual(hubspot.calls.filter((c) => c.name === 'updateDeal'), [], 'status already "synced"; not rewritten');
});

test('a calculator change updates, adds and removes only what changed', async () => {
  const { hubspot, sync, deal, lines } = setup();
  await sync.syncDeal('7');
  Object.assign(hubspot.deals.get('7').properties, { width: '8', guests: '' });

  const result = await sync.syncDeal('7');
  assert.equal(result.outcome, 'synced');
  assert.deepEqual(lines(), [
    { key: 'marquee:lighting', product: '2', quantity: '5', price: '45' },
    { key: 'marquee:structure', product: '1', quantity: '96', price: '9.5' },
  ]);
  assert.equal(
    deal().calc_line_items_message,
    'Updated 2 and removed 1 line items from Marquee calculator and Furniture calculator. Review them, then create the quote.',
  );
});

test('manually added line items are never touched', async () => {
  const { hubspot, sync } = setup();
  const manualId = hubspot.addLineItem('7', { hs_product_id: '99', quantity: '1', name: 'Delivery' });
  await sync.syncDeal('7');
  Object.assign(hubspot.deals.get('7').properties, { width: '', guests: '' });
  await sync.syncDeal('7');

  assert.deepEqual(hubspot.dealLineItems('7').map((li) => li.id), [manualId]);
});

test('team edits outside the managed fields survive a re-sync', async () => {
  const { hubspot, sync } = setup();
  await sync.syncDeal('7');
  const chairs = hubspot.dealLineItems('7').find((li) => li.properties.calc_line_key === 'furniture:chairs');
  chairs.properties.hs_discount_percentage = '10';
  hubspot.deals.get('7').properties.guests = '90';
  await sync.syncDeal('7');

  assert.equal(chairs.properties.quantity, '90');
  assert.equal(chairs.properties.hs_discount_percentage, '10');
});

test('a product change replaces the line item', async () => {
  const config = structuredClone(CONFIG);
  const { hubspot, sync } = setup({}, { config });
  await sync.syncDeal('7');
  const oldId = hubspot.dealLineItems('7').find((li) => li.properties.calc_line_key === 'marquee:lighting').id;

  config.calculators[0].lineItems[1].product.sku = 'MQ-LIGHT-LED';
  const sync2 = new LineItemSync({ hubspot, config: parseConfig(config), products: new ProductResolver(hubspot) });
  const result = await sync2.syncDeal('7');

  const lighting = hubspot.dealLineItems('7').filter((li) => li.properties.calc_line_key === 'marquee:lighting');
  assert.equal(lighting.length, 1);
  assert.notEqual(lighting[0].id, oldId);
  assert.equal(lighting[0].properties.hs_product_id, '4');
  assert.match(result.message, /^Swapped the product on 1 line item from Marquee calculator\./);
});

test('two syncs racing on the same deal end with one copy of each line', async () => {
  const { hubspot, sync, lines } = setup();
  // Both syncs read "no line items" before either creates any.
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let waiting = 0;
  hubspot.beforeCreate = async () => {
    if (++waiting === 2) release();
    await gate;
  };

  const results = await Promise.all([sync.syncDeal('7'), sync.syncDeal('7')]);
  assert.deepEqual(results.map((r) => r.outcome), ['synced', 'synced']);
  assert.equal(lines().length, 3);
  assert.equal(new Set(lines().map((l) => l.key)).size, 3);
});

test('existing duplicates are cleaned up', async () => {
  const { hubspot, sync, lines } = setup({ guests: '', width: '' });
  hubspot.addLineItem('7', { calc_line_key: 'furniture:chairs', hs_product_id: '3', quantity: '5' });
  hubspot.addLineItem('7', { calc_line_key: 'furniture:chairs', hs_product_id: '3', quantity: '5' });
  hubspot.deals.get('7').properties.guests = '5';

  const result = await sync.syncDeal('7');
  assert.equal(lines().length, 1);
  assert.match(result.message, /Removed 1 duplicate\./);
});

test('missing calculator inputs: nothing changes and the deal says why', async () => {
  const { hubspot, sync, deal } = setup({ rate: '' });
  const result = await sync.syncDeal('7');

  assert.equal(result.outcome, 'error');
  assert.deepEqual(hubspot.writeCalls(), []);
  assert.equal(deal().calc_line_items_status, 'error');
  assert.match(deal().calc_line_items_message, /Marquee calculator › structure: unitPrice: deal property "rate" is empty/);
});

test('unknown SKU is reported', async () => {
  const config = structuredClone(CONFIG);
  config.calculators[1].lineItems[0].product.sku = 'NOPE';
  const { hubspot, sync, deal } = setup({}, { config });
  const result = await sync.syncDeal('7');

  assert.equal(result.outcome, 'error');
  assert.deepEqual(hubspot.writeCalls(), []);
  assert.match(deal().calc_line_items_message, /no product in the HubSpot product library has SKU "NOPE"/);
});

test('frozen deals are left alone; unfreezing re-syncs', async () => {
  const { hubspot, sync, deal, lines } = setup({ calc_line_items_frozen: 'true' });
  assert.equal((await sync.syncDeal('7')).outcome, 'skipped');
  assert.deepEqual(lines(), []);
  assert.equal(deal().calc_line_items_status, 'skipped');

  hubspot.deals.get('7').properties.calc_line_items_frozen = 'false';
  assert.equal((await sync.syncDeal('7')).outcome, 'synced');
  assert.equal(lines().length, 3);
});

test('deals with a quote are not changed', async () => {
  const { hubspot, sync, deal, lines } = setup();
  await sync.syncDeal('7');
  hubspot.quotes.set('7', ['555']);
  hubspot.deals.get('7').properties.guests = '120';

  const result = await sync.syncDeal('7');
  assert.equal(result.outcome, 'skipped');
  assert.equal(lines().find((l) => l.key === 'furniture:chairs').quantity, '80');
  assert.match(deal().calc_line_items_message, /already has a quote/);
});

test('deals outside syncWhen are skipped without writing anything', async () => {
  const { hubspot, sync } = setup({ dealstage: 'closedwon' });
  const result = await sync.syncDeal('7');
  assert.equal(result.outcome, 'skipped');
  assert.deepEqual(hubspot.calls.map((c) => c.name), ['getDeal']);
});

test('deals no calculator applies to are left untouched', async () => {
  const { hubspot, sync } = setup({ width: '', guests: '' });
  const result = await sync.syncDeal('7');
  assert.equal(result.outcome, 'noop');
  assert.deepEqual(hubspot.calls.filter((c) => c.name === 'updateDeal'), []);
});

test('an error is cleared once the inputs are fixed', async () => {
  const { hubspot, sync, deal } = setup({ rate: '' });
  await sync.syncDeal('7');
  hubspot.deals.get('7').properties.rate = '9.5';
  assert.equal((await sync.syncDeal('7')).outcome, 'synced');
  assert.equal(deal().calc_line_items_status, 'synced');
});

test('dry run reports the plan without writing', async () => {
  const { hubspot, sync } = setup();
  const result = await sync.syncDeal('7', { dryRun: true });
  assert.equal(result.outcome, 'synced');
  assert.equal(result.plan.create.length, 3);
  assert.deepEqual(hubspot.writeCalls(), []);
  assert.deepEqual(hubspot.calls.filter((c) => c.name === 'updateDeal'), []);
});

test('force re-applies even when the fingerprint matches', async () => {
  const { hubspot, sync } = setup();
  await sync.syncDeal('7');
  // Someone deleted a calculator line by hand; a normal sync respects that.
  const lighting = hubspot.dealLineItems('7').find((li) => li.properties.calc_line_key === 'marquee:lighting');
  hubspot.lineItems.delete(lighting.id);
  assert.equal((await sync.syncDeal('7')).outcome, 'unchanged');
  assert.equal((await sync.syncDeal('7', { force: true })).outcome, 'synced');
  assert.equal(hubspot.dealLineItems('7').length, 3);
});

test('HubSpot failures are reported on the deal', async () => {
  const { hubspot, sync, deal } = setup();
  hubspot.createLineItems = async () => {
    throw new Error('HubSpot POST /crm/v3/objects/line_items/batch/create failed (400): Property "calc_line_key" does not exist');
  };
  const result = await sync.syncDeal('7');
  assert.equal(result.outcome, 'error');
  assert.equal(deal().calc_line_items_status, 'error');
  assert.equal(deal().calc_line_items_fingerprint, '');
  assert.match(deal().calc_line_items_message, /Run "npm run setup"/);
});

test('a deal that cannot be read is reported, not thrown', async () => {
  const { sync } = setup();
  const result = await sync.syncDeal('404');
  assert.equal(result.outcome, 'error');
  assert.match(result.message, /Could not read deal/);
});

test('setLineOrder: false leaves hs_position_on_quote alone', async () => {
  const config = { ...structuredClone(CONFIG), settings: { setLineOrder: false } };
  const { hubspot, sync } = setup({}, { config });
  await sync.syncDeal('7');
  assert.ok(hubspot.dealLineItems('7').every((li) => li.properties.hs_position_on_quote === undefined));
  hubspot.calls = [];
  hubspot.deals.get('7').properties.calc_line_items_fingerprint = '';
  await sync.syncDeal('7');
  assert.deepEqual(hubspot.writeCalls(), [], 'no position updates either');
});

test('a broken syncWhen is reported as a config problem', async () => {
  const config = { ...structuredClone(CONFIG), settings: { syncWhen: 'width * missing > 0' } };
  const { hubspot, sync, deal } = setup({}, { config });
  const result = await sync.syncDeal('7');
  assert.equal(result.outcome, 'error');
  assert.deepEqual(hubspot.writeCalls(), []);
  assert.match(deal().calc_line_items_message, /settings\.syncWhen: deal property "missing" is empty/);
});
