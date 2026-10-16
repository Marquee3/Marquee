import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, compileTemplate, ExpressionError, normalizeValues, truthy } from '../src/expression.js';

const run = (source, properties = {}) => compile(source).evaluate(normalizeValues(properties));

test('arithmetic follows normal precedence', () => {
  assert.equal(run('1 + 2 * 3'), 7);
  assert.equal(run('(1 + 2) * 3'), 9);
  assert.equal(run('10 - 4 - 3'), 3);
  assert.equal(run('-2 * -3'), 6);
  assert.equal(run('7 % 4'), 3);
});

test('HubSpot property values (strings) are used as numbers', () => {
  assert.equal(run('width * length', { width: '6', length: '12.5' }), 75);
  assert.equal(run('ceil(guests / 10)', { guests: '83' }), 9);
});

test('functions', () => {
  assert.equal(run('floor(2.7)'), 2);
  assert.equal(run('round(2.345, 2)'), 2.35);
  assert.equal(run('round(1.005, 2)'), 1.01);
  assert.equal(run('round(2.5)'), 3);
  assert.equal(run('min(3, 1, 2)'), 1);
  assert.equal(run('max(3, 1, 2)'), 3);
  assert.equal(run('abs(-4)'), 4);
  assert.equal(run('if(tier == "premium", 2, 1)', { tier: 'premium' }), 2);
  assert.equal(run('if(tier == "premium", 2, 1)', { tier: 'standard' }), 1);
  assert.equal(run('coalesce(discount, 0)', {}), 0);
  assert.equal(run('coalesce(discount, 0)', { discount: '5' }), '5');
  assert.equal(run('isBlank(x)', { x: '' }), true);
  assert.equal(run('isBlank(x)', { x: '0' }), false);
});

test('if() only evaluates the branch it takes', () => {
  assert.equal(run('if(isBlank(rate), 0, rate * 2)', {}), 0);
});

test('hasOption checks HubSpot multi-select values', () => {
  assert.equal(run('hasOption(extras, "flooring")', { extras: 'lighting;flooring' }), true);
  assert.equal(run('hasOption(extras, "flooring")', { extras: 'lighting' }), false);
  assert.equal(run('hasOption(extras, "flooring")', {}), false);
});

test('comparisons and logic', () => {
  assert.equal(run('a > 0 && b > 0', { a: '1', b: '2' }), true);
  assert.equal(run('a > 0 && b > 0', { a: '1' }), false, 'comparison with a blank is false');
  assert.equal(run('a > 0 || b > 0', { b: '2' }), true);
  assert.equal(run('!(a > 0)', { a: '0' }), true);
  assert.equal(run('stage != "closedwon"', { stage: 'appointmentscheduled' }), true);
  assert.equal(run('"10" == 10'), true, 'numeric strings equal numbers');
  assert.equal(run('"abc" < "abd"'), true);
});

test('checkbox values become booleans', () => {
  assert.equal(run('flooring', { flooring: 'true' }), true);
  assert.equal(truthy(run('flooring', { flooring: 'false' })), false);
  assert.equal(run('flooring == true', { flooring: 'true' }), true);
  assert.equal(run('flooring == "true"', { flooring: 'true' }), true);
});

test('truthiness of numeric strings', () => {
  assert.equal(truthy('0'), false);
  assert.equal(truthy('2'), true);
  assert.equal(truthy('yes'), true);
  assert.equal(truthy(''), false);
  assert.equal(truthy(null), false);
});

test('errors name the deal property at fault', () => {
  assert.throws(() => run('width * length', { width: '5' }), /deal property "length" is empty/);
  assert.throws(() => run('width * 2', { width: 'wide' }), /deal property "width" is not a number/);
  assert.throws(() => run('10 / guests', { guests: '0' }), /division by zero \(deal property "guests" is 0\)/);
  assert.throws(() => compile('guests').evaluateNumber({}), /deal property "guests" is empty/);
});

test('syntax errors are reported clearly', () => {
  assert.throws(() => compile('a = 1'), /use "==" to compare/);
  assert.throws(() => compile('a & b'), /use "&&"/);
  assert.throws(() => compile('ceil(1, 2)'), /ceil\(\) takes 1 argument/);
  assert.throws(() => compile('sqrt(4)'), /unknown function "sqrt"/);
  assert.throws(() => compile('(1 + 2'), /unexpected end of expression, expected "\)"/);
  assert.throws(() => compile('1 +'), ExpressionError);
  assert.throws(() => compile('"open'), /unterminated string/);
});

test('cannot reach JavaScript', () => {
  assert.throws(() => compile('constructor.constructor("return process")()'), ExpressionError);
  assert.equal(run('constructor', {}), null);
  assert.equal(run('__proto__', {}), null);
});

test('identifiers are collected, excluding function names and keywords', () => {
  assert.deepEqual(compile('ceil(a * b) + if(c, d, 1) + true').identifiers.sort(), ['a', 'b', 'c', 'd']);
});

test('templates', () => {
  const template = compileTemplate('Marquee {{w}}m x {{l}}m ({{w * l}} m2){{missing}}');
  assert.deepEqual(template.identifiers.sort(), ['l', 'missing', 'w']);
  assert.equal(template.render(normalizeValues({ w: '6', l: '12.5' })), 'Marquee 6m x 12.5m (75 m2)');
  assert.equal(compileTemplate('{{0.1 + 0.2}}').render({}), '0.3');
});
