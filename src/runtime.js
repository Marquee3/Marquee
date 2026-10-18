import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config-loader.js';
import { HubSpotClient } from './hubspot.js';
import { logger } from './logger.js';
import { ProductResolver } from './products.js';
import { LineItemSync } from './sync.js';

export const DEFAULT_CONFIG_DIR = fileURLToPath(new URL('../config', import.meta.url));

/** Load a .env file into process.env if there is one (existing variables win). */
export function loadEnv(path = '.env') {
  if (existsSync(path)) process.loadEnvFile(path);
}

export function configDir(env = process.env) {
  return env.CONFIG_DIR || DEFAULT_CONFIG_DIR;
}

export function createClient(env = process.env, options = {}) {
  return new HubSpotClient({
    accessToken: env.HUBSPOT_ACCESS_TOKEN,
    ...(env.HUBSPOT_API_VERSION ? { apiVersion: env.HUBSPOT_API_VERSION } : {}),
    // Only for pointing at a mock API in testing.
    ...(env.HUBSPOT_API_BASE_URL ? { baseUrl: env.HUBSPOT_API_BASE_URL } : {}),
    ...options,
  });
}

export async function createApp(env = process.env) {
  const config = await loadConfig(configDir(env));
  const hubspot = createClient(env);
  const products = new ProductResolver(hubspot);
  const sync = new LineItemSync({ hubspot, config, products, logger });
  return { config, hubspot, products, sync };
}

/**
 * A numeric setting: blank or unset means the default; anything that isn't
 * a number in range is an error, so a typo can't silently turn a feature off.
 */
export function numberSetting(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number from ${min} to ${max} (got "${raw}")`);
  }
  return value;
}

export function readServerSettings(env = process.env) {
  return {
    port: numberSetting(env, 'PORT', 3000, { min: 1, max: 65535 }),
    clientSecret: env.HUBSPOT_CLIENT_SECRET || undefined,
    publicUrl: env.PUBLIC_URL || undefined,
    portalId: env.HUBSPOT_PORTAL_ID || undefined,
    syncApiKey: env.SYNC_API_KEY || undefined,
    allowUnsigned: env.ALLOW_UNSIGNED_WEBHOOKS === 'true',
    debounceMs: numberSetting(env, 'SYNC_DEBOUNCE_MS', 5000, { max: 600_000 }),
    concurrency: numberSetting(env, 'SYNC_CONCURRENCY', 2, { min: 1, max: 20 }),
    // 0 turns the poller off (webhooks only).
    pollSeconds: numberSetting(env, 'SYNC_POLL_SECONDS', 60, { max: 86_400 }),
    pollLookbackMinutes: numberSetting(env, 'SYNC_POLL_LOOKBACK_MINUTES', 60, { max: 7 * 24 * 60 }),
  };
}
