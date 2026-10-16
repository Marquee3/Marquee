// In-memory stand-in for HubSpotClient, implementing the same methods.

export class FakeHubSpot {
  constructor({ deals = {}, products = [] } = {}) {
    this.nextId = 1000;
    this.deals = new Map(Object.entries(deals).map(([id, properties]) => [id, { id, properties: { ...properties } }]));
    this.products = products.map((p) => ({ id: String(p.id), properties: { ...p } }));
    this.lineItems = new Map(); // id -> { id, properties, dealId }
    this.quotes = new Map(); // dealId -> [quoteIds]
    this.calls = [];
    // Hook to pause between reading line items and creating them, to
    // simulate two syncs of the same deal racing.
    this.beforeCreate = null;
  }

  #record(name, ...args) {
    this.calls.push({ name, args });
  }

  writeCalls() {
    return this.calls.filter((c) => ['createLineItems', 'updateLineItems', 'archiveLineItems'].includes(c.name));
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
    const picked = Object.fromEntries(properties.map((name) => [name, deal.properties[name] ?? null]));
    return { id: deal.id, properties: picked };
  }

  async updateDeal(dealId, properties) {
    this.#record('updateDeal', dealId, properties);
    Object.assign(this.deals.get(String(dealId)).properties, properties);
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
      .map((li) => ({ id: li.id, properties: Object.fromEntries(properties.map((p) => [p, li.properties[p] ?? null])) }));
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
