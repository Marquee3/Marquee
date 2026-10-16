import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('the shipped example config is valid', async () => {
  const config = await loadConfig(fileURLToPath(new URL('../config/calculators.json', import.meta.url)));
  assert.equal(config.calculators.length, 2);
  assert.ok(config.inputProperties.includes('marquee_width_m'));
  assert.ok(!config.inputProperties.includes('dealstage'), 'syncWhen properties are not webhook inputs');
  assert.ok(config.dealProperties.includes('dealstage'));
  assert.deepEqual(config.skus.length, 6);
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
  assert.match(text, /"x" is used more than once/);
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
      { name: 'Marquee calculator' },
    ),
  );
  const { errors } = evaluateCalculators(config, { w: '3', rate: '5' });
  assert.deepEqual(errors, [
    'Marquee calculator › a: quantity: deal property "l" is empty',
    'Marquee calculator › b: quantity is negative (-2)',
    "Marquee calculator › c: price is negative (-5); HubSpot line item prices can't be negative",
  ]);
});
