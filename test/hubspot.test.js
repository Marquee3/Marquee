import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HubSpotClient, HubSpotError } from '../src/hubspot.js';

function fakeFetch(handler) {
  const requests = [];
  const fetch = async (url, init) => {
    const request = { url: new URL(url), method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
    requests.push(request);
    const { status = 200, body, headers = {} } = (await handler(request, requests.length)) ?? {};
    return new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status, headers });
  };
  return { fetch, requests };
}

const clientWith = (fetch) => new HubSpotClient({ accessToken: 'pat-123', fetch, sleep: async () => {} });

test('sends the token and reads a deal with the requested properties', async () => {
  const { fetch, requests } = fakeFetch(() => ({ body: { id: '7', properties: { dealname: 'X' } } }));
  const deal = await clientWith(fetch).getDeal('7', ['dealname', 'amount']);
  assert.equal(deal.id, '7');
  assert.equal(requests[0].headers.authorization, 'Bearer pat-123');
  assert.equal(requests[0].url.pathname, '/crm/objects/2026-09/deals/7');
  assert.equal(requests[0].url.searchParams.get('properties'), 'dealname,amount');
});

test('retries rate limits and server errors, then succeeds', async () => {
  const { fetch, requests } = fakeFetch((_, n) => (n < 3 ? { status: n === 1 ? 429 : 502, body: { message: 'slow down' } } : { body: { results: [] } }));
  await clientWith(fetch).getProperties('deals');
  assert.equal(requests.length, 3);
});

test('does not retry client errors and reports HubSpot\'s message', async () => {
  const { fetch, requests } = fakeFetch(() => ({ status: 400, body: { message: 'Property values were not valid', category: 'VALIDATION_ERROR' } }));
  await assert.rejects(clientWith(fetch).updateDeal('7', { x: 1 }), (err) => {
    assert.ok(err instanceof HubSpotError);
    assert.equal(err.status, 400);
    assert.match(err.message, /PATCH \/crm\/objects\/2026-09\/deals\/7 failed \(400\): Property values were not valid/);
    return true;
  });
  assert.equal(requests.length, 1);
});

test('creates line items in batches of 100, associated to the deal', async () => {
  const { fetch, requests } = fakeFetch((req) => ({ status: 201, body: { results: req.body.inputs.map((_, i) => ({ id: String(i) })) } }));
  const created = await clientWith(fetch).createLineItems('7', Array.from({ length: 150 }, (_, i) => ({ quantity: String(i) })));
  assert.equal(created.length, 150);
  assert.deepEqual(requests.map((r) => r.body.inputs.length), [100, 50]);
  assert.deepEqual(requests[0].body.inputs[0].associations, [
    { to: { id: '7' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 20 }] },
  ]);
});

test('batch partial failures (207) are errors', async () => {
  const { fetch } = fakeFetch(() => ({ status: 207, body: { results: [{ id: '1' }], errors: [{ message: 'Property "calc_line_key" does not exist' }] } }));
  await assert.rejects(clientWith(fetch).createLineItems('7', [{}, {}]), /calc_line_key/);
});

test('reads associations with the batch endpoint and follows its paging', async () => {
  const { fetch, requests } = fakeFetch((req) =>
    req.body.inputs[0].after
      ? { body: { results: [{ from: { id: '7' }, to: [{ toObjectId: 3 }] }] } }
      : { body: { results: [{ from: { id: '7' }, to: [{ toObjectId: 1 }, { toObjectId: 2 }], paging: { next: { after: 'abc' } } }] } },
  );
  const ids = await clientWith(fetch).getAssociatedIds('deals', '7', 'line_items');
  assert.deepEqual(ids, ['1', '2', '3']);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].url.pathname, '/crm/associations/2026-09/deals/line_items/batch/read');
  assert.deepEqual(requests[0].body, { inputs: [{ id: '7' }] });
  assert.deepEqual(requests[1].body, { inputs: [{ id: '7', after: 'abc' }] });
});

test('a deal with no associations has no results entry', async () => {
  const { fetch } = fakeFetch(() => ({ body: { results: [] } }));
  assert.deepEqual(await clientWith(fetch).getAssociatedIds('deals', '7', 'quotes', { max: 1 }), []);
});

test('uses date-based API paths, or the numbered ones with apiVersion "legacy"', async () => {
  const seen = [];
  for (const apiVersion of ['2026-09', '2027-03', 'legacy']) {
    const { fetch, requests } = fakeFetch(() => ({ body: { results: [] } }));
    const client = new HubSpotClient({ accessToken: 't', apiVersion, fetch, sleep: async () => {} });
    await client.getDeal('7', ['dealname']);
    await client.readLineItems(['1'], ['quantity']);
    await client.getAssociatedIds('deals', '7', 'line_items');
    await client.getProperties('deals');
    await client.searchDeals({ filterGroups: [], properties: [] });
    seen.push(requests.map((r) => r.url.pathname));
  }
  assert.deepEqual(seen[0], [
    '/crm/objects/2026-09/deals/7',
    '/crm/objects/2026-09/line_items/batch/read',
    '/crm/associations/2026-09/deals/line_items/batch/read',
    '/crm/properties/2026-09/deals',
    '/crm/objects/2026-09/deals/search',
  ]);
  assert.equal(seen[1][0], '/crm/objects/2027-03/deals/7');
  assert.deepEqual(seen[2], [
    '/crm/v3/objects/deals/7',
    '/crm/v3/objects/line_items/batch/read',
    '/crm/v4/associations/deals/line_items/batch/read',
    '/crm/v3/properties/deals',
    '/crm/v3/objects/deals/search',
  ]);
  assert.throws(() => new HubSpotClient({ accessToken: 't', apiVersion: 'v3' }), /HUBSPOT_API_VERSION must look like 2026-09/);
});

test('searches products by SKU, 5 per request', async () => {
  const { fetch, requests } = fakeFetch(() => ({ body: { results: [] } }));
  await clientWith(fetch).findProductsBySku(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].body.filterGroups[0], { filters: [{ propertyName: 'hs_sku', operator: 'EQ', value: 'a' }] });
  assert.equal(requests[1].body.filterGroups.length, 2);
});

test('archive returns nothing (204)', async () => {
  const { fetch, requests } = fakeFetch(() => ({ status: 204 }));
  await clientWith(fetch).archiveLineItems(['1', '2']);
  assert.deepEqual(requests[0].body, { inputs: [{ id: '1' }, { id: '2' }] });
});

test('searches deals with the given filters', async () => {
  const { fetch, requests } = fakeFetch(() => ({ body: { results: [{ id: '1' }], paging: { next: { after: '200' } } } }));
  const filterGroups = [{ filters: [{ propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: '1760000000000' }] }];
  const sorts = [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }];
  const page = await clientWith(fetch).searchDeals({ filterGroups, sorts, properties: ['seats'], after: '0' });
  assert.deepEqual(page, { results: [{ id: '1' }], after: '200' });
  assert.equal(requests[0].url.pathname, '/crm/objects/2026-09/deals/search');
  assert.deepEqual(requests[0].body, { filterGroups, sorts, properties: ['seats'], limit: 200, after: '0' });
});

test('reads the token\'s own account and permissions', async () => {
  const { fetch, requests } = fakeFetch(() => ({ body: { hubId: 1, scopes: ['crm.objects.deals.read'] } }));
  const info = await clientWith(fetch).getTokenInfo();
  assert.deepEqual(info.scopes, ['crm.objects.deals.read']);
  assert.equal(requests[0].url.pathname, '/oauth/v2/private-apps/get/access-token-info');
  assert.deepEqual(requests[0].body, { tokenKey: 'pat-123' });
});

test('lists every product, page by page', async () => {
  const { fetch, requests } = fakeFetch((req) =>
    req.url.searchParams.get('after') ? { body: { results: [{ id: '3' }] } } : { body: { results: [{ id: '1' }, { id: '2' }], paging: { next: { after: 'x' } } } },
  );
  const products = await clientWith(fetch).listProducts();
  assert.deepEqual(products.map((p) => p.id), ['1', '2', '3']);
  assert.equal(requests[0].url.pathname, '/crm/objects/2026-09/products');
  assert.equal(requests[0].url.searchParams.get('properties'), 'name,hs_sku,price');
});
