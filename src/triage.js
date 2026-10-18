// Decisions that need nothing but the deal's properties: no API calls.
//
// The poller (Node and Cloudflare) runs triage() on search results to skip
// deals that don't need a sync, and the sync uses the same pieces, so the
// two can't disagree about what "needs a sync" means.

import { createHash } from 'node:crypto';
import { evaluateCalculators } from './calculators.js';
import { ExpressionError, normalizeValues, truthy } from './expression.js';
import { DEAL, STATUS } from './properties.js';

export const REVIEW_HINT = 'Review them, then create the quote.';
const MAX_MESSAGE_LENGTH = 2000;

/** Status messages are stored truncated, so compare them truncated. */
export function truncate(text) {
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : text;
}

export const MESSAGES = {
  frozen: 'Line items are frozen on this deal, so they were not updated. Untick "Calculator line items: freeze" to re-sync them.',
  inputErrors: (errors) =>
    `Line items were not changed because the calculator output couldn't be turned into line items:\n• ${errors.join('\n• ')}`,
  syncWhenError: (message) => `Line items were not changed: settings.syncWhen: ${message}`,
  alreadyMatch: `Line items already match the calculator. ${REVIEW_HINT}`,
  noCalculator: 'No calculator applies to this deal, so it has no calculator line items.',
  quote:
    'The calculator output changed, but this deal already has a quote, so its line items were left as they are. ' +
    'Update them by hand, or delete the quote and then tick and untick "Calculator line items: freeze" to re-sync.',
};

// --- Fingerprints --------------------------------------------------------------
//
// The deal stores one short hash per calculator line it last applied:
//   "v2;licences:seats=1a2b3c4d5e6f;licences:support=..."
// A line is only re-applied when its own hash changes, so the team's edits
// to other lines survive, including lines from other calculators.

const FINGERPRINT_VERSION = 'v2';

/** Map of line key -> hash of what that line should contain. */
export function lineFingerprints(lines) {
  const map = new Map();
  for (const line of lines) {
    const product = line.product.sku !== undefined ? `sku:${line.product.sku}` : `id:${line.product.id}`;
    const canonical = JSON.stringify([product, line.quantity, line.price, line.name, line.description]);
    map.set(line.key, createHash('sha256').update(canonical).digest('hex').slice(0, 12));
  }
  return map;
}

export function formatFingerprint(map) {
  const entries = [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return [FINGERPRINT_VERSION, ...entries.map(([key, hash]) => `${key}=${hash}`)].join(';');
}

/** Parse a stored fingerprint; null when blank or in an older format. */
export function parseFingerprint(text) {
  if (typeof text !== 'string' || !text.startsWith(FINGERPRINT_VERSION)) return null;
  const [version, ...entries] = text.split(';');
  if (version !== FINGERPRINT_VERSION) return null;
  const map = new Map();
  for (const entry of entries) {
    const at = entry.lastIndexOf('=');
    if (at > 0) map.set(entry.slice(0, at), entry.slice(at + 1));
  }
  return map;
}

/** Keys whose hash differs between two fingerprint maps (including added/removed). */
export function changedKeys(stored, current) {
  const keys = new Set();
  for (const [key, hash] of current) if (stored.get(key) !== hash) keys.add(key);
  for (const key of stored.keys()) if (!current.has(key)) keys.add(key);
  return keys;
}

// --- Triage --------------------------------------------------------------------

/**
 * What a sync of this deal would do, judged from its properties alone.
 *
 * action "skip" means a sync would change nothing and write nothing:
 *   reason "syncWhen" | "noop" | "frozen" | "errors" | "unchanged"
 * action "sync" means a sync is needed (or needs the API to decide).
 */
export function triage(config, properties) {
  const values = normalizeValues(properties);
  const status = properties[DEAL.status] ?? null;
  const message = properties[DEAL.message] ?? null;
  const skip = (reason, extra = {}) => ({ action: 'skip', reason, ...extra });
  const sync = (reason, extra = {}) => ({ action: 'sync', reason, ...extra });

  const { syncWhen } = config.settings;
  if (syncWhen) {
    try {
      if (!truthy(syncWhen.evaluate(values))) return skip('syncWhen');
    } catch (err) {
      if (!(err instanceof ExpressionError)) throw err;
      const text = MESSAGES.syncWhenError(err.message);
      const already = status === STATUS.error && sameText(message, text);
      return (already ? skip : sync)('syncWhenError', { syncWhenError: text });
    }
  }

  const evaluation = evaluateCalculators(config, properties);
  const untouched = !properties[DEAL.fingerprint] && !status;
  if (!evaluation.lines.length && !evaluation.errors.length && untouched) return skip('noop', { evaluation });

  // Reasons are the same whether skipping or syncing; "skip" only means the
  // deal already shows this status, so a sync would write nothing.
  if (truthy(values[DEAL.frozen])) {
    const already = status === STATUS.skipped && sameText(message, MESSAGES.frozen);
    return (already ? skip : sync)('frozen', { evaluation });
  }

  if (evaluation.errors.length) {
    const already = status === STATUS.error && sameText(message, MESSAGES.inputErrors(evaluation.errors));
    return (already ? skip : sync)('errors', { evaluation });
  }

  const fingerprints = lineFingerprints(evaluation.lines);
  const stored = parseFingerprint(properties[DEAL.fingerprint]);
  if (stored && sameMap(stored, fingerprints) && status === STATUS.synced) {
    return skip('unchanged', { evaluation, fingerprints, stored });
  }
  return sync('changed', { evaluation, fingerprints, stored });
}

export function sameMap(a, b) {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

// HubSpot may normalise whitespace in stored text, so compare loosely.
export function sameText(stored, text) {
  const normalize = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  return normalize(stored) === normalize(truncate(String(text ?? '')));
}

/** Every deal property the triage (and so the poller's search) needs. */
export function triageProperties(config) {
  return [...new Set([...config.dealProperties, ...Object.values(DEAL), 'hs_lastmodifieddate'])];
}
