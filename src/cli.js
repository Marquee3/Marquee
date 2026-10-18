#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, ID_PATTERN, loadConfig } from './config.js';
import { HubSpotError } from './hubspot.js';
import { ProductResolver } from './products.js';
import { DEAL, LINE_ITEM_KEY, PROPERTY_DEFINITIONS } from './properties.js';
import { configDir, createClient, loadEnv } from './runtime.js';
import { LineItemSync } from './sync.js';
import { silentLogger } from './logger.js';

const WEBHOOKS_CONFIG_PATH = fileURLToPath(
  new URL('../hubspot-project/src/app/webhooks/webhooks-hsmeta.json', import.meta.url),
);

const USAGE = `Usage: node src/cli.js <command>

  new-calculator <id> [name]  Start a new calculator: creates config/calculators/<id>.json to fill in.
  check                       Validate the calculator config. With HUBSPOT_ACCESS_TOKEN set, also
                              check the deal properties, products and app properties in HubSpot.
  setup                       Create the deal and line item properties the app uses (safe to re-run).
  plan <dealId>               Show the line items a sync would produce and what it would change,
                              without changing anything.
  sync <dealId>... [--force]  Sync deals now. --force re-applies even if the calculator output
                              hasn't changed since the last sync.
  webhooks [--target-url URL] Optional, for instant updates: list the deal properties to subscribe
                              to. With a target URL, also write the HubSpot project webhook config.
`;

async function main(argv) {
  loadEnv();
  const [command, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith('--') && !a.includes('=')));
  const args = rest.filter((a) => !a.startsWith('--'));
  const option = (name) => {
    const inline = rest.find((a) => a.startsWith(`--${name}=`));
    if (inline) return inline.slice(name.length + 3);
    const index = rest.indexOf(`--${name}`);
    return index >= 0 ? rest[index + 1] : undefined;
  };

  switch (command) {
    case 'new-calculator':
      if (!args.length) return usage();
      return newCalculator(args[0], args.slice(1).join(' '));
    case 'check':
      return check();
    case 'setup':
      return setup();
    case 'plan':
      if (args.length !== 1) return usage();
      return plan(args[0]);
    case 'sync':
      if (!args.length) return usage();
      return sync(args, { force: flags.has('--force') });
    case 'webhooks':
      return webhooks(option('target-url') ?? process.env.PUBLIC_URL);
    default:
      return usage();
  }
}

function usage() {
  console.log(USAGE);
  return 1;
}

async function newCalculator(id, name) {
  if (!ID_PATTERN.test(id)) {
    console.error(`Calculator id "${id}" must be letters, numbers, "-" or "_" (it becomes part of each line item's key).`);
    return 1;
  }
  // A broken calculator file elsewhere shouldn't stop starting a new one.
  let existing = [];
  try {
    existing = (await loadConfig(configDir())).calculators;
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
  }
  if (existing.some((calc) => calc.id === id)) {
    console.error(`A calculator with id "${id}" already exists.`);
    return 1;
  }
  const path = join(configDir(), 'calculators', `${id}.json`);
  const template = {
    $comment:
      'Replace the placeholders with your deal property internal names and product SKUs, then run "npm run check" and "npm run plan -- <test deal id>". See README > Adding a calculator.',
    id,
    name: name || `${id} calculator`,
    appliesWhen: 'replace_with_a_deal_property > 0',
    lineItems: [
      {
        key: 'first-line',
        product: { sku: 'REPLACE-WITH-PRODUCT-SKU' },
        quantity: 'replace_with_quantity_property',
        unitPrice: 'replace_with_unit_price_property',
      },
    ],
  };
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${JSON.stringify(template, null, 2)}\n`, { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    console.error(`${path} already exists.`);
    return 1;
  }
  const shown = relative(process.cwd(), path);
  console.log(`Created ${shown.startsWith('..') ? path : shown}. Fill it in, then run "npm run check".`);
  return 0;
}

async function check() {
  const dir = configDir();
  const config = await loadConfig(dir);
  if (!config.calculators.length) {
    console.log(`No calculators yet in ${join(dir, 'calculators')}.`);
    console.log('Start one with "npm run new-calculator -- <id> <name>", or copy a file from examples/calculators/.');
    return 0;
  }
  const lineCount = config.calculators.reduce((n, c) => n + c.lineItems.length, 0);
  console.log(`✓ Config is valid: ${config.calculators.length} calculator(s), ${lineCount} line item rule(s)`);
  for (const calc of config.calculators) {
    console.log(`    ${calc.id.padEnd(20)} ${calc.name} (${calc.lineItems.length} lines, ${calc.file ?? ''})`);
  }
  console.log(`  Deal properties used: ${config.dealProperties.join(', ') || '(none)'}`);

  if (!process.env.HUBSPOT_ACCESS_TOKEN) {
    console.log('\nSet HUBSPOT_ACCESS_TOKEN to also check properties and products in HubSpot.');
    return 0;
  }

  const hubspot = client();
  let problems = 0;
  const fail = (message) => {
    problems++;
    console.log(`✗ ${message}`);
  };

  const dealProperties = new Map((await hubspot.getProperties('deals')).map((p) => [p.name, p]));
  const missing = config.dealProperties.filter((name) => !dealProperties.has(name));
  if (missing.length) fail(`Deal properties not found in HubSpot: ${missing.join(', ')}`);
  else console.log('✓ All deal properties used by the config exist');

  const calculated = config.inputProperties.filter((name) => {
    const p = dealProperties.get(name);
    return p && (p.calculated === true || String(p.fieldType).startsWith('calculation'));
  });
  if (calculated.length) {
    console.log(
      `! These are HubSpot calculation properties: ${calculated.join(', ')}. HubSpot may not send ` +
        'property-change webhooks for them, so also subscribe to the properties they are calculated from.',
    );
  }

  const appDealProps = Object.values(DEAL).filter((name) => !dealProperties.has(name));
  const lineItemProps = new Set((await hubspot.getProperties('line_items')).map((p) => p.name));
  if (appDealProps.length || !lineItemProps.has(LINE_ITEM_KEY)) {
    fail(`App properties missing: ${[...appDealProps, ...(lineItemProps.has(LINE_ITEM_KEY) ? [] : [LINE_ITEM_KEY])].join(', ')}. Run "npm run setup".`);
  } else {
    console.log('✓ App properties exist');
  }

  if (config.skus.length) {
    const { products, errors } = await new ProductResolver(hubspot).resolve(config.skus);
    errors.forEach((e) => fail(`Product: ${e}`));
    for (const [sku, product] of products) console.log(`✓ SKU ${sku} → product ${product.id} (${product.properties?.name ?? ''})`);
  }
  if (config.productIds.length) {
    const found = new Set((await hubspot.readProducts(config.productIds)).map((p) => String(p.id)));
    const notFound = config.productIds.filter((id) => !found.has(id));
    if (notFound.length) fail(`Product IDs not found: ${notFound.join(', ')}`);
    else console.log(`✓ Product IDs exist: ${config.productIds.join(', ')}`);
  }

  console.log(problems ? `\n${problems} problem(s) found.` : '\nAll checks passed.');
  return problems ? 1 : 0;
}

async function setup() {
  const hubspot = client();
  for (const [objectType, definitions] of Object.entries(PROPERTY_DEFINITIONS)) {
    let existing;
    try {
      existing = new Set((await hubspot.getProperties(objectType)).map((p) => p.name));
    } catch (err) {
      return setupFailed(err, objectType);
    }
    for (const definition of definitions) {
      if (existing.has(definition.name)) {
        console.log(`✓ ${objectType}.${definition.name} already exists`);
        continue;
      }
      try {
        await hubspot.createProperty(objectType, definition);
        console.log(`+ created ${objectType}.${definition.name} ("${definition.label}")`);
      } catch (err) {
        return setupFailed(err, objectType);
      }
    }
  }
  console.log('\nDone. Add "Calculator line items: status" to your deal views to see which deals are ready for review.');
  return 0;
}

function setupFailed(err, objectType) {
  console.error(`✗ ${err.message}`);
  if (err instanceof HubSpotError && err.status === 403) {
    console.error(
      `\nThe app's token can't manage ${objectType} properties. Either add the property-management scope ` +
        'HubSpot names in the error above and re-run, or create these properties by hand in ' +
        'Settings > Properties (definitions in src/properties.js):',
    );
    for (const [type, definitions] of Object.entries(PROPERTY_DEFINITIONS)) {
      for (const d of definitions) console.error(`  ${type}: ${d.label} (internal name ${d.name}, ${d.type}/${d.fieldType})`);
    }
  }
  return 1;
}

async function plan(dealId) {
  const engine = await engineFor();
  const result = await engine.syncDeal(dealId, { dryRun: true, force: true });
  if (result.desired) {
    console.log(`Line items the calculators produce for deal ${dealId}:`);
    if (!result.desired.length) console.log('  (none)');
    for (const line of result.desired) {
      const product = line.product.sku ? `SKU ${line.product.sku} (#${line.productId})` : `product #${line.productId}`;
      const price = line.price === null ? 'product price' : line.price;
      console.log(`  ${line.key.padEnd(28)} ${product.padEnd(32)} qty ${String(line.quantity).padEnd(8)} price ${price}${line.name ? `  "${line.name}"` : ''}`);
    }
  }
  if (result.plan) {
    const { create, update, archive, keep } = result.plan;
    console.log('\nChanges:');
    create.forEach((line) => console.log(`  + create ${line.key}`));
    update.forEach((u) => console.log(`  ~ update ${u.key} (#${u.id}): ${Object.entries(u.changes).map(([k, [from, to]]) => `${k} ${from ?? '∅'} → ${to}`).join(', ')}`));
    archive.forEach((a) => console.log(`  - remove ${a.key} (#${a.id}): ${a.reason}`));
    keep.forEach((k) => console.log(`  = keep   ${k.key} (#${k.id})`));
    if (!create.length && !update.length && !archive.length) console.log('  (no changes needed)');
  }
  console.log(`\nOutcome if synced now: ${result.outcome}\n${result.message}`);
  return result.outcome === 'error' ? 1 : 0;
}

async function sync(dealIds, { force }) {
  const engine = await engineFor();
  let failed = 0;
  for (const dealId of dealIds) {
    const result = await engine.syncDeal(dealId, { force });
    if (result.outcome === 'error') failed++;
    console.log(`${dealId}: ${result.outcome}\n  ${result.message.replace(/\n/g, '\n  ')}`);
  }
  return failed ? 1 : 0;
}

async function webhooks(targetUrl) {
  const config = await loadConfig(configDir());
  // The freeze checkbox is included so unticking it triggers a re-sync.
  const properties = [...new Set([...config.inputProperties, DEAL.frozen])].sort();
  console.log('Webhooks are optional: the service already polls HubSpot for changed deals every minute.');
  console.log('For instant updates, subscribe to "Deal: property changed" for each of these properties');
  console.log('(and re-run this after adding a calculator):');
  properties.forEach((name) => console.log(`  ${name}`));

  if (!targetUrl) {
    console.log('\nPass --target-url https://your-host to also write the HubSpot project webhook config.');
    return 0;
  }
  const url = `${targetUrl.replace(/\/+$/, '').replace(/\/webhooks\/hubspot$/, '')}/webhooks/hubspot`;
  const file = {
    uid: 'calculator_line_items_webhooks',
    type: 'webhooks',
    config: {
      settings: { targetUrl: url, maxConcurrentRequests: 5 },
      subscriptions: {
        crmObjects: [],
        legacyCrmObjects: properties.map((propertyName) => ({
          subscriptionType: 'deal.propertyChange',
          propertyName,
          active: true,
        })),
        hubEvents: [],
      },
    },
  };
  await mkdir(dirname(WEBHOOKS_CONFIG_PATH), { recursive: true });
  await writeFile(WEBHOOKS_CONFIG_PATH, `${JSON.stringify(file, null, 2)}\n`);
  console.log(`\nWrote ${WEBHOOKS_CONFIG_PATH} (target ${url}).`);
  return 0;
}

function client() {
  return createClient();
}

async function engineFor() {
  const config = await loadConfig(configDir());
  const hubspot = client();
  return new LineItemSync({ hubspot, config, products: new ProductResolver(hubspot), logger: silentLogger });
}

main(process.argv.slice(2))
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(process.env.DEBUG ? err.stack : err.message ?? err);
    process.exit(1);
  });
