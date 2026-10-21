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
async function withFakeHubSpot({ scopes, status = 200 }, fn) {
  const { createServer } = await import('node:http');
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/oauth/v2/private-apps/get/access-token-info') {
      return status === 200 ? send(200, { hubId: 4242, appId: 77, userId: 1, scopes }) : send(status, { message: 'Authentication credentials not found' });
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
