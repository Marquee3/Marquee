// Resolves product SKUs from the calculator config to HubSpot product IDs,
// with a short cache so a burst of syncs doesn't repeat the same searches.

export class ProductResolver {
  #hubspot;
  #ttlMs;
  #now;
  #cache = new Map();

  constructor(hubspot, { ttlMs = 10 * 60_000, now = Date.now } = {}) {
    this.#hubspot = hubspot;
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  /** @returns {Promise<{ products: Map<string, { id, properties }>, errors: string[] }>} */
  async resolve(skus) {
    const products = new Map();
    const errors = [];
    const lookup = [];

    for (const sku of new Set(skus)) {
      const cached = this.#cache.get(normalize(sku));
      if (cached && cached.expires > this.#now()) products.set(sku, cached.product);
      else lookup.push(sku);
    }
    if (!lookup.length) return { products, errors };

    const bySku = new Map();
    for (const product of await this.#hubspot.findProductsBySku(lookup)) {
      const sku = normalize(product.properties?.hs_sku ?? '');
      if (!bySku.has(sku)) bySku.set(sku, []);
      bySku.get(sku).push(product);
    }

    for (const sku of lookup) {
      const matches = bySku.get(normalize(sku)) ?? [];
      if (matches.length === 1) {
        products.set(sku, matches[0]);
        // Only hits are cached, so a product added to the library is picked
        // up on the next sync.
        this.#cache.set(normalize(sku), { product: matches[0], expires: this.#now() + this.#ttlMs });
      } else if (matches.length === 0) {
        errors.push(`no product in the HubSpot product library has SKU "${sku}"`);
      } else {
        errors.push(
          `${matches.length} products share SKU "${sku}" (IDs ${matches.map((p) => p.id).join(', ')}); ` +
            'make the SKU unique or reference the product by id in the config',
        );
      }
    }
    return { products, errors };
  }
}

function normalize(sku) {
  return String(sku).trim().toLowerCase();
}
