import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ConfigError, parseConfig } from './config.js';

/**
 * Read a config directory:
 *
 *   <dir>/settings.json            optional, settings for all calculators
 *   <dir>/calculators/<any>.json   one calculator per file
 *
 * Adding a calculator means adding a file; nothing else needs editing.
 * Files are read in name order, which is also the order their line items
 * appear on the deal.
 *
 * Returns the raw (unvalidated) config, as bundled into the Cloudflare
 * Worker at deploy time. Throws ConfigError if files can't be read.
 */
export async function readConfigDir(dir) {
  const problems = [];
  const settings = await readJson(join(dir, 'settings.json'), 'settings.json', problems, { optional: true });
  const calculatorsDir = join(dir, 'calculators');

  let entries = [];
  try {
    entries = await readdir(calculatorsDir, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // Fail rather than run with no calculators: a wrong CONFIG_DIR must not
    // look like "every calculator was deleted".
    problems.push(`calculators folder not found: ${resolve(calculatorsDir)}`);
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.json') || entry.name.startsWith('.')) continue;
    // Follow symlinks (e.g. Kubernetes ConfigMap mounts) to regular files.
    const isFile = entry.isFile() || (entry.isSymbolicLink() && (await stat(join(calculatorsDir, entry.name)).catch(() => null))?.isFile());
    if (isFile) files.push(entry.name);
  }
  files.sort();

  const calculators = [];
  for (const file of files) {
    const label = `calculators/${file}`;
    const raw = await readJson(join(calculatorsDir, file), label, problems);
    if (raw === undefined) continue;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push(`${label}: expected a JSON object describing one calculator`);
    } else {
      calculators.push({ ...raw, $file: label });
    }
  }

  return { raw: { ...(settings === undefined ? {} : { settings }), calculators }, problems };
}

/** Read and validate a config directory. Reports every problem at once. */
export async function loadConfig(dir) {
  const { raw, problems } = await readConfigDir(dir);
  try {
    const config = parseConfig(raw);
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
