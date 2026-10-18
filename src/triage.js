// Decisions that need nothing but the deal's properties: no API calls.
//
// The poller (Node and Cloudflare) runs triage() on search results to skip
// deals that don't need a sync, and the sync uses the same pieces, so the
// two can't disagree about what "needs a sync" means.

import { createHash } from 'node:crypto';
import { evaluateCalculators } from './calculators.js';
import { ExpressionError, normalizeValues, truthy } from './expression.js';
import { DEAL, STATUS } from './properties.js';
import { calculatorIdOf } from './reconcile.js';

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
  orphansLeft: (count) =>
    `No calculator in the current config applies to this deal. ${count} line item${count === 1 ? '' : 's'} from calculators no longer in the config ${count === 1 ? 'was' : 'were'} left as ${count === 1 ? 'it is' : 'they are'}.`,
  quote:
    'The calculator output changed, but this deal already has a quote, so its line items were left as they are. ' +
    'Update them by hand, or delete the quote and then tick and untick "Calculator line items: freeze" to re-sync.',
};

// --- Fingerprints --------------------------------------------------------------
//
// The deal stores one short hash per calculator line it last applied:
//   "v2;licences:seats=1a2b3c4d5e6f;licences:support=..."
// A line is only re-applied when its own hash changes, so the team's edits
// to other lines survive, including lines from other calculators. Entries
// starting with "!" are markers, not lines (e.g. "!quote=<hash>": the
// output that was held back because the deal has a quote).

const FINGERPRINT_VERSION = 'v2';

/** Map of line key -> hash of what that line should contain. */
export function lineFingerprints(lines) {
  const map = new Map();
  for (const line of lines) {
    const product = line.product.sku !== undefined ? `sku:${line.product.sku}` : `id:${line.product.id}`;
    const canonical = JSON.stringify([product, line.quantity, line.price, line.name, line.description]);
    map.set(line.key, hash(canonical));
  }
  return map;
}

export function formatFingerprint(map, markers = {}) {
  const entries = [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const marks = Object.entries(markers).filter(([, value]) => value).map(([name, value]) => `!${name}=${value}`);
  return [FINGERPRINT_VERSION, ...entries.map(([key, value]) => `${key}=${value}`), ...marks].join(';');
}

/** Parse a stored fingerprint's line entries; null when blank or in an older format. */
export function parseFingerprint(text) {
  const entries = splitFingerprint(text);
  if (!entries) return null;
  return new Map(entries.filter(([key]) => !key.startsWith('!')));
}

/** A marker from a stored fingerprint, e.g. fingerprintMarker(text, 'quote'). */
export function fingerprintMarker(text, name) {
  return splitFingerprint(text)?.find(([key]) => key === `!${name}`)?.[1] ?? null;
}

/** A short hash identifying a whole set of line fingerprints. */
export function digestOf(map) {
  return hash(formatFingerprint(map));
}

/** Only the entries for calculators in the config. */
export function knownEntries(map, calculatorIds) {
  return new Map([...map].filter(([key]) => calculatorIds.has(calculatorIdOf(key))));
}

/** Keys whose hash differs between two fingerprint maps (including added/removed). */
export function changedKeys(stored, current) {
  const keys = new Set();
  for (const [key, value] of current) if (stored.get(key) !== value) keys.add(key);
  for (const key of stored.keys()) if (!current.has(key)) keys.add(key);
  return keys;
}

function splitFingerprint(text) {
  if (typeof text !== 'string' || !text.startsWith(FINGERPRINT_VERSION)) return null;
  const [version, ...entries] = text.split(';');
  if (version !== FINGERPRINT_VERSION) return null;
  return entries
    .map((entry) => [entry.slice(0, entry.lastIndexOf('=')), entry.slice(entry.lastIndexOf('=') + 1)])
    .filter(([key]) => key);
}

function hash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

// --- Triage --------------------------------------------------------------------

/**
 * What a sync of this deal would do, judged from its properties alone.
 *
 * action "skip" means a sync would change nothing and write nothing:
 *   reason "syncWhen" | "syncWhenError" | "noop" | "frozen" | "errors" | "unchanged" | "quote"
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
  const storedAll = parseFingerprint(properties[DEAL.fingerprint]);
  // Entries for calculators no longer in the config are kept but ignored.
  const stored = storedAll && knownEntries(storedAll, new Set(config.calculators.map((calc) => calc.id)));
  if (stored && sameMap(stored, fingerprints) && status === STATUS.synced) {
    return skip('unchanged', { evaluation, fingerprints, stored, storedAll });
  }
  // Held back because of a quote, and the output hasn't changed since.
  if (status === STATUS.skipped && sameText(message, MESSAGES.quote) && fingerprintMarker(properties[DEAL.fingerprint], 'quote') === digestOf(fingerprints)) {
    return skip('quote', { evaluation, fingerprints, stored, storedAll });
  }
  return sync('changed', { evaluation, fingerprints, stored, storedAll });
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
