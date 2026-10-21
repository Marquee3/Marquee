import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';
import { HubSpotError } from '../src/hubspot.js';
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

test('a syncWhen gate on a dropdown: nothing until it opens, and closing it freezes the lines', async () => {
  const config = { ...structuredClone(CONFIG), settings: { syncWhen: 'pricing_status == "add_line_items"' } };
  const { hubspot, sync, lines } = setup({ pricing_status: 'in_progress' }, { config });
  await sync.syncDeal('7');
  assert.deepEqual(lines(), []);
  assert.deepEqual(hubspot.calls.filter((c) => c.name === 'updateDeal'), [], 'not even a status');

  hubspot.editDeal('7', { pricing_status: 'add_line_items' });
  assert.equal((await sync.syncDeal('7')).outcome, 'synced');
  assert.equal(lines().find((l) => l.key === 'licences:seats').quantity, '80');

  // Moved on (e.g. by a workflow): calculator changes no longer reach the lines.
  hubspot.editDeal('7', { pricing_status: 'line_items_added', users: '95' });
  assert.equal((await sync.syncDeal('7')).outcome, 'skipped');
  assert.equal(lines().find((l) => l.key === 'licences:seats').quantity, '80');

  hubspot.editDeal('7', { pricing_status: 'add_line_items' });
  assert.equal((await sync.syncDeal('7')).outcome, 'synced');
  assert.equal(lines().find((l) => l.key === 'licences:seats').quantity, '95');
});

const GATED = {
  ...structuredClone(CONFIG),
  settings: { syncWhen: 'pricing_status == "add_line_items"', afterSync: { pricing_status: 'line_items_added' } },
};
const seats = (lines) => lines.find((l) => l.key === 'licences:seats').quantity;
const dealWrites = (hubspot) => hubspot.calls.filter((c) => c.name === 'updateDeal');

test('afterSync moves the go-ahead on in the same update, so later changes wait for the next one', async () => {
  const { hubspot, sync, deal, lines } = setup({ pricing_status: 'add_line_items' }, { config: GATED });
  const first = await sync.syncDeal('7');
  assert.equal(first.outcome, 'synced');
  assert.deepEqual(first.afterSync, { pricing_status: 'line_items_added' });
  assert.equal(dealWrites(hubspot).length, 1, 'status and afterSync in one update');
  assert.equal(deal().pricing_status, 'line_items_added');
  assert.equal(deal().calc_line_items_status, 'synced');

  // Edited after the go-ahead: held back.
  hubspot.editDeal('7', { users: '95' });
  assert.equal((await sync.syncDeal('7')).outcome, 'skipped');
  assert.equal(seats(lines()), '80');

  // Go-ahead given again: applied, and moved on again.
  hubspot.editDeal('7', { pricing_status: 'add_line_items' });
  assert.equal((await sync.syncDeal('7')).outcome, 'synced');
  assert.equal(seats(lines()), '95');
  assert.equal(deal().pricing_status, 'line_items_added');

  // Go-ahead given with nothing to change: still moved on, line items untouched.
  hubspot.editDeal('7', { pricing_status: 'add_line_items' });
  hubspot.calls.length = 0;
  const again = await sync.syncDeal('7');
  assert.equal(again.outcome, 'unchanged');
  assert.equal(deal().pricing_status, 'line_items_added');
  assert.deepEqual(hubspot.calls.map((c) => c.name), ['getDeal', 'getDeal', 'updateDeal'], 're-read just before using up the go-ahead');
});

test('afterSync is not set when line items could not be applied', async () => {
  const { sync, deal } = setup({ pricing_status: 'add_line_items', unit_rate: '' }, { config: GATED });
  assert.equal((await sync.syncDeal('7')).outcome, 'error');
  assert.equal(deal().pricing_status, 'add_line_items');
});

test('a dry run reports the afterSync values without writing them', async () => {
  const { hubspot, sync } = setup({ pricing_status: 'add_line_items' }, { config: GATED });
  const result = await sync.syncDeal('7', { dryRun: true });
  assert.deepEqual(result.afterSync, { pricing_status: 'line_items_added' });
  assert.deepEqual(dealWrites(hubspot), []);
});

test('an afterSync value HubSpot refuses is shown on the deal, and not rewritten on every retry', async () => {
  const { hubspot, sync, deal, lines } = setup({ pricing_status: 'add_line_items' }, { config: GATED });
  hubspot.failUpdateDeal = async (_, properties) => {
    if ('pricing_status' in properties) {
      throw new HubSpotError({ status: 400, method: 'PATCH', path: '/crm/objects/2026-09/deals/7', body: { message: 'line_items_added was not one of the allowed options' } });
    }
  };
  const result = await sync.syncDeal('7');
  assert.equal(result.outcome, 'error');
  assert.match(result.message, /settings\.afterSync could not be saved: .*allowed options/);
  assert.equal(deal().calc_line_items_status, 'error');
  assert.match(deal().calc_line_items_message, /afterSync could not be saved/);
  assert.ok(deal().calc_line_items_fingerprint, 'what was applied is remembered');
  const applied = lines();

  const writes = dealWrites(hubspot).length;
  const lineWrites = hubspot.writeCalls().length;
  assert.equal((await sync.syncDeal('7')).outcome, 'error');
  assert.equal(dealWrites(hubspot).length, writes + 1, 'only the refused attempt; nothing new to show');
  assert.equal(hubspot.writeCalls().length, lineWrites, 'line items left alone');
  assert.deepEqual(lines(), applied);
});

test('a go-ahead on a deal with no calculator lines is used up too', async () => {
  const { hubspot, sync, deal, lines } = setup({ pricing_status: 'add_line_items', rooms: '', users: '' }, { config: GATED });
  assert.equal((await sync.syncDeal('7')).outcome, 'unchanged');
  assert.equal(deal().pricing_status, 'line_items_added');
  assert.match(deal().calc_line_items_message, /No calculator applies/);
  // A later, unvalidated change waits.
  hubspot.editDeal('7', { users: '5' });
  assert.equal((await sync.syncDeal('7')).outcome, 'skipped');
  assert.deepEqual(lines(), []);
});

test('a repeated go-ahead keeps the deal\'s message', async () => {
  const { hubspot, sync, deal } = setup({ pricing_status: 'add_line_items' }, { config: GATED });
  await sync.syncDeal('7');
  const message = deal().calc_line_items_message;
  hubspot.editDeal('7', { pricing_status: 'add_line_items' });
  await sync.syncDeal('7');
  assert.equal(deal().pricing_status, 'line_items_added');
  assert.equal(deal().calc_line_items_message, message);
});

test('afterSync is left for the next sync if the deal changes while syncing', async () => {
  const { hubspot, sync, deal, lines } = setup({ pricing_status: 'add_line_items' }, { config: GATED });
  hubspot.beforeCreate = async () => {
    hubspot.beforeCreate = null;
    hubspot.editDeal('7', { users: '95' }); // e.g. the calculator saving again, already validated
  };
  const first = await sync.syncDeal('7');
  assert.equal(first.outcome, 'synced');
  assert.equal(first.afterSync, undefined);
  assert.equal(deal().pricing_status, 'add_line_items', 'go-ahead not used up by output this sync did not apply');
  assert.equal((await sync.syncDeal('7')).outcome, 'synced');
  assert.equal(seats(lines()), '95');
  assert.equal(deal().pricing_status, 'line_items_added');
});

test('plan only reports afterSync when a sync would write it', async () => {
  const config = { ...structuredClone(CONFIG), settings: { afterSync: { line_items_ready: true } } };
  const { hubspot, sync } = setup({}, { config });
  await sync.syncDeal('7');
  hubspot.editDeal('7', { line_items_ready: 'false' });
  const plan = await sync.syncDeal('7', { dryRun: true });
  assert.equal(plan.afterSync, undefined);
});

test('a refused afterSync property does not suggest "npm run setup"', async () => {
  const { hubspot, sync } = setup({ pricing_status: 'add_line_items' }, { config: GATED });
  hubspot.failUpdateDeal = async (_, properties) => {
    if ('pricing_status' in properties) {
      throw new HubSpotError({ status: 400, method: 'PATCH', path: '/crm/objects/2026-09/deals/7', body: { message: 'Property "pricing_status" does not exist' } });
    }
  };
  const result = await sync.syncDeal('7');
  assert.doesNotMatch(result.message, /npm run setup/);
  assert.match(result.message, /Check the property names and values in settings\.afterSync/);
});

test('an afterSync that does not end the go-ahead is only set alongside other changes', async () => {
  const config = { ...structuredClone(CONFIG), settings: { ...CONFIG.settings, afterSync: { line_items_ready: true } } };
  const { hubspot, sync, deal } = setup({}, { config });
  await sync.syncDeal('7');
  assert.equal(deal().line_items_ready, 'true');
  // Cleared by the team (e.g. a workflow that acted on it): left cleared.
  hubspot.editDeal('7', { line_items_ready: 'false' });
  assert.equal((await sync.syncDeal('7')).outcome, 'unchanged');
  assert.equal(deal().line_items_ready, 'false');
  hubspot.editDeal('7', { users: '95' });
  await sync.syncDeal('7');
  assert.equal(deal().line_items_ready, 'true');
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
  // The lines being created are in an unknown state, so their fingerprints
  // are dropped (here: all of them, as it was the first sync).
  assert.equal(deal().calc_line_items_fingerprint, 'v2');
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

// --- Regressions from the second review -------------------------------------------

function editAndDelete(hubspot) {
  // The team sets seats to 75 by hand and deletes the mounts line.
  const items = hubspot.dealLineItems('7');
  items.find((li) => li.properties.calc_line_key === 'licences:seats').properties.quantity = '75';
  hubspot.lineItems.delete(items.find((li) => li.properties.calc_line_key === 'hardware:mounts').id);
}
const seatsQty = (hubspot) => hubspot.dealLineItems('7').find((li) => li.properties.calc_line_key === 'licences:seats')?.properties.quantity;
const hasMounts = (hubspot) => hubspot.dealLineItems('7').some((li) => li.properties.calc_line_key === 'hardware:mounts');

test('an input error and its fix leave the team\'s edits alone', async () => {
  const { hubspot, sync } = setup();
  await sync.syncDeal('7');
  editAndDelete(hubspot);
  hubspot.deals.get('7').properties.unit_rate = '';
  assert.equal((await sync.syncDeal('7')).outcome, 'error');
  hubspot.deals.get('7').properties.unit_rate = '9.5';
  const result = await sync.syncDeal('7');
  assert.equal(result.outcome, 'unchanged');
  assert.equal(seatsQty(hubspot), '75');
  assert.equal(hasMounts(hubspot), false);
});

test('a temporary HubSpot error before anything is written leaves edits alone on retry', async () => {
  const { hubspot, sync } = setup();
  await sync.syncDeal('7');
  editAndDelete(hubspot);
  hubspot.deals.get('7').properties.rooms = '7'; // hardware lines change
  const realQuotes = hubspot.getAssociatedIds.bind(hubspot);
  hubspot.getAssociatedIds = async (from, id, to, opts) => {
    if (to === 'quotes') {
      const { HubSpotError } = await import('../src/hubspot.js');
      throw new HubSpotError({ status: 429, method: 'POST', path: 'associations', body: { message: 'rate limited' } });
    }
    return realQuotes(from, id, to, opts);
  };
  const failed = await sync.syncDeal('7');
  assert.equal(failed.retry, true);
  hubspot.getAssociatedIds = realQuotes;
  await sync.syncDeal('7');
  assert.equal(seatsQty(hubspot), '75', 'seats output did not change, so the hand edit stands');
  assert.equal(hubspot.dealLineItems('7').find((li) => li.properties.calc_line_key === 'hardware:units').properties.quantity, '84');
});

test('a failure part-way through applying re-checks only the lines being changed', async () => {
  const { hubspot, sync } = setup();
  await sync.syncDeal('7');
  editAndDelete(hubspot);
  hubspot.deals.get('7').properties.rooms = '7';
  const realUpdate = hubspot.updateLineItems.bind(hubspot);
  hubspot.updateLineItems = async () => {
    throw new Error('HubSpot POST batch/update failed (502): bad gateway');
  };
  assert.equal((await sync.syncDeal('7')).outcome, 'error');
  hubspot.updateLineItems = realUpdate;
  await sync.syncDeal('7');
  assert.equal(seatsQty(hubspot), '75');
  assert.equal(hubspot.dealLineItems('7').find((li) => li.properties.calc_line_key === 'hardware:units').properties.quantity, '84');
});

test('removing and restoring a calculator file doesn\'t reset its lines', async () => {
  const { hubspot, sync } = setup();
  await sync.syncDeal('7');
  editAndDelete(hubspot);
  const withoutLicences = structuredClone(CONFIG);
  withoutLicences.calculators = withoutLicences.calculators.filter((c) => c.id !== 'licences');
  const removed = new LineItemSync({ hubspot, config: parseConfig(withoutLicences), products: new ProductResolver(hubspot) });
  hubspot.deals.get('7').properties.rooms = '7';
  await removed.syncDeal('7');
  assert.match(hubspot.deals.get('7').properties.calc_line_items_fingerprint, /licences:seats=/, 'kept for the missing calculator');

  const empty = new LineItemSync({ hubspot, config: parseConfig({ calculators: [] }), products: new ProductResolver(hubspot) });
  hubspot.calls = [];
  assert.equal((await empty.syncDeal('7')).outcome, 'unchanged', 'nothing it manages has changed');
  assert.deepEqual(hubspot.calls.map((c) => c.name), ['getDeal']);
  const forced = await empty.syncDeal('7', { force: true });
  assert.match(forced.message, /3 line items from calculators no longer in the config were left as they are/);

  const restored = await sync.syncDeal('7');
  assert.equal(restored.outcome, 'unchanged');
  assert.equal(seatsQty(hubspot), '75');
});

test('lines keep the config order when lines are added around them', async () => {
  const config = structuredClone(CONFIG);
  config.calculators[0].lineItems[0].includeWhen = 'include_units';
  const { hubspot, sync } = setup({ include_units: 'false' }, { config });
  await sync.syncDeal('7');
  const position = (key) => hubspot.dealLineItems('7').find((li) => li.properties.calc_line_key === key).properties.hs_position_on_quote;
  assert.deepEqual([position('hardware:mounts'), position('licences:seats')], ['0', '1']);
  hubspot.deals.get('7').properties.include_units = 'true';
  const result = await sync.syncDeal('7');
  assert.deepEqual([position('hardware:units'), position('hardware:mounts'), position('licences:seats')], ['0', '1', '2']);
  assert.match(result.message, /Added 1 and reordered 2 line items/);
});

test('--force never overrides a freeze', async () => {
  const { hubspot, sync } = setup({ rooms: '', users: '', calc_line_items_frozen: 'true' });
  hubspot.addLineItem('7', { calc_line_key: 'hardware:units', hs_product_id: '1', quantity: '3' });
  const result = await sync.syncDeal('7', { force: true });
  assert.equal(result.outcome, 'skipped');
  assert.equal(hubspot.dealLineItems('7').length, 1);
});

test('a status write that fails again on retry still asks for another retry', async () => {
  const { hubspot, sync } = setup();
  hubspot.failUpdateDeal = () => {
    throw Object.assign(new Error('503'), { status: 503 });
  };
  assert.equal((await sync.syncDeal('7')).retry, true);
  assert.equal((await sync.syncDeal('7')).retry, true, 'lines exist but the deal still has no status');
  hubspot.failUpdateDeal = null;
  assert.equal((await sync.syncDeal('7')).outcome, 'unchanged');
  assert.equal(hubspot.deals.get('7').properties.calc_line_items_status, 'synced');
});

test('a deal held back by a quote is not re-checked until its output changes', async () => {
  const { hubspot, sync } = setup();
  const { triage } = await import('../src/triage.js');
  const config = parseConfig(CONFIG);
  await sync.syncDeal('7');
  hubspot.quotes.set('7', ['555']);
  hubspot.deals.get('7').properties.users = '120';
  assert.equal((await sync.syncDeal('7')).outcome, 'skipped');
  assert.equal(triage(config, hubspot.deals.get('7').properties).action, 'skip', 'poller skips it now');
  hubspot.deals.get('7').properties.users = '130';
  assert.equal(triage(config, hubspot.deals.get('7').properties).action, 'sync', 'output changed again');

  // Quote deleted, then freeze ticked and unticked: the held-back change is applied.
  hubspot.quotes.delete('7');
  hubspot.deals.get('7').properties.calc_line_items_frozen = 'true';
  await sync.syncDeal('7');
  hubspot.deals.get('7').properties.calc_line_items_frozen = 'false';
  assert.equal((await sync.syncDeal('7')).outcome, 'synced');
  assert.equal(seatsQty(hubspot), '130');
});

test('a forced sync of a deal no calculator applies to writes nothing', async () => {
  const { hubspot, sync } = setup({ rooms: '', users: '' });
  assert.equal((await sync.syncDeal('7', { force: true })).outcome, 'noop');
  assert.equal(hubspot.count('updateDeal'), 0);
});

test('plan (a dry run) lists lines from removed calculators even after later syncs', async () => {
  const { hubspot, sync } = setup();
  await sync.syncDeal('7');
  const config = structuredClone(CONFIG);
  config.calculators = config.calculators.filter((c) => c.id !== 'licences');
  const without = new LineItemSync({ hubspot, config: parseConfig(config), products: new ProductResolver(hubspot) });
  hubspot.deals.get('7').properties.rooms = '7';
  await without.syncDeal('7');
  const plan = await without.syncDeal('7', { dryRun: true });
  assert.deepEqual(plan.plan.orphans.map((o) => o.key), ['licences:seats']);
  assert.equal(plan.outcome, 'unchanged');
});

test('a missing permission is reported as such, and says nothing was changed', async () => {
  const { hubspot, sync, deal } = setup();
  const { HubSpotError } = await import('../src/hubspot.js');
  const real = hubspot.getAssociatedIds.bind(hubspot);
  hubspot.getAssociatedIds = async (from, id, to, opts) => {
    if (to === 'quotes') throw new HubSpotError({ status: 403, method: 'POST', path: '/crm/associations/2026-09/deals/quotes/batch/read', body: { message: 'This app hasn\'t been granted all required scopes' } });
    return real(from, id, to, opts);
  };
  const result = await sync.syncDeal('7');
  assert.equal(result.outcome, 'error');
  assert.equal(result.retry, false);
  assert.match(result.message, /^Line items were not changed: .*\(403\).*lacks a permission.*npm run check/);
  assert.equal(hubspot.dealLineItems('7').length, 0);
  assert.equal(deal().calc_line_items_status, 'error');
});
