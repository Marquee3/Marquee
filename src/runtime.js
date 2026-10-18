import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
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

export function createClient(env = process.env) {
  return new HubSpotClient({
    accessToken: env.HUBSPOT_ACCESS_TOKEN,
    // Only for pointing at a mock API in testing.
    ...(env.HUBSPOT_API_BASE_URL ? { baseUrl: env.HUBSPOT_API_BASE_URL } : {}),
  });
}

export async function createApp(env = process.env) {
  const config = await loadConfig(configDir(env));
  const hubspot = createClient(env);
  const products = new ProductResolver(hubspot);
  const sync = new LineItemSync({ hubspot, config, products, logger });
  return { config, hubspot, products, sync };
}

export function readServerSettings(env = process.env) {
  return {
    port: Number(env.PORT || 3000),
    clientSecret: env.HUBSPOT_CLIENT_SECRET || undefined,
    publicUrl: env.PUBLIC_URL || undefined,
    portalId: env.HUBSPOT_PORTAL_ID || undefined,
    syncApiKey: env.SYNC_API_KEY || undefined,
    allowUnsigned: env.ALLOW_UNSIGNED_WEBHOOKS === 'true',
    debounceMs: Number(env.SYNC_DEBOUNCE_MS || 5000),
    concurrency: Number(env.SYNC_CONCURRENCY || 2),
    // 0 turns the poller off (webhooks only).
    pollSeconds: Number(env.SYNC_POLL_SECONDS ?? 60),
    pollLookbackMinutes: Number(env.SYNC_POLL_LOOKBACK_MINUTES || 60),
  };
}
