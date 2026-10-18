import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compile, compileTemplate, ExpressionError } from './expression.js';

export class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid calculator config:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

const TOP_LEVEL_FIELDS = ['settings', 'calculators'];
const SETTINGS_FIELDS = ['skipWhenQuoteExists', 'setLineOrder', 'syncWhen'];
const CALCULATOR_FIELDS = ['id', 'name', 'appliesWhen', 'lineItems', 'notes'];
const LINE_FIELDS = ['key', 'product', 'quantity', 'unitPrice', 'totalPrice', 'includeWhen', 'name', 'description', 'notes'];

/**
 * Load config from a directory:
 *
 *   <dir>/settings.json            optional, settings for all calculators
 *   <dir>/calculators/<any>.json   one calculator per file
 *
 * Adding a calculator means adding a file; nothing else needs editing.
 * Files are read in name order, which is also the order their line items
 * appear on the deal.
 */
export async function loadConfig(dir) {
  const problems = [];
  const settings = await readJson(join(dir, 'settings.json'), 'settings.json', problems, { optional: true });

  let files = [];
  try {
    files = (await readdir(join(dir, 'calculators'), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const calculators = [];
  for (const file of files) {
    const label = `calculators/${file}`;
    const raw = await readJson(join(dir, 'calculators', file), label, problems);
    if (raw === undefined) continue;
    if (!isObject(raw)) problems.push(`${label}: expected a JSON object describing one calculator`);
    else calculators.push({ ...raw, $file: label });
  }

  // Validate the files that did parse too, so every problem shows at once.
  try {
    const config = parseConfig({ ...(settings === undefined ? {} : { settings }), calculators });
    if (problems.length) throw new ConfigError(problems);
    return config;
  } catch (err) {
    if (err instanceof ConfigError && problems.length && err.problems !== problems) {
      throw new ConfigError([...problems, ...err.problems]);
    }
    throw err;
  }
}

async function readJson(path, label, problems, { optional = false } = {}) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' && optional) return undefined;
    if (err.code === 'ENOENT') {
      problems.push(`${label}: file not found`);
      return undefined;
    }
    throw err;
  }
  try {
    // Some Windows editors save a byte-order mark, which JSON.parse rejects.
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    problems.push(`${label}: not valid JSON (${err.message})`);
    return undefined;
  }
}

/**
 * Validate a raw config object and compile its expressions. Collects every
 * problem rather than stopping at the first, so one run of `npm run check`
 * shows everything to fix.
 */
export function parseConfig(raw) {
  const problems = [];
  // Properties that feed calculator output: changes to these should trigger
  // a sync, so they are the ones to subscribe to with webhooks.
  const inputProperties = new Set();
  // Properties that are only read (syncWhen).
  const conditionProperties = new Set();

  const compileField = (value, where, into) => {
    if (value === undefined) return null;
    if (typeof value === 'number' || typeof value === 'boolean') value = String(value);
    if (typeof value !== 'string' || !value.trim()) {
      problems.push(`${where}: expected an expression (text) or a number`);
      return null;
    }
    try {
      const compiled = compile(value);
      compiled.identifiers.forEach((name) => into.add(name));
      return compiled;
    } catch (err) {
      if (!(err instanceof ExpressionError)) throw err;
      problems.push(`${where}: ${err.message}`);
      return null;
    }
  };

  const compileText = (value, where) => {
    if (value === undefined) return null;
    if (typeof value !== 'string') {
      problems.push(`${where}: expected text`);
      return null;
    }
    try {
      const template = compileTemplate(value);
      template.identifiers.forEach((name) => inputProperties.add(name));
      return template;
    } catch (err) {
      if (!(err instanceof ExpressionError)) throw err;
      problems.push(`${where}: ${err.message}`);
      return null;
    }
  };

  if (!isObject(raw)) throw new ConfigError(['config must be a JSON object with a "calculators" list']);
  checkFields(raw, TOP_LEVEL_FIELDS, 'config', problems);

  const rawSettings = raw.settings ?? {};
  if (!isObject(rawSettings)) problems.push('settings: expected an object');
  else checkFields(rawSettings, SETTINGS_FIELDS, 'settings', problems);
  const settings = {
    skipWhenQuoteExists: rawSettings.skipWhenQuoteExists ?? true,
    setLineOrder: rawSettings.setLineOrder ?? true,
    syncWhen: compileField(rawSettings.syncWhen, 'settings.syncWhen', conditionProperties),
  };
  for (const name of ['skipWhenQuoteExists', 'setLineOrder']) {
    if (typeof settings[name] !== 'boolean') problems.push(`settings.${name}: expected true or false`);
  }

  const calculators = [];
  // An empty list is allowed: the service runs and does nothing until the
  // first calculator file is added.
  if (!Array.isArray(raw.calculators)) {
    problems.push('calculators: expected a list');
  } else {
    const calculatorIds = new Set();
    raw.calculators.forEach((rawCalc, ci) => {
      let where = `calculators[${ci}]`;
      if (!isObject(rawCalc)) {
        problems.push(`${where}: expected an object`);
        return;
      }
      // Name problems after the file when loaded from a directory, since
      // that is where they need fixing.
      if (typeof rawCalc.$file === 'string') where = rawCalc.$file;
      else if (typeof rawCalc.id === 'string') where = `calculator "${rawCalc.id}"`;
      checkFields(rawCalc, CALCULATOR_FIELDS, where, problems);
      checkId(rawCalc.id, `${where}.id`, calculatorIds, problems);

      const calc = {
        id: rawCalc.id,
        file: rawCalc.$file ?? null,
        name: typeof rawCalc.name === 'string' && rawCalc.name.trim() ? rawCalc.name : String(rawCalc.id),
        appliesWhen: compileField(rawCalc.appliesWhen, `${where}.appliesWhen`, inputProperties),
        lineItems: [],
      };

      if (!Array.isArray(rawCalc.lineItems) || rawCalc.lineItems.length === 0) {
        problems.push(`${where}.lineItems: expected a non-empty list`);
      } else {
        const lineKeys = new Set();
        rawCalc.lineItems.forEach((rawLine, li) => {
          let lineWhere = `${where}.lineItems[${li}]`;
          if (!isObject(rawLine)) {
            problems.push(`${lineWhere}: expected an object`);
            return;
          }
          if (typeof rawLine.key === 'string') lineWhere = `${where} line "${rawLine.key}"`;
          checkFields(rawLine, LINE_FIELDS, lineWhere, problems);
          checkId(rawLine.key, `${lineWhere}.key`, lineKeys, problems);

          if (rawLine.quantity === undefined) problems.push(`${lineWhere}.quantity: required`);
          if (rawLine.unitPrice !== undefined && rawLine.totalPrice !== undefined) {
            problems.push(`${lineWhere}: set unitPrice or totalPrice, not both`);
          }

          calc.lineItems.push({
            key: rawLine.key,
            fullKey: `${rawCalc.id}:${rawLine.key}`,
            product: parseProduct(rawLine.product, `${lineWhere}.product`, problems),
            quantity: compileField(rawLine.quantity, `${lineWhere}.quantity`, inputProperties),
            unitPrice: compileField(rawLine.unitPrice, `${lineWhere}.unitPrice`, inputProperties),
            totalPrice: compileField(rawLine.totalPrice, `${lineWhere}.totalPrice`, inputProperties),
            includeWhen: compileField(rawLine.includeWhen, `${lineWhere}.includeWhen`, inputProperties),
            name: compileText(rawLine.name, `${lineWhere}.name`),
            description: compileText(rawLine.description, `${lineWhere}.description`),
          });
        });
      }
      calculators.push(calc);
    });
  }

  if (problems.length) throw new ConfigError(problems);

  const lines = calculators.flatMap((c) => c.lineItems);
  return {
    settings,
    calculators,
    inputProperties: [...inputProperties].sort(),
    dealProperties: [...new Set([...inputProperties, ...conditionProperties])].sort(),
    skus: [...new Set(lines.filter((l) => l.product.sku).map((l) => l.product.sku))],
    productIds: [...new Set(lines.filter((l) => l.product.id).map((l) => l.product.id))],
  };
}

function parseProduct(value, where, problems) {
  if (!isObject(value)) {
    problems.push(`${where}: expected { "sku": "..." } or { "id": "..." }`);
    return {};
  }
  checkFields(value, ['sku', 'id'], where, problems);
  const hasSku = value.sku !== undefined;
  const hasId = value.id !== undefined;
  if (hasSku === hasId) {
    problems.push(`${where}: set exactly one of "sku" or "id"`);
    return {};
  }
  if (hasSku) {
    if (typeof value.sku !== 'string' || !value.sku.trim()) problems.push(`${where}.sku: expected text`);
    return { sku: String(value.sku).trim() };
  }
  if (!/^\d+$/.test(String(value.id))) problems.push(`${where}.id: expected a numeric HubSpot product ID`);
  return { id: String(value.id) };
}

function checkId(value, where, seen, problems) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    problems.push(`${where}: expected letters, numbers, "-" or "_" (got ${JSON.stringify(value)})`);
    return;
  }
  if (seen.has(value)) problems.push(`${where}: "${value}" is already used; ids and keys must be unique`);
  seen.add(value);
}

function checkFields(object, allowed, where, problems) {
  for (const key of Object.keys(object)) {
    // Keys starting with "$" are ignored, so "$comment" works as a JSON comment.
    if (!key.startsWith('$') && !allowed.includes(key)) {
      problems.push(`${where}: unknown field "${key}" (allowed: ${allowed.join(', ')})`);
    }
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
