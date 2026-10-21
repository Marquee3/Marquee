#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateCalculators } from './calculators.js';
import { ConfigError, ID_PATTERN } from './config.js';
import { loadConfig } from './config-loader.js';
import { ExpressionError, normalizeValues, truthy } from './expression.js';
import { HubSpotError } from './hubspot.js';
import { ProductResolver } from './products.js';
import { DEAL, LINE_ITEM_KEY, PROPERTY_DEFINITIONS, REQUIRED_SCOPES, SETUP_SCOPES } from './properties.js';
import { configDir, createClient, loadEnv } from './runtime.js';
import { findDealsWithInputs } from './sweep.js';
import { LineItemSync } from './sync.js';
import { silentLogger } from './logger.js';

const WEBHOOKS_CONFIG_PATH = fileURLToPath(
  new URL('../hubspot-project/src/app/webhooks/webhooks-hsmeta.json', import.meta.url),
);

const USAGE = `Usage: node src/cli.js <command>   (or npm run <command> -- <args>)

  new-calculator <id> [name]   Start a new calculator: creates config/calculators/<id>.json to fill in.
  check                        Validate the calculator config. With HUBSPOT_ACCESS_TOKEN set, also
                               check the deal properties, products and app properties in HubSpot.
  setup                        Create the deal and line item properties the app uses (safe to re-run).
  inspect                      List the account's custom deal properties and products (with SKUs),
                               for writing calculator files. Read-only.
  plan <dealId> [--force]      Show the line items a sync would produce and what it would change,
                               without changing anything.
  sync <dealId>...             Sync these deals now.
  sync --calculator <id>       Sync every deal that has any of that calculator's inputs filled in:
                               run once after adding a calculator, so existing deals get its lines.
  sync --all                   Sync every deal with calculator inputs or calculator line items.
       [--force] [--dry-run]   --force re-applies every line even if unchanged; --dry-run only
                               reports what would happen.
  webhooks [--target-url URL]  Optional, for instant updates: list the deal properties to subscribe
                               to. With --target-url, also write the HubSpot project webhook config.
`;

async function main(argv) {
  loadEnv();
  const [command, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith('--') && !a.includes('=')));
  const option = (name) => {
    const inline = rest.find((a) => a.startsWith(`--${name}=`));
    if (inline) return inline.slice(name.length + 3);
    const index = rest.indexOf(`--${name}`);
    return index >= 0 ? rest[index + 1] : undefined;
  };
  const valued = new Set(['--calculator', '--target-url']);
  const args = rest.filter((a, i) => !a.startsWith('--') && !valued.has(rest[i - 1]));

  switch (command) {
    case 'new-calculator':
      if (!args.length) return usage();
      return newCalculator(args[0], args.slice(1).join(' '));
    case 'check':
      return check();
    case 'setup':
      return setup();
    case 'inspect':
      return inspect();
    case 'plan':
      if (args.length !== 1) return usage();
      return plan(args[0], { force: flags.has('--force') });
    case 'sync': {
      const options = { force: flags.has('--force'), dryRun: flags.has('--dry-run') };
      if (option('calculator')) return backfill({ calculatorId: option('calculator'), ...options });
      if (flags.has('--all')) return backfill({ all: true, ...options });
      if (!args.length) return usage();
      return sync(args, options);
    }
    case 'webhooks':
      return webhooks(option('target-url'));
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
    if (!process.env.HUBSPOT_ACCESS_TOKEN) return 0;
    console.log('');
    const problems = await checkToken(client());
    return problems ? 1 : 0;
  }
  const lineCount = config.calculators.reduce((n, c) => n + c.lineItems.length, 0);
  console.log(`✓ Config is valid: ${config.calculators.length} calculator(s), ${lineCount} line item rule(s)`);
  for (const calc of config.calculators) {
    console.log(`    ${calc.id.padEnd(20)} ${calc.name} (${calc.lineItems.length} lines, ${calc.file ?? ''})`);
  }
  console.log(`  Deal properties used: ${config.dealProperties.join(', ') || '(none)'}`);

  // A calculator that produces lines (or errors) on a deal with nothing
  // filled in applies to every deal in HubSpot. Usually a missing appliesWhen.
  for (const calc of config.calculators) {
    const onEmpty = evaluateCalculators({ ...config, calculators: [calc] }, {});
    if (onEmpty.lines.length || onEmpty.errors.length) {
      const what = onEmpty.lines.length ? 'adds line items to' : 'reports "Needs attention" on';
      console.log(`! ${calc.id} ${what} every deal, even one with none of its inputs filled in. Add an "appliesWhen" if that isn't intended.`);
    }
  }

  const afterSync = Object.entries(config.settings.afterSync);
  if (afterSync.length) {
    const shown = afterSync.map(([name, value]) => `${name} = ${value === '' ? '(blank)' : value}`).join(', ');
    const outcome = afterSyncOutcome(config.settings);
    if (outcome === 'closes') console.log(`  After each sync: sets ${shown}, so later changes wait until settings.syncWhen matches again.`);
    else if (outcome === 'stays-open') console.log(`! settings.afterSync (${shown}) doesn't turn settings.syncWhen off, so it will never be set.`);
    else if (outcome === 'open-when-blank') {
      console.log(`! settings.syncWhen matches while ${afterSync.map(([name]) => name).join(', ')} is blank, so settings.afterSync will never be set: it only uses up a go-ahead someone gives.`);
    } else console.log(`  After each sync: sets ${shown} where that turns settings.syncWhen off (syncWhen also reads other properties, so check can't confirm it).`);
  }

  if (!process.env.HUBSPOT_ACCESS_TOKEN) {
    console.log('\nSet HUBSPOT_ACCESS_TOKEN to also check properties and products in HubSpot.');
    return 0;
  }

  const hubspot = client();
  console.log('');
  let problems = await checkToken(hubspot);
  const fail = (message) => {
    problems++;
    console.log(`✗ ${message}`);
  };

  // Reading property definitions needs the crm.schemas.* permissions; without
  // them, skip these checks rather than stop.
  const dealProperties = await readProperties(hubspot, 'deals', 'crm.schemas.deals.read');
  if (dealProperties) {
    const used = [...new Set([...config.dealProperties, ...afterSync.map(([name]) => name)])];
    const missing = used.filter((name) => !dealProperties.has(name));
    if (missing.length) fail(`Deal properties not found in HubSpot: ${missing.join(', ')}`);
    else console.log('✓ All deal properties used by the config exist');

    for (const [name, value] of afterSync) {
      const p = dealProperties.get(name);
      if (!p) continue;
      const options = (p.options ?? []).map((o) => o.value);
      const values = p.fieldType === 'checkbox' ? value.split(';') : [value];
      if (p.modificationMetadata?.readOnlyValue || p.calculated === true || String(p.fieldType).startsWith('calculation')) {
        fail(`settings.afterSync: ${name} is read-only in HubSpot`);
      } else if (value !== '' && options.length && !values.every((v) => options.includes(v))) {
        fail(`settings.afterSync: "${value}" isn't one of ${name}'s options (internal values: ${options.join(', ')})`);
      }
    }

    const calculated = config.inputProperties.filter((name) => {
      const p = dealProperties.get(name);
      return p && (p.calculated === true || String(p.fieldType).startsWith('calculation'));
    });
    if (calculated.length) {
      console.log(
        `! These are HubSpot calculation properties: ${calculated.join(', ')}. Polling picks up their changes, ` +
          'but HubSpot may not send webhooks for them; if you use webhooks, also subscribe to the properties they are calculated from.',
      );
    }
  }

  const lineItemProps = await readProperties(hubspot, 'line_items', 'crm.schemas.line_items.read');
  const missingApp = [
    ...(dealProperties ? Object.values(DEAL).filter((name) => !dealProperties.has(name)) : []),
    ...(lineItemProps && !lineItemProps.has(LINE_ITEM_KEY) ? [LINE_ITEM_KEY] : []),
  ];
  if (missingApp.length) fail(`App properties missing: ${missingApp.join(', ')}. Run "npm run setup", or create them by hand (see README).`);
  else if (dealProperties && lineItemProps) console.log('✓ App properties exist');

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

/**
 * How settings.afterSync works with settings.syncWhen: "closes" (it withdraws
 * a go-ahead someone gave), "stays-open" or "open-when-blank" (it is never
 * set), or "unknown" when that depends on other properties.
 */
function afterSyncOutcome({ syncWhen, afterSync }) {
  const names = Object.keys(afterSync);
  if (!syncWhen || !names.some((name) => syncWhen.identifiers.includes(name))) return 'stays-open';
  if (syncWhen.identifiers.some((name) => !names.includes(name))) return 'unknown';
  const blank = Object.fromEntries(names.map((name) => [name, null]));
  try {
    if (truthy(syncWhen.evaluate(normalizeValues(afterSync)))) return 'stays-open';
    return truthy(syncWhen.evaluate(normalizeValues(blank))) ? 'open-when-blank' : 'closes';
  } catch (err) {
    if (!(err instanceof ExpressionError)) throw err;
    return 'unknown';
  }
}

/**
 * Which HubSpot account the token belongs to, and whether it has the
 * permissions the service needs. Never prints the token. Returns the number
 * of problems found.
 */
async function checkToken(hubspot) {
  let info;
  try {
    info = await hubspot.getTokenInfo();
  } catch (err) {
    if (err instanceof HubSpotError && err.status === 401) {
      console.log('✗ HubSpot rejected the access token (401). Check HUBSPOT_ACCESS_TOKEN.');
      return 1;
    }
    console.log(`! Couldn't read this token's permissions (${err.message}). The checks below show anything it can't do.`);
    return 0;
  }
  const scopes = new Set(info?.scopes ?? []);
  console.log(`✓ Token works: HubSpot account ${info?.hubId ?? '?'}${info?.appId ? `, app ${info.appId}` : ''}`);
  const lacking = (list) => list.filter((need) => !need.any.some((scope) => scopes.has(scope)));
  const missing = lacking(REQUIRED_SCOPES);
  const missingSetup = lacking(SETUP_SCOPES);
  const describe = (list) => list.map((need) => `${need.any[0]} (${need.purpose})`).join(', ');
  if (missing.length) console.log(`✗ Token is missing permissions the service needs: ${describe(missing)}`);
  else console.log('✓ Token has every permission the service needs');
  if (missingSetup.length) {
    console.log(`! Token is missing permissions for "npm run setup" and these checks: ${describe(missingSetup)}. Add them, or create the properties by hand (see README).`);
  }
  return missing.length ? 1 : 0;
}

/** Property definitions by name, or null (with a note) if the token can't read them. */
async function readProperties(hubspot, objectType, scope) {
  try {
    return new Map((await hubspot.getProperties(objectType)).map((p) => [p.name, p]));
  } catch (err) {
    if (!(err instanceof HubSpotError && err.status === 403)) throw err;
    const what = objectType === 'deals' ? 'deal' : 'line item';
    console.log(`! Skipped checking ${what} properties: the token lacks ${scope}.`);
    return null;
  }
}

/**
 * List what's needed to write calculator files: the account's custom deal
 * properties (internal names, types) and its products (SKUs, prices).
 * Read-only. The output holds no secrets.
 */
async function inspect() {
  const hubspot = client();
  let problems = 0;

  console.log('Custom deal properties (use the internal name in calculator files):\n');
  try {
    const own = new Set(Object.values(DEAL));
    const custom = (await hubspot.getProperties('deals'))
      .filter((p) => !p.hubspotDefined && !own.has(p.name) && !p.archived)
      .sort((a, b) => String(a.groupName).localeCompare(String(b.groupName)) || a.name.localeCompare(b.name));
    if (!custom.length) console.log('  (none)');
    let group = null;
    for (const p of custom) {
      if (p.groupName !== group) {
        group = p.groupName;
        console.log(`  [${group}]`);
      }
      const kind = p.calculated || String(p.fieldType).startsWith('calculation') ? `${p.type}, calculated` : `${p.type}/${p.fieldType}`;
      const options = p.options?.length ? `  options: ${p.options.map((o) => o.value).slice(0, 12).join(', ')}${p.options.length > 12 ? ', …' : ''}` : '';
      console.log(`    ${p.name.padEnd(40)} ${String(p.label).padEnd(40)} ${kind}${options}`);
    }
  } catch (err) {
    if (!(err instanceof HubSpotError && err.status === 403)) throw err;
    problems++;
    console.log('  ✗ The token lacks crm.schemas.deals.read, so deal properties can\'t be listed.');
  }

  console.log('\nProducts (reference these by SKU in calculator files):\n');
  try {
    const products = await hubspot.listProducts();
    if (!products.length) console.log('  (none)');
    for (const p of products.sort((a, b) => String(a.properties?.name).localeCompare(String(b.properties?.name)))) {
      const sku = p.properties?.hs_sku || '(no SKU)';
      console.log(`    ${String(p.properties?.name ?? '').padEnd(44)} SKU ${String(sku).padEnd(24)} price ${p.properties?.price ?? '-'}   id ${p.id}`);
    }
    const noSku = products.filter((p) => !p.properties?.hs_sku).length;
    if (noSku) console.log(`\n  ${noSku} product(s) have no SKU: give them one, or reference them by id.`);
  } catch (err) {
    if (!(err instanceof HubSpotError && err.status === 403)) throw err;
    problems++;
    console.log('  ✗ The token lacks permission to read products (e-commerce).');
  }
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
      `\nThe app's token can't manage ${objectType} properties. Either add the property scope ` +
        'HubSpot names in the error above and re-run, or create these properties by hand in ' +
        'Settings > Properties (definitions in src/properties.js):',
    );
    for (const [type, definitions] of Object.entries(PROPERTY_DEFINITIONS)) {
      for (const d of definitions) console.error(`  ${type}: ${d.label} (internal name ${d.name}, ${d.type}/${d.fieldType})`);
    }
  }
  return 1;
}

async function plan(dealId, { force }) {
  const engine = await engineFor();
  const result = await engine.syncDeal(dealId, { dryRun: true, force });
  if (result.desired) {
    console.log(`Line items the calculators produce for deal ${dealId}:`);
    if (!result.desired.length) console.log('  (none)');
    for (const line of result.desired) {
      const product = line.product.sku ? `SKU ${line.product.sku}${line.productId ? ` (#${line.productId})` : ''}` : `product #${line.product.id}`;
      const price = line.price === null ? 'product price' : line.price;
      console.log(`  ${line.key.padEnd(28)} ${product.padEnd(32)} qty ${String(line.quantity).padEnd(8)} price ${price}${line.name ? `  "${line.name}"` : ''}`);
    }
  }
  if (result.plan) {
    const { create, update, archive, keep, orphans } = result.plan;
    console.log('\nChanges:');
    create.forEach((line) => console.log(`  + create ${line.key}`));
    update.forEach((u) => console.log(`  ~ update ${u.key} (#${u.id}): ${Object.entries(u.changes).map(([k, [from, to]]) => `${k} ${from ?? '∅'} → ${to}`).join(', ')}`));
    archive.forEach((a) => console.log(`  - remove ${a.key} (#${a.id}): ${a.reason}`));
    keep.forEach((k) => console.log(`  = keep   ${k.key} (#${k.id})`));
    orphans.forEach((o) => console.log(`  ? leave  ${o.key} (#${o.id}): its calculator is no longer in the config`));
    if (!create.length && !update.length && !archive.length) console.log('  (no changes needed)');
  }
  if (result.afterSync) {
    const shown = Object.entries(result.afterSync).map(([name, value]) => `${name} = ${value === '' ? '(blank)' : value}`).join(', ');
    console.log(`\nThen sets (settings.afterSync): ${shown}`);
  }
  console.log(`\nOutcome if synced now: ${result.outcome}\n${result.message}`);
  if (!force && result.outcome === 'unchanged') console.log('(Lines are only re-applied when their calculated values change. Add --force to see a full re-apply.)');
  return result.outcome === 'error' ? 1 : 0;
}

async function sync(dealIds, { force, dryRun }) {
  const engine = await engineFor();
  let failed = 0;
  for (const dealId of dealIds) {
    const result = await engine.syncDeal(dealId, { force, dryRun });
    if (result.outcome === 'error') failed++;
    console.log(`${dealId}: ${result.outcome}${dryRun ? ' (dry run)' : ''}\n  ${result.message.replace(/\n/g, '\n  ')}`);
  }
  return failed ? 1 : 0;
}

/** Sync every deal that has a calculator's inputs filled in. */
async function backfill({ calculatorId, all, force, dryRun }) {
  const config = await loadConfig(configDir());
  let inputProperties = config.inputProperties;
  if (calculatorId) {
    const calc = config.calculators.find((c) => c.id === calculatorId);
    if (!calc) {
      console.error(`No calculator with id "${calculatorId}". Known: ${config.calculators.map((c) => c.id).join(', ') || '(none)'}`);
      return 1;
    }
    const single = { ...config, calculators: [calc] };
    inputProperties = calc.inputProperties;
    if (!inputProperties.length) {
      console.error(`${calculatorId} reads no deal properties, so there's nothing to search by. Use "sync --all".`);
      return 1;
    }
    if (evaluateCalculators(single, {}).lines.length) {
      console.log(`Note: ${calculatorId} also applies to deals with none of its inputs; those aren't found by this search.`);
    }
  }
  const hubspot = client();
  const engine = new LineItemSync({ hubspot, config, products: new ProductResolver(hubspot), logger: silentLogger });
  const counts = {};
  let failed = 0;
  const { scanned } = await findDealsWithInputs({
    hubspot,
    config,
    inputProperties,
    includeSynced: Boolean(all),
    // --force means "re-apply even if unchanged", so don't filter those out.
    skipTriage: Boolean(force),
    onDeal: async (dealId) => {
      const result = await engine.syncDeal(dealId, { force, dryRun });
      counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
      if (result.outcome === 'error') failed++;
      if (result.outcome !== 'unchanged' && result.outcome !== 'noop') {
        console.log(`${dealId}: ${result.outcome}${dryRun ? ' (dry run)' : ''} - ${result.message.split('\n')[0]}`);
      }
    },
  });
  const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing to sync';
  console.log(`\nChecked ${scanned} deal(s): ${summary}.`);
  return failed ? 1 : 0;
}

async function webhooks(targetUrl) {
  const config = await loadConfig(configDir());
  // Calculator inputs, plus the properties syncWhen reads (so opening that gate
  // triggers a sync) and the freeze checkbox (so unticking it does).
  const properties = [...new Set([...config.dealProperties, DEAL.frozen])].sort();
  console.log('Webhooks are optional while polling is on (the default): changed deals are found every minute.');
  console.log('For instant updates, subscribe to "Deal: property changed" for each of these properties,');
  console.log('and re-run this after adding a calculator. With polling off (SYNC_POLL_SECONDS=0), webhooks');
  console.log('are the only trigger, so every one of them must be subscribed:');
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
        crmObjects: properties.map((propertyName) => ({
          subscriptionType: 'object.propertyChange',
          objectType: 'deal',
          propertyName,
          active: true,
        })),
      },
    },
  };
  await mkdir(dirname(WEBHOOKS_CONFIG_PATH), { recursive: true });
  await writeFile(WEBHOOKS_CONFIG_PATH, `${JSON.stringify(file, null, 2)}\n`);
  console.log(`\nWrote ${WEBHOOKS_CONFIG_PATH} (target ${url}). Upload it with "hs project upload".`);
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
