import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig, parseConfig } from '../src/config.js';
import { evaluateCalculators } from '../src/calculators.js';

const minimal = (lineItems, calc = {}) => ({
  calculators: [{ id: 'calc', name: 'Calc', lineItems, ...calc }],
});

const problemsOf = (raw) => {
  try {
    parseConfig(raw);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  return [];
};

const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

async function configDirWith(files) {
  const dir = await mkdtemp(join(tmpdir(), 'calc-config-'));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

const LINE = { key: 'a', product: { id: '1' }, quantity: 1 };

test('the shipped config loads, with no calculators yet', async () => {
  const config = await loadConfig(fileURLToPath(new URL('../config', import.meta.url)));
  assert.deepEqual(config.calculators, []);
  assert.equal(config.settings.skipWhenQuoteExists, true);
  assert.equal(config.settings.setLineOrder, true);
});

test('the example calculators are valid', async () => {
  const config = await loadConfig(fileURLToPath(new URL('../examples', import.meta.url)));
  assert.deepEqual(config.calculators.map((c) => c.id), ['licences', 'services']);
  assert.ok(config.inputProperties.includes('licence_seats'));
  assert.equal(config.skus.length, 5);
});

test('each file in calculators/ is one calculator, loaded in name order', async () => {
  const dir = await configDirWith({
    'calculators/20-second.json': { id: 'second', lineItems: [LINE] },
    'calculators/10-first.json': { id: 'first', lineItems: [LINE] },
    'calculators/notes.txt': 'ignored',
    'calculators/README.md': '# ignored',
    'settings.json': { syncWhen: 'dealstage != "closedwon"' },
  });
  const config = await loadConfig(dir);
  assert.deepEqual(
    config.calculators.map((c) => [c.id, c.file]),
    [['first', 'calculators/10-first.json'], ['second', 'calculators/20-second.json']],
  );
  assert.ok(config.dealProperties.includes('dealstage'));
  assert.ok(!config.inputProperties.includes('dealstage'), 'syncWhen properties are not calculator inputs');
});

test('a missing folder or settings file just means defaults', async () => {
  const config = await loadConfig(await configDirWith({}));
  assert.deepEqual(config.calculators, []);
  assert.equal(config.settings.skipWhenQuoteExists, true);
});

test('problems in every file are reported at once, named by file', async () => {
  const dir = await configDirWith({
    'calculators/a-good.json': { id: 'same', lineItems: [LINE] },
    'calculators/b-copy.json': { id: 'same', lineItems: [{ ...LINE, quantity: 'ceil(' }] },
    'calculators/c-broken.json': '{ "id": ',
    'calculators/d-list.json': '[]',
    'settings.json': { skipWhenQuoteExists: 'yes' },
  });
  const problems = await loadConfig(dir).then(
    () => [],
    (err) => err.problems,
  );
  const text = problems.join('\n');
  assert.match(text, /calculators\/c-broken\.json: not valid JSON/);
  assert.match(text, /calculators\/d-list\.json: expected a JSON object/);
  assert.match(text, /calculators\/b-copy\.json\.id: "same" is already used/);
  assert.match(text, /calculators\/b-copy\.json line "a"\.quantity: Invalid expression "ceil\("/);
  assert.match(text, /settings\.skipWhenQuoteExists: expected true or false/);
});

test('settings.json rejects unknown fields', async () => {
  const dir = await configDirWith({ 'settings.json': { skipWhenQuoteExist: false } });
  await assert.rejects(loadConfig(dir), /settings: unknown field "skipWhenQuoteExist"/);
});

test('collects every problem in one pass', () => {
  const problems = problemsOf({
    calculators: [
      {
        id: 'a b',
        lineItems: [
          { key: 'x', product: { sku: 'S', id: '1' }, quantity: 'ceil(' },
          { key: 'x', product: { sku: 'S' }, quantity: 1, unitPrice: 1, totalPrice: 2, quantiy: 3 },
          { key: 'y', product: {} },
        ],
      },
    ],
  });
  const text = problems.join('\n');
  assert.match(text, /calculator "a b"\.id: expected letters/);
  assert.match(text, /set exactly one of "sku" or "id"/);
  assert.match(text, /quantity: Invalid expression "ceil\("/);
  assert.match(text, /"x" is already used/);
  assert.match(text, /set unitPrice or totalPrice, not both/);
  assert.match(text, /unknown field "quantiy"/);
  assert.match(text, /line "y"\.quantity: required/);
});

test('$-prefixed keys are treated as comments', () => {
  assert.deepEqual(problemsOf({ $comment: 'hi', ...minimal([{ key: 'a', $note: 'x', product: { id: '1' }, quantity: 1 }]) }), []);
});

test('product ids must be numeric', () => {
  assert.match(problemsOf(minimal([{ key: 'a', product: { id: 'abc' }, quantity: 1 }])).join(), /numeric HubSpot product ID/);
});

test('evaluates quantities, prices and names from deal properties', () => {
  const config = parseConfig(
    minimal([
      { key: 'area', product: { sku: 'AREA' }, quantity: 'w * l', unitPrice: 'rate', name: 'Floor {{w}}x{{l}}' },
      { key: 'fixed', product: { id: '42' }, quantity: 3, totalPrice: 'total' },
      { key: 'plain', product: { id: '43' }, quantity: '2' },
    ]),
  );
  const { lines, errors } = evaluateCalculators(config, { w: '6', l: '12', rate: '9.5', total: '100' });
  assert.deepEqual(errors, []);
  assert.deepEqual(
    lines.map(({ key, quantity, price, name }) => ({ key, quantity, price, name })),
    [
      { key: 'calc:area', quantity: 72, price: 9.5, name: 'Floor 6x12' },
      { key: 'calc:fixed', quantity: 3, price: 33.333333, name: null },
      { key: 'calc:plain', quantity: 2, price: null, name: null },
    ],
  );
});

test('appliesWhen, includeWhen and zero quantities leave lines off', () => {
  const config = parseConfig({
    calculators: [
      { id: 'off', appliesWhen: 'guests > 0', lineItems: [{ key: 'a', product: { id: '1' }, quantity: 1 }] },
      {
        id: 'on',
        lineItems: [
          { key: 'included', product: { id: '1' }, quantity: 1, includeWhen: 'heating' },
          { key: 'excluded', product: { id: '1' }, quantity: 1, includeWhen: '!heating' },
          { key: 'zero', product: { id: '1' }, quantity: 'heaters' },
        ],
      },
    ],
  });
  const result = evaluateCalculators(config, { guests: '', heating: 'true', heaters: '0' });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.lines.map((l) => l.key), ['on:included']);
  assert.deepEqual(result.calculators.map((c) => c.id), ['on']);
});

test('reports every bad line with calculator and field context', () => {
  const config = parseConfig(
    minimal(
      [
        { key: 'a', product: { id: '1' }, quantity: 'w * l' },
        { key: 'b', product: { id: '1' }, quantity: '0 - 2' },
        { key: 'c', product: { id: '1' }, quantity: 1, unitPrice: '0 - rate' },
      ],
      { name: 'Hardware calculator' },
    ),
  );
  const { errors } = evaluateCalculators(config, { w: '3', rate: '5' });
  assert.deepEqual(errors, [
    'Hardware calculator › a: quantity: deal property "l" is empty',
    'Hardware calculator › b: quantity is negative (-2)',
    "Hardware calculator › c: price is negative (-5); HubSpot line item prices can't be negative",
  ]);
});
