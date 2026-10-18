import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadConfig } from '../src/config.js';

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
  await mkdir(join(dir, 'calculators'));
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
