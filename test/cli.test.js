import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadConfig } from '../src/config-loader.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

async function cli(args, configDir) {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [CLI, ...args], {
      cwd: configDir,
      env: { PATH: process.env.PATH, CONFIG_DIR: configDir },
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.code, stdout: err.stdout + err.stderr };
  }
}

async function emptyConfig() {
  const dir = await mkdtemp(join(tmpdir(), 'calc-cli-'));
  tempDirs.push(dir);
  await mkdir(join(dir, 'calculators'));
  return dir;
}

test('new-calculator creates a starter file that check then validates', async () => {
  const dir = await emptyConfig();
  const created = await cli(['new-calculator', 'training', 'Training', 'calculator'], dir);
  assert.equal(created.code, 0, created.stdout);
  const file = JSON.parse(await readFile(join(dir, 'calculators', 'training.json'), 'utf8'));
  assert.equal(file.id, 'training');
  assert.equal(file.name, 'Training calculator');

  const config = await loadConfig(dir);
  assert.deepEqual(config.calculators.map((c) => c.id), ['training']);

  const checked = await cli(['check'], dir);
  assert.equal(checked.code, 0, checked.stdout);
  assert.match(checked.stdout, /1 calculator\(s\)/);
});

test('new-calculator refuses duplicates and bad ids', async () => {
  const dir = await emptyConfig();
  await writeFile(join(dir, 'calculators', 'other-name.json'), JSON.stringify({ id: 'training', lineItems: [{ key: 'a', product: { id: '1' }, quantity: 1 }] }));
  assert.match((await cli(['new-calculator', 'training'], dir)).stdout, /already exists/);
  assert.match((await cli(['new-calculator', 'no spaces'], dir)).stdout, /must be letters, numbers/);
});

test('check with no calculators explains how to add one', async () => {
  const result = await cli(['check'], await emptyConfig());
  assert.equal(result.code, 0);
  assert.match(result.stdout, /No calculators yet/);
  assert.match(result.stdout, /new-calculator/);
});

test('check fails clearly when the calculators folder is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'calc-cli-'));
  tempDirs.push(dir);
  const result = await cli(['check'], dir);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /calculators folder not found/);
});

test('check warns about a calculator that applies to every deal', async () => {
  const dir = await emptyConfig();
  await writeFile(join(dir, 'calculators', 'fee.json'), JSON.stringify({ id: 'fee', lineItems: [{ key: 'setup', product: { id: '1' }, quantity: 1 }] }));
  const result = await cli(['check'], dir);
  assert.match(result.stdout, /fee adds line items to every deal/);
});

// A tiny HubSpot stand-in for the token and property checks.
async function withFakeHubSpot({ scopes, status = 200, dealProperties = null, products = [], deals = {}, lineItems = {} }, fn) {
  const { createServer } = await import('node:http');
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/oauth/v2/private-apps/get/access-token-info') {
      return status === 200 ? send(200, { hubId: 4242, appId: 77, userId: 1, scopes }) : send(status, { message: 'Authentication credentials not found' });
    }
    if (path.startsWith('/crm/properties/2026-09/')) {
      if (!dealProperties) return send(403, { message: 'This app hasn\'t been granted all required scopes', category: 'MISSING_SCOPES' });
      return send(200, { results: path.endsWith('/deals') ? dealProperties : [{ name: 'calc_line_key' }] });
    }
    if (path === '/crm/objects/2026-09/products' && req.method === 'GET') return send(200, { results: products });
    if (path === '/crm/objects/2026-09/products/search') return send(200, { results: products });
    const dealPath = path.match(/^\/crm\/objects\/2026-09\/deals\/(\d+)$/);
    if (dealPath) return deals[dealPath[1]] ? send(200, { id: dealPath[1], properties: deals[dealPath[1]] }) : send(404, { message: 'Not found' });
    if (path === '/crm/associations/2026-09/deals/line_items/batch/read') {
      return send(200, { results: Object.keys(deals).map((id) => ({ from: { id }, to: Object.keys(lineItems).map((toObjectId) => ({ toObjectId })) })) });
    }
    if (path === '/crm/objects/2026-09/line_items/batch/read') {
      return send(200, { results: Object.entries(lineItems).map(([id, properties]) => ({ id, properties })) });
    }
    send(404, { message: 'not in this fake' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

async function cliWithToken(args, configDir, baseUrl) {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [CLI, ...args], {
      cwd: configDir,
      env: { PATH: process.env.PATH, CONFIG_DIR: configDir, HUBSPOT_ACCESS_TOKEN: 'pat-eu1-secret-token-value', HUBSPOT_API_BASE_URL: baseUrl },
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.code, stdout: err.stdout + err.stderr };
  }
}

const ALL_SCOPES = [
  'crm.objects.deals.read', 'crm.objects.deals.write', 'crm.objects.line_items.read', 'crm.objects.line_items.write',
  'crm.objects.quotes.read', 'e-commerce', 'crm.schemas.deals.read', 'crm.schemas.deals.write', 'crm.schemas.line_items.read',
];

test('check reports the token\'s account and that it has every permission, before any calculator exists', async () => {
  await withFakeHubSpot({ scopes: ALL_SCOPES }, async (base) => {
    const result = await cliWithToken(['check'], await emptyConfig(), base);
    assert.equal(result.code, 0, result.stdout);
    assert.match(result.stdout, /Token works: HubSpot account 4242, app 77/);
    assert.match(result.stdout, /Token has every permission the service needs/);
    assert.doesNotMatch(result.stdout, /secret-token-value/, 'never prints the token');
  });
});

test('check names the permissions a token is missing', async () => {
  const scopes = ALL_SCOPES.filter((s) => s !== 'crm.objects.line_items.write' && s !== 'crm.schemas.deals.write');
  await withFakeHubSpot({ scopes }, async (base) => {
    const result = await cliWithToken(['check'], await emptyConfig(), base);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /missing permissions the service needs: crm\.objects\.line_items\.write \(create, update and remove line items\)/);
    assert.match(result.stdout, /missing permissions for "npm run setup".*crm\.schemas\.deals\.write/);
  });
});

test('check says clearly when HubSpot rejects the token', async () => {
  await withFakeHubSpot({ status: 401 }, async (base) => {
    const result = await cliWithToken(['check'], await emptyConfig(), base);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /HubSpot rejected the access token \(401\)/);
  });
});

test('check skips property checks (instead of stopping) when the token can\'t read properties', async () => {
  const dir = await emptyConfig();
  await writeFile(join(dir, 'calculators', 'fee.json'), JSON.stringify({ id: 'fee', appliesWhen: 'seats > 0', lineItems: [{ key: 'x', product: { sku: 'FEE' }, quantity: 'seats' }] }));
  const scopes = ALL_SCOPES.filter((s) => !s.startsWith('crm.schemas'));
  const products = [{ id: '5', properties: { name: 'Fee', hs_sku: 'FEE', price: '10' } }];
  await withFakeHubSpot({ scopes, products }, async (base) => {
    const result = await cliWithToken(['check'], dir, base);
    assert.match(result.stdout, /Skipped checking deal properties: the token lacks crm\.schemas\.deals\.read/);
    assert.match(result.stdout, /SKU FEE → product 5/);
    assert.equal(result.code, 0, result.stdout);
  });
});

test('inspect lists custom deal properties and products', async () => {
  const dealProperties = [
    { name: 'dealname', label: 'Deal name', type: 'string', fieldType: 'text', groupName: 'dealinformation', hubspotDefined: true },
    { name: 'licence_seats', label: 'Seats', type: 'number', fieldType: 'number', groupName: 'calculator' },
    { name: 'support_tier', label: 'Support tier', type: 'enumeration', fieldType: 'select', groupName: 'calculator', options: [{ value: 'standard' }, { value: 'premium' }] },
    { name: 'pricing_status', label: 'Pricing status', type: 'enumeration', fieldType: 'select', groupName: 'calculator', options: [{ label: 'Add line items', value: 'add_line_items' }, { label: 'Line items added', value: 'line_items_added' }] },
    { name: 'calc_line_items_status', label: 'Calculator line items: status', type: 'enumeration', fieldType: 'select', groupName: 'dealinformation' },
  ];
  const products = [{ id: '5', properties: { name: 'Licence seat', hs_sku: 'LIC-SEAT', price: '15' } }, { id: '6', properties: { name: 'Setup', price: '100' } }];
  await withFakeHubSpot({ scopes: ALL_SCOPES, dealProperties, products }, async (base) => {
    const result = await cliWithToken(['inspect'], await emptyConfig(), base);
    assert.equal(result.code, 0, result.stdout);
    assert.match(result.stdout, /licence_seats\s+Seats\s+number\/number/);
    assert.match(result.stdout, /support_tier .*options: standard, premium/);
    assert.match(result.stdout, /pricing_status .*options: Add line items \(add_line_items\), Line items added \(line_items_added\)/);
    assert.doesNotMatch(result.stdout, /dealname|calc_line_items_status/);
    assert.match(result.stdout, /Licence seat\s+SKU LIC-SEAT/);
    assert.match(result.stdout, /1 product\(s\) have no SKU/);
  });
});

test('inspect explains a missing permission', async () => {
  await withFakeHubSpot({ scopes: [] }, async (base) => {
    const result = await cliWithToken(['inspect'], await emptyConfig(), base);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /lacks crm\.schemas\.deals\.read/);
  });
});

test('webhooks lists syncWhen properties too, so opening the gate triggers a sync', async () => {
  const dir = await emptyConfig();
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ syncWhen: 'pricing_status == "add_line_items"' }));
  await writeFile(join(dir, 'calculators', 'lic.json'), JSON.stringify({ id: 'lic', appliesWhen: 'seats > 0', lineItems: [{ key: 's', product: { id: '1' }, quantity: 'seats' }] }));
  const result = await cli(['webhooks'], dir);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^ {2}pricing_status$/m);
  assert.match(result.stdout, /^ {2}seats$/m);
});

test('check validates settings.afterSync against the property\'s options', async () => {
  const dir = await emptyConfig();
  await writeFile(join(dir, 'calculators', 'lic.json'), JSON.stringify({ id: 'lic', appliesWhen: 'seats > 0', lineItems: [{ key: 's', product: { sku: 'SEAT' }, quantity: 'seats' }] }));
  const status = { name: 'pricing_status', type: 'enumeration', fieldType: 'select', options: [{ value: 'add_line_items' }, { value: 'line_items_added' }] };
  const dealProperties = [{ name: 'seats', type: 'number' }, status, ...['calc_line_items_status', 'calc_line_items_message', 'calc_line_items_synced_at', 'calc_line_items_fingerprint', 'calc_line_items_frozen'].map((name) => ({ name }))];
  const products = [{ id: '5', properties: { name: 'Seat', hs_sku: 'SEAT', price: '10' } }];
  const settings = (afterSync) => writeFile(join(dir, 'settings.json'), JSON.stringify({ syncWhen: 'pricing_status == "add_line_items"', afterSync }));
  await withFakeHubSpot({ scopes: ALL_SCOPES, dealProperties, products }, async (base) => {
    await settings({ pricing_status: 'line_items_added' });
    const good = await cliWithToken(['check'], dir, base);
    assert.equal(good.code, 0, good.stdout);
    assert.match(good.stdout, /After each sync: sets pricing_status = line_items_added, so later changes wait/);

    await settings({ pricing_status: 'Line items added' });
    const bad = await cliWithToken(['check'], dir, base);
    assert.equal(bad.code, 1);
    assert.match(bad.stdout, /"Line items added" isn't one of pricing_status's options \(internal values: add_line_items, line_items_added\)/);

    await settings({ pricing_status: 'add_line_items' });
    assert.match((await cliWithToken(['check'], dir, base)).stdout, /doesn't turn settings\.syncWhen off/);

    // A property the gate doesn't read can't switch it off.
    await settings({ seats_checked: true });
    assert.match((await cli(['check'], dir)).stdout, /doesn't turn settings\.syncWhen off/);

    // A gate that is open while the property is blank is never "given".
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ syncWhen: 'line_items_added != true', afterSync: { line_items_added: true } }));
    assert.match((await cli(['check'], dir)).stdout, /will never be set/);

    // Gates that also read other properties.
    const gate = async (syncWhen, afterSync) => {
      await writeFile(join(dir, 'settings.json'), JSON.stringify({ syncWhen, afterSync }));
      return (await cli(['check'], dir)).stdout;
    };
    assert.match(await gate('pricing_status == "add_line_items" && dealstage != "closedlost"', { pricing_status: 'line_items_added' }), /so later changes wait/);
    assert.match(await gate('pricing_status == "add_line_items" && seats_confirmed', { pricing_status: 'add_line_items' }), /doesn't turn settings\.syncWhen off/);
    assert.match(await gate('pricing_status == "validated" && line_items_added != true', { line_items_added: true }), /will never be set/);
  });
});

test('inspect <deal> shows one group of a deal\'s values and its line items', async () => {
  const dealProperties = [
    { name: 'pricing_hoarding_product', label: 'Hoarding product', type: 'string', groupName: 'pvc_pricing_calculator' },
    { name: 'pricing_hoarding_quantity', label: 'Hoarding quantity', type: 'number', groupName: 'pvc_pricing_calculator' },
    { name: 'pricing_single_doors', label: 'Single doors', type: 'number', groupName: 'pvc_pricing_calculator' },
    { name: 'unific_billing_city', label: 'Billing City', type: 'string', groupName: 'billing' },
  ];
  const deals = { 42: { pricing_hoarding_product: 'HOARD-24', pricing_hoarding_quantity: '120', pricing_single_doors: '', unific_billing_city: 'Leeds' } };
  const lineItems = { 9: { name: '2.4m hoarding hire per metre/week', hs_sku: 'HOARD-24', quantity: '120', price: '6', amount: '720' } };
  await withFakeHubSpot({ scopes: ALL_SCOPES, dealProperties, deals, lineItems }, async (base) => {
    const result = await cliWithToken(['inspect', '42', '--group', 'pvc_pricing_calculator'], await emptyConfig(), base);
    assert.equal(result.code, 0, result.stdout);
    assert.match(result.stdout, /pricing_hoarding_product\s+HOARD-24/);
    assert.match(result.stdout, /pricing_hoarding_quantity\s+120/);
    assert.doesNotMatch(result.stdout, /pricing_single_doors|Leeds/, 'blank values and other groups are left out');
    assert.match(result.stdout, /Line items on the deal: 1/);
    assert.match(result.stdout, /2\.4m hoarding hire per metre\/week\s+SKU HOARD-24\s+qty 120\s+price 6\s+amount 720/);

    const missing = await cliWithToken(['inspect', '43', '--group', 'pvc_pricing_calculator'], await emptyConfig(), base);
    assert.match(missing.stdout, /Deal 43 not found/);
  });
});
