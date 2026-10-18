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
      id: 'hardware',
      name: 'Hardware calculator',
      appliesWhen: 'rooms > 0 && units_per_room > 0',
      lineItems: [
        { key: 'units', product: { sku: 'HW-UNIT' }, quantity: 'rooms * units_per_room', unitPrice: 'unit_rate' },
        { key: 'mounts', product: { sku: 'HW-MOUNT' }, quantity: 'ceil(rooms * units_per_room / 20)' },
      ],
    },
    {
      id: 'licences',
      name: 'Licence calculator',
      appliesWhen: 'users > 0',
      lineItems: [{ key: 'seats', product: { sku: 'LIC-SEAT' }, quantity: 'users' }],
    },
  ],
};

const PRODUCTS = [
  { id: '1', hs_sku: 'HW-UNIT', name: 'Hardware unit', price: '0' },
  { id: '2', hs_sku: 'HW-MOUNT', name: 'Wall mount', price: '45' },
  { id: '3', hs_sku: 'LIC-SEAT', name: 'Licence seat', price: '2.5' },
  { id: '4', hs_sku: 'HW-MOUNT-PRO', name: 'Pro wall mount', price: '60' },
];

function setup(dealProperties = {}, { config = CONFIG } = {}) {
  const hubspot = new FakeHubSpot({
    deals: { 7: { dealstage: 'qualified', rooms: '6', units_per_room: '12', unit_rate: '9.5', users: '80', ...dealProperties } },
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
    { key: 'hardware:mounts', product: '2', quantity: '4', price: '45' },
    { key: 'hardware:units', product: '1', quantity: '72', price: '9.5' },
    { key: 'licences:seats', product: '3', quantity: '80', price: '2.5' },
  ]);
  assert.equal(deal().calc_line_items_status, 'synced');
  assert.equal(
    deal().calc_line_items_message,
    'Added 3 line items from Hardware calculator and Licence calculator. Review them, then create the quote.',
  );
  assert.equal(deal().calc_line_items_synced_at, '2026-10-16T12:00:00.000Z');
  assert.match(deal().calc_line_items_fingerprint, /^v2;hardware:mounts=[0-9a-f]{12};hardware:units=[0-9a-f]{12};licences:seats=[0-9a-f]{12}$/);
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
  Object.assign(hubspot.deals.get('7').properties, { rooms: '8', users: '' });

  const result = await sync.syncDeal('7');
  assert.equal(result.outcome, 'synced');
  assert.deepEqual(lines(), [
    { key: 'hardware:mounts', product: '2', quantity: '5', price: '45' },
    { key: 'hardware:units', product: '1', quantity: '96', price: '9.5' },
  ]);
  assert.equal(
    deal().calc_line_items_message,
    'Updated 2 and removed 1 line items from Hardware calculator and Licence calculator. Review them, then create the quote.',
  );
});

test('manually added line items are never touched', async () => {
  const { hubspot, sync } = setup();
  const manualId = hubspot.addLineItem('7', { hs_product_id: '99', quantity: '1', name: 'Delivery' });
  await sync.syncDeal('7');
  Object.assign(hubspot.deals.get('7').properties, { rooms: '', users: '' });
  await sync.syncDeal('7');

  assert.deepEqual(hubspot.dealLineItems('7').map((li) => li.id), [manualId]);
});

test('team edits outside the managed fields survive a re-sync', async () => {
  const { hubspot, sync } = setup();
  await sync.syncDeal('7');
  const seats = hubspot.dealLineItems('7').find((li) => li.properties.calc_line_key === 'licences:seats');
  seats.properties.hs_discount_percentage = '10';
  hubspot.deals.get('7').properties.users = '90';
  await sync.syncDeal('7');

  assert.equal(seats.properties.quantity, '90');
  assert.equal(seats.properties.hs_discount_percentage, '10');
});

test('a product change replaces the line item', async () => {
  const config = structuredClone(CONFIG);
  const { hubspot, sync } = setup({}, { config });
  await sync.syncDeal('7');
  const oldId = hubspot.dealLineItems('7').find((li) => li.properties.calc_line_key === 'hardware:mounts').id;

  config.calculators[0].lineItems[1].product.sku = 'HW-MOUNT-PRO';
  const sync2 = new LineItemSync({ hubspot, config: parseConfig(config), products: new ProductResolver(hubspot) });
  const result = await sync2.syncDeal('7');

  const mounts = hubspot.dealLineItems('7').filter((li) => li.properties.calc_line_key === 'hardware:mounts');
  assert.equal(mounts.length, 1);
  assert.notEqual(mounts[0].id, oldId);
  assert.equal(mounts[0].properties.hs_product_id, '4');
  assert.match(result.message, /^Swapped the product on 1 line item from Hardware calculator\./);
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
  const { hubspot, sync, lines } = setup({ users: '', rooms: '' });
  hubspot.addLineItem('7', { calc_line_key: 'licences:seats', hs_product_id: '3', quantity: '5' });
  hubspot.addLineItem('7', { calc_line_key: 'licences:seats', hs_product_id: '3', quantity: '5' });
  hubspot.deals.get('7').properties.users = '5';

  const result = await sync.syncDeal('7');
  assert.equal(lines().length, 1);
  assert.match(result.message, /Removed 1 duplicate\./);
});

test('missing calculator inputs: nothing changes and the deal says why', async () => {
  const { hubspot, sync, deal } = setup({ unit_rate: '' });
  const result = await sync.syncDeal('7');

  assert.equal(result.outcome, 'error');
  assert.deepEqual(hubspot.writeCalls(), []);
  assert.equal(deal().calc_line_items_status, 'error');
  assert.match(deal().calc_line_items_message, /Hardware calculator › units: unitPrice: deal property "unit_rate" is empty/);
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
  hubspot.deals.get('7').properties.users = '120';

  const result = await sync.syncDeal('7');
  assert.equal(result.outcome, 'skipped');
  assert.equal(lines().find((l) => l.key === 'licences:seats').quantity, '80');
  assert.match(deal().calc_line_items_message, /already has a quote/);
});

test('deals outside syncWhen are skipped without writing anything', async () => {
  const { hubspot, sync } = setup({ dealstage: 'closedwon' });
  const result = await sync.syncDeal('7');
  assert.equal(result.outcome, 'skipped');
  assert.deepEqual(hubspot.calls.map((c) => c.name), ['getDeal']);
});

test('deals no calculator applies to are left untouched', async () => {
  const { hubspot, sync } = setup({ rooms: '', users: '' });
  const result = await sync.syncDeal('7');
  assert.equal(result.outcome, 'noop');
  assert.deepEqual(hubspot.calls.filter((c) => c.name === 'updateDeal'), []);
});

test('an error is cleared once the inputs are fixed', async () => {
  const { hubspot, sync, deal } = setup({ unit_rate: '' });
  await sync.syncDeal('7');
  hubspot.deals.get('7').properties.unit_rate = '9.5';
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
  const mounts = hubspot.dealLineItems('7').find((li) => li.properties.calc_line_key === 'hardware:mounts');
  hubspot.lineItems.delete(mounts.id);
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
  const config = { ...structuredClone(CONFIG), settings: { syncWhen: 'rooms * missing > 0' } };
  const { hubspot, sync, deal } = setup({}, { config });
  const result = await sync.syncDeal('7');
  assert.equal(result.outcome, 'error');
  assert.deepEqual(hubspot.writeCalls(), []);
  assert.match(deal().calc_line_items_message, /settings\.syncWhen: deal property "missing" is empty/);
});

test('deals no calculator applies to cost a single read', async () => {
  const { hubspot, sync } = setup({ rooms: '', users: '', calc_line_items_frozen: 'true' });
  assert.equal((await sync.syncDeal('7')).outcome, 'noop');
  assert.deepEqual(hubspot.calls.map((c) => c.name), ['getDeal']);
});

test('an unchanged status is not written again', async () => {
  // Each write changes the deal's last-modified time, so rewriting the same
  // status would make the poller pick the deal up forever.
  const { hubspot, sync } = setup({ calc_line_items_frozen: 'true' });
  await sync.syncDeal('7');
  await sync.syncDeal('7');
  assert.equal(hubspot.calls.filter((c) => c.name === 'updateDeal').length, 1);

  const quoted = setup();
  await quoted.sync.syncDeal('7');
  quoted.hubspot.quotes.set('7', ['555']);
  quoted.hubspot.deals.get('7').properties.users = '120';
  await quoted.sync.syncDeal('7');
  await quoted.sync.syncDeal('7');
  assert.equal(quoted.hubspot.calls.filter((c) => c.name === 'updateDeal').length, 2, 'synced once, skipped once');

  const broken = setup({ unit_rate: '' });
  await broken.sync.syncDeal('7');
  await broken.sync.syncDeal('7');
  assert.equal(broken.hubspot.calls.filter((c) => c.name === 'updateDeal').length, 1);
});

test('a new calculator added to the config is picked up on the next sync', async () => {
  const { hubspot, sync, lines } = setup();
  await sync.syncDeal('7');
  const config = structuredClone(CONFIG);
  config.calculators.push({
    id: 'training',
    name: 'Training calculator',
    appliesWhen: 'trainees > 0',
    lineItems: [{ key: 'places', product: { sku: 'TRN-PLACE' }, quantity: 'trainees', unitPrice: 150 }],
  });
  hubspot.products.push({ id: '5', properties: { hs_sku: 'TRN-PLACE', name: 'Training place', price: '0' } });
  hubspot.deals.get('7').properties.trainees = '4';
  const withTraining = new LineItemSync({ hubspot, config: parseConfig(config), products: new ProductResolver(hubspot) });

  const result = await withTraining.syncDeal('7');
  assert.equal(result.outcome, 'synced');
  assert.match(result.message, /^Added 1 line item from Training calculator\./);
  assert.deepEqual(lines().find((l) => l.key === 'training:places'), { key: 'training:places', product: '5', quantity: '4', price: '150' });
  assert.equal(lines().length, 4);
});

test('a line is only re-applied when its own calculated values change', async () => {
  // The team edits the seats quantity by hand. Then the hardware lines change,
  // and later a new calculator starts applying to the deal: the edit survives.
  const { hubspot, sync } = setup();
  await sync.syncDeal('7');
  const seats = hubspot.dealLineItems('7').find((li) => li.properties.calc_line_key === 'licences:seats');
  seats.properties.quantity = '75';

  hubspot.deals.get('7').properties.rooms = '7';
  const result = await sync.syncDeal('7');
  assert.equal(result.outcome, 'synced');
  assert.match(result.message, /^Updated 2 line items from Hardware calculator\./);
  assert.equal(seats.properties.quantity, '75');

  const config = structuredClone(CONFIG);
  config.calculators.push({ id: 'training', name: 'Training calculator', appliesWhen: 'trainees > 0', lineItems: [{ key: 'places', product: { id: '1' }, quantity: 'trainees' }] });
  hubspot.deals.get('7').properties.trainees = '3';
  const withTraining = new LineItemSync({ hubspot, config: parseConfig(config), products: new ProductResolver(hubspot) });
  await withTraining.syncDeal('7');
  assert.equal(seats.properties.quantity, '75');
  assert.equal(hubspot.dealLineItems('7').length, 4);

  // When the seats output itself changes, the line is re-applied.
  hubspot.deals.get('7').properties.users = '90';
  await withTraining.syncDeal('7');
  assert.equal(seats.properties.quantity, '90');
});

test('lines from calculators no longer in the config are left alone', async () => {
  const { hubspot, sync } = setup();
  await sync.syncDeal('7');
  const config = structuredClone(CONFIG);
  config.calculators = config.calculators.filter((c) => c.id !== 'licences');
  const withoutLicences = new LineItemSync({ hubspot, config: parseConfig(config), products: new ProductResolver(hubspot) });

  hubspot.deals.get('7').properties.rooms = '8';
  const result = await withoutLicences.syncDeal('7', { force: true });
  assert.equal(result.outcome, 'synced');
  assert.deepEqual(result.plan.orphans.map((o) => o.key), ['licences:seats']);
  assert.ok(hubspot.dealLineItems('7').some((li) => li.properties.calc_line_key === 'licences:seats'));
});

test('a deploy that loads no calculators cannot strip line items', async () => {
  const { hubspot, sync } = setup();
  await sync.syncDeal('7');
  const empty = new LineItemSync({ hubspot, config: parseConfig({ calculators: [] }), products: new ProductResolver(hubspot) });
  hubspot.deals.get('7').properties.rooms = '9';
  await empty.syncDeal('7');
  await empty.syncDeal('7', { force: true });
  assert.equal(hubspot.dealLineItems('7').length, 3);
  assert.deepEqual(hubspot.writeCalls().filter((c) => c.name === 'archiveLineItems'), []);
});

test('if the status cannot be saved after changing lines, the sync asks to be retried', async () => {
  const { hubspot, sync, deal } = setup();
  hubspot.failUpdateDeal = () => {
    throw Object.assign(new Error('HubSpot PATCH failed (503)'), { status: 503 });
  };
  const result = await sync.syncDeal('7');
  assert.equal(result.outcome, 'error');
  assert.equal(result.retry, true);
  assert.equal(hubspot.dealLineItems('7').length, 3, 'lines were created');
  assert.equal(deal().calc_line_items_status, undefined);

  hubspot.failUpdateDeal = null;
  const retried = await sync.syncDeal('7');
  assert.equal(retried.outcome, 'unchanged');
  assert.equal(deal().calc_line_items_status, 'synced');
  assert.equal(hubspot.dealLineItems('7').length, 3, 'no duplicates on retry');
});

test('read failures ask to be retried, except for deleted deals', async () => {
  const { hubspot, sync } = setup();
  hubspot.getDeal = async () => {
    const { HubSpotError } = await import('../src/hubspot.js');
    throw new HubSpotError({ status: 502, method: 'GET', path: '/deals/7', body: 'bad gateway' });
  };
  assert.equal((await sync.syncDeal('7')).retry, true);
  hubspot.getDeal = async () => {
    const { HubSpotError } = await import('../src/hubspot.js');
    throw new HubSpotError({ status: 404, method: 'GET', path: '/deals/7', body: { message: 'not found' } });
  };
  assert.equal((await sync.syncDeal('7')).retry, false);
});

test('--force removes stale calculator lines even from a deal with no status', async () => {
  const { hubspot, sync } = setup({ rooms: '', users: '' });
  hubspot.addLineItem('7', { calc_line_key: 'hardware:units', hs_product_id: '1', quantity: '3' });
  assert.equal((await sync.syncDeal('7')).outcome, 'noop');
  assert.equal(hubspot.dealLineItems('7').length, 1);
  assert.equal((await sync.syncDeal('7', { force: true })).outcome, 'synced');
  assert.equal(hubspot.dealLineItems('7').length, 0);
});

test('a fingerprint in an older format means every line is re-checked', async () => {
  const { hubspot, sync, deal } = setup();
  await sync.syncDeal('7');
  hubspot.deals.get('7').properties.calc_line_items_fingerprint = '0123456789abcdef0123456789abcdef';
  const result = await sync.syncDeal('7');
  assert.equal(result.outcome, 'unchanged');
  assert.match(deal().calc_line_items_fingerprint, /^v2;/);
  assert.equal(hubspot.dealLineItems('7').length, 3);
});
