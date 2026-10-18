// In-memory stand-in for HubSpotClient, implementing the same methods.
// Deals carry hs_lastmodifieddate, bumped on every update, and searchDeals
// pages by offset like HubSpot's search API does.

export class FakeHubSpot {
  constructor({ deals = {}, products = [], now } = {}) {
    let tick = Date.parse('2026-10-18T09:00:00Z');
    this.now = now ?? (() => (tick += 1000));
    this.nextId = 1000;
    this.deals = new Map(
      Object.entries(deals).map(([id, properties]) => [
        id,
        { id, properties: { hs_lastmodifieddate: new Date(this.now()).toISOString(), ...properties } },
      ]),
    );
    this.products = products.map((p) => ({ id: String(p.id), properties: { ...p } }));
    this.lineItems = new Map(); // id -> { id, properties, dealId }
    this.quotes = new Map(); // dealId -> [quoteIds]
    this.calls = [];
    // Hooks for simulating failures and races.
    this.beforeCreate = null;
    this.failUpdateDeal = null;
    this.beforeSearchPage = null;
  }

  #record(name, ...args) {
    this.calls.push({ name, args });
  }

  writeCalls() {
    return this.calls.filter((c) => ['createLineItems', 'updateLineItems', 'archiveLineItems'].includes(c.name));
  }

  count(name) {
    return this.calls.filter((c) => c.name === name).length;
  }

  /** Change deal properties as a user or calculator would. */
  editDeal(dealId, properties) {
    const deal = this.deals.get(String(dealId));
    Object.assign(deal.properties, properties, { hs_lastmodifieddate: new Date(this.now()).toISOString() });
  }

  addLineItem(dealId, properties) {
    const id = String(this.nextId++);
    this.lineItems.set(id, { id, dealId: String(dealId), properties: { ...properties } });
    return id;
  }

  dealLineItems(dealId) {
    return [...this.lineItems.values()].filter((li) => li.dealId === String(dealId));
  }

  async getDeal(dealId, properties) {
    this.#record('getDeal', dealId, properties);
    const deal = this.deals.get(String(dealId));
    if (!deal) throw Object.assign(new Error('HubSpot GET deal failed (404): Object not found'), { status: 404 });
    return { id: deal.id, properties: pick(deal.properties, properties) };
  }

  async updateDeal(dealId, properties) {
    this.#record('updateDeal', dealId, properties);
    if (this.failUpdateDeal) await this.failUpdateDeal(dealId, properties);
    this.editDeal(dealId, properties);
  }

  async searchDeals({ filterGroups, sorts, properties, after, limit = 200 }) {
    this.#record('searchDeals', filterGroups);
    if (this.beforeSearchPage) await this.beforeSearchPage({ filterGroups, after });
    const matches = [...this.deals.values()].filter((deal) =>
      filterGroups.some((group) => group.filters.every((filter) => matchFilter(deal, filter))),
    );
    const sortBy = sorts?.[0]?.propertyName ?? 'hs_object_id';
    const direction = sorts?.[0]?.direction === 'DESCENDING' ? -1 : 1;
    matches.sort((a, b) => direction * (sortValue(a, sortBy) - sortValue(b, sortBy)));
    const start = Number(after ?? 0);
    const page = matches.slice(start, start + limit);
    return {
      results: page.map((deal) => ({ id: deal.id, properties: pick(deal.properties, properties) })),
      after: start + limit < matches.length ? String(start + limit) : undefined,
    };
  }

  async getAssociatedIds(fromType, fromId, toType) {
    this.#record('getAssociatedIds', fromType, fromId, toType);
    if (toType === 'quotes') return this.quotes.get(String(fromId)) ?? [];
    return this.dealLineItems(fromId).map((li) => li.id);
  }

  async readLineItems(ids, properties) {
    this.#record('readLineItems', ids);
    return ids
      .map((id) => this.lineItems.get(String(id)))
      .filter(Boolean)
      .map((li) => ({ id: li.id, properties: pick(li.properties, properties) }));
  }

  async createLineItems(dealId, propertiesList) {
    this.#record('createLineItems', dealId, propertiesList);
    if (this.beforeCreate) await this.beforeCreate();
    return propertiesList.map((properties) => {
      const product = this.products.find((p) => p.id === properties.hs_product_id);
      // Like HubSpot, copy name and price from the product when not given.
      const merged = { name: product?.properties.name ?? null, price: product?.properties.price ?? null, ...properties };
      const id = this.addLineItem(dealId, merged);
      return { id, properties: merged };
    });
  }

  async updateLineItems(updates) {
    this.#record('updateLineItems', updates);
    for (const { id, properties } of updates) Object.assign(this.lineItems.get(String(id)).properties, properties);
  }

  async archiveLineItems(ids) {
    this.#record('archiveLineItems', ids);
    ids.forEach((id) => this.lineItems.delete(String(id)));
  }

  async findProductsBySku(skus) {
    this.#record('findProductsBySku', skus);
    const wanted = new Set(skus.map((s) => s.toLowerCase()));
    return this.products.filter((p) => wanted.has(String(p.properties.hs_sku).toLowerCase()));
  }

  async readProducts(ids) {
    return this.products.filter((p) => ids.includes(p.id));
  }
}

function pick(properties, names) {
  return Object.fromEntries(names.map((name) => [name, properties[name] ?? null]));
}

function toMs(value) {
  return /^\d+$/.test(String(value)) ? Number(value) : Date.parse(value);
}

function sortValue(deal, name) {
  if (name === 'hs_object_id') return Number(deal.id);
  return toMs(deal.properties[name]);
}

function matchFilter(deal, { propertyName, operator, value }) {
  const actual = propertyName === 'hs_object_id' ? deal.id : deal.properties[propertyName];
  switch (operator) {
    case 'HAS_PROPERTY':
      return actual !== null && actual !== undefined && actual !== '';
    case 'EQ':
      return String(actual) === String(value);
    case 'GT':
      return Number(actual) > Number(value);
    case 'GTE':
      return propertyName === 'hs_lastmodifieddate' ? toMs(actual) >= toMs(value) : Number(actual) >= Number(value);
    default:
      throw new Error(`fake search: unsupported operator ${operator}`);
  }
}
