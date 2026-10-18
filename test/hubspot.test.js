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
  assert.equal(requests[0].url.pathname, '/crm/v3/objects/deals/7');
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
    assert.match(err.message, /PATCH \/crm\/v3\/objects\/deals\/7 failed \(400\): Property values were not valid/);
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

test('follows association paging', async () => {
  const { fetch, requests } = fakeFetch((req) =>
    req.url.searchParams.get('after')
      ? { body: { results: [{ toObjectId: 3 }] } }
      : { body: { results: [{ toObjectId: 1 }, { toObjectId: 2 }], paging: { next: { after: 'abc' } } } },
  );
  const ids = await clientWith(fetch).getAssociatedIds('deals', '7', 'line_items');
  assert.deepEqual(ids, ['1', '2', '3']);
  assert.equal(requests[0].url.pathname, '/crm/v4/objects/deals/7/associations/line_items');
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

test('searches deals modified since a time, oldest first', async () => {
  const { fetch, requests } = fakeFetch(() => ({ body: { results: [{ id: '1' }], paging: { next: { after: '200' } } } }));
  const page = await clientWith(fetch).searchDealsModifiedSince(1760000000000, ['seats'], { after: '0', limit: 200 });
  assert.deepEqual(page, { results: [{ id: '1' }], after: '200' });
  assert.equal(requests[0].url.pathname, '/crm/v3/objects/deals/search');
  assert.deepEqual(requests[0].body, {
    filterGroups: [{ filters: [{ propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: '1760000000000' }] }],
    sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
    properties: ['seats'],
    limit: 200,
    after: '0',
  });
});
