// Minimal HubSpot REST client: just the calls this app makes.
//
// All endpoint paths live in this file. They use HubSpot's numbered API
// versions (v3 objects, v4 associations), which HubSpot supports until
// September 2027; moving to the date-based versions only means changing
// the paths here.

const DEFAULT_BASE_URL = 'https://api.hubapi.com';
const BATCH_SIZE = 100;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
// HubSpot-defined association type for line item -> deal.
const LINE_ITEM_TO_DEAL = 20;
// HubSpot's search API allows at most 5 filter groups (ORed) per request.
const SEARCH_FILTER_GROUPS = 5;

export class HubSpotError extends Error {
  constructor({ status, method, path, body }) {
    const detail =
      (body && typeof body === 'object' && body.message) || (typeof body === 'string' && body) || 'request failed';
    super(`HubSpot ${method} ${path} failed (${status}): ${detail}`);
    this.name = 'HubSpotError';
    this.status = status;
    this.body = body;
  }
}

export class HubSpotClient {
  #token;
  #baseUrl;
  #fetch;
  #maxRetries;
  #sleep;

  constructor({
    accessToken,
    baseUrl = DEFAULT_BASE_URL,
    fetch: fetchImpl = globalThis.fetch,
    maxRetries = 4,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }) {
    if (!accessToken) throw new Error('HUBSPOT_ACCESS_TOKEN is not set');
    this.#token = accessToken;
    this.#baseUrl = baseUrl;
    this.#fetch = fetchImpl;
    this.#maxRetries = maxRetries;
    this.#sleep = sleep;
  }

  async request(method, path, { body, query } = {}) {
    const url = new URL(path, this.#baseUrl);
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
    }

    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await this.#fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${this.#token}`,
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        // Network failure. Retrying a create could duplicate it if the first
        // attempt actually landed; the sync's duplicate check cleans that up.
        if (attempt < this.#maxRetries) {
          await this.#sleep(backoff(attempt));
          continue;
        }
        throw err;
      }

      if (response.ok) {
        const text = response.status === 204 ? '' : await response.text();
        return text ? JSON.parse(text) : null;
      }
      if (RETRYABLE_STATUS.has(response.status) && attempt < this.#maxRetries) {
        await this.#sleep(retryDelay(response, attempt));
        continue;
      }
      const text = await response.text();
      let parsed = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Not JSON; keep the text.
      }
      throw new HubSpotError({ status: response.status, method, path: url.pathname, body: parsed });
    }
  }

  // --- Deals -------------------------------------------------------------------

  getDeal(dealId, properties) {
    return this.request('GET', `/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
      query: { properties: properties.join(',') },
    });
  }

  updateDeal(dealId, properties) {
    return this.request('PATCH', `/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { body: { properties } });
  }

  /** One page of deals modified at or after `sinceMs`, oldest first. */
  async searchDealsModifiedSince(sinceMs, properties, { after, limit = 200 } = {}) {
    const response = await this.request('POST', '/crm/v3/objects/deals/search', {
      body: {
        filterGroups: [{ filters: [{ propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: String(sinceMs) }] }],
        sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
        properties,
        limit,
        after,
      },
    });
    return { results: response?.results ?? [], after: response?.paging?.next?.after };
  }

  /** IDs of records of `toType` associated with a record, e.g. a deal's line items. */
  async getAssociatedIds(fromType, fromId, toType, { max = Infinity } = {}) {
    const ids = new Set();
    let after;
    do {
      const page = await this.request(
        'GET',
        `/crm/v4/objects/${fromType}/${encodeURIComponent(fromId)}/associations/${toType}`,
        { query: { limit: 500, after } },
      );
      for (const result of page?.results ?? []) ids.add(String(result.toObjectId ?? result.id));
      after = page?.paging?.next?.after;
    } while (after && ids.size < max);
    return [...ids];
  }

  // --- Line items --------------------------------------------------------------

  readLineItems(ids, properties) {
    return this.#batchRead('line_items', ids, properties);
  }

  /** Create line items already associated with the deal. */
  async createLineItems(dealId, propertiesList) {
    const created = [];
    for (const batch of chunks(propertiesList, BATCH_SIZE)) {
      const response = await this.request('POST', '/crm/v3/objects/line_items/batch/create', {
        body: {
          inputs: batch.map((properties) => ({
            properties,
            associations: [
              {
                to: { id: String(dealId) },
                types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: LINE_ITEM_TO_DEAL }],
              },
            ],
          })),
        },
      });
      throwOnBatchErrors(response, 'create line items');
      created.push(...(response?.results ?? []));
    }
    return created;
  }

  async updateLineItems(updates) {
    for (const batch of chunks(updates, BATCH_SIZE)) {
      const response = await this.request('POST', '/crm/v3/objects/line_items/batch/update', {
        body: { inputs: batch.map(({ id, properties }) => ({ id: String(id), properties })) },
      });
      throwOnBatchErrors(response, 'update line items');
    }
  }

  async archiveLineItems(ids) {
    for (const batch of chunks(ids, BATCH_SIZE)) {
      await this.request('POST', '/crm/v3/objects/line_items/batch/archive', {
        body: { inputs: batch.map((id) => ({ id: String(id) })) },
      });
    }
  }

  // --- Products ----------------------------------------------------------------

  /** Products whose SKU (hs_sku) matches one of `skus`. */
  async findProductsBySku(skus) {
    const results = [];
    for (const batch of chunks(skus, SEARCH_FILTER_GROUPS)) {
      let after;
      do {
        const response = await this.request('POST', '/crm/v3/objects/products/search', {
          body: {
            filterGroups: batch.map((sku) => ({ filters: [{ propertyName: 'hs_sku', operator: 'EQ', value: sku }] })),
            properties: ['name', 'hs_sku', 'price'],
            limit: 100,
            after,
          },
        });
        results.push(...(response?.results ?? []));
        after = response?.paging?.next?.after;
      } while (after);
    }
    return results;
  }

  readProducts(ids) {
    return this.#batchRead('products', ids, ['name', 'hs_sku', 'price']);
  }

  // --- Properties ----------------------------------------------------------------

  async getProperties(objectType) {
    const response = await this.request('GET', `/crm/v3/properties/${objectType}`);
    return response?.results ?? [];
  }

  createProperty(objectType, definition) {
    return this.request('POST', `/crm/v3/properties/${objectType}`, { body: definition });
  }

  // ---------------------------------------------------------------------------

  async #batchRead(objectType, ids, properties) {
    const results = [];
    for (const batch of chunks(ids, BATCH_SIZE)) {
      const response = await this.request('POST', `/crm/v3/objects/${objectType}/batch/read`, {
        body: { properties, inputs: batch.map((id) => ({ id: String(id) })) },
      });
      results.push(...(response?.results ?? []));
    }
    return results;
  }
}

// Batch endpoints can answer 207 Multi-Status with some inputs failed.
function throwOnBatchErrors(response, action) {
  const errors = response?.errors ?? [];
  if (!errors.length) return;
  const detail = errors.map((e) => e.message ?? JSON.stringify(e)).join('; ');
  throw new HubSpotError({ status: 207, method: 'POST', path: action, body: { message: detail } });
}

function chunks(items, size) {
  const result = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

function backoff(attempt) {
  return Math.min(10_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

function retryDelay(response, attempt) {
  const seconds = Number(response.headers?.get?.('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 30_000) : backoff(attempt);
}
