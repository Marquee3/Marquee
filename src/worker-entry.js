// Cloudflare Workers entry point (wrangler.jsonc "main"). build/config.js is
// generated from config/ by scripts/bundle-config.js on every deploy.
import rawConfig from '../build/config.js';
import { createWorker } from './worker.js';

export default createWorker(rawConfig);
