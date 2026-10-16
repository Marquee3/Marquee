# Calculator line items for HubSpot

A small service that turns the pricing your calculators put on a HubSpot deal into the deal's
**line items**, with the right products and quantities, so the team only has to review them and
create the quote.

- **Multiple calculators.** Each calculator is a block of rules in `config/calculators.json`. A deal
  can use one, several or none.
- **Dynamic quantities and prices.** Quantities, prices and line names are formulas over deal
  properties, e.g. `ceil(marquee_width_m * marquee_length_m / 20)`.
- **No duplicates.** Re-running, retries and overlapping triggers update the existing line items
  rather than adding more (see [How duplicates are prevented](#how-duplicates-are-prevented)).
- **Ready for review.** Each sync writes a status and a plain-English summary on the deal. The
  service never touches line items the team added by hand, and it stops changing a deal once it
  has a quote.

It runs as a small Node.js web service with no npm dependencies. Hosting costs a few dollars a
month at most.

> [!IMPORTANT]
> **HubSpot is retiring legacy private apps.** Existing HubSpot accounts can't create *new*
> legacy private apps after **26 October 2026**. Apps created before then keep working.
> HubSpot ends support for legacy apps and the numbered (`/v3/`) APIs this service uses in
> **September 2027**. The service works with either kind of app; see
> [Step 1](#1-create-the-hubspot-app).

## How it works

```
 Calculator writes deal properties
            │
            ▼
 HubSpot webhook: "deal property changed"      (one event per property)
            │
            ▼
 POST /webhooks/hubspot ── verify signature ── wait 5s for the burst to settle
            │
            ▼
 Sync the deal (one sync per deal at a time)
   1. read the deal's calculator properties
   2. evaluate each calculator → the line items the deal should have
   3. look up products by SKU in the product library
   4. compare with the line items already on the deal
   5. create / update / remove only the calculator's own line items
   6. write status + summary to the deal: "Ready for review"
```

Each line item the service creates has a **Calculator line key** property (`calc_line_key`), set
to `<calculator id>:<line key>`, e.g. `marquee:flooring`. That key is how it recognises its own
line items on later syncs.

### What a sync changes

| Situation | What happens |
| --- | --- |
| Calculator output now includes a line the deal doesn't have | Line item created from the product |
| Quantity / price / name changed | Existing line item updated in place |
| Line no longer in the output (excluded, quantity 0, calculator no longer applies) | That line item removed |
| The line's product changed | Old line item removed, new one created from the new product |
| Line items added by hand (no calculator key) | **Never touched** |
| Discounts, tax or other fields the team edits on a calculator line | **Kept**; only quantity, position and (if configured) price, name and description are managed |
| Calculator output unchanged since last sync | Nothing written, so manual tweaks survive unrelated property changes |
| Deal has a quote | Nothing changed; status says why (configurable) |
| "Calculator line items: freeze" ticked | Nothing changed; unticking re-syncs |
| A calculator input is blank or invalid | Nothing changed; status "Needs attention" says which property |

### How duplicates are prevented

1. **Keyed line items.** Syncs match existing line items by `calc_line_key` and update them, so
   running a sync twice gives the same result as running it once.
2. **Debounce and per-deal serialization.** A calculator usually writes several properties, and
   HubSpot sends a separate webhook for each. The service waits until a deal has been quiet for 5
   seconds, then runs one sync. It never runs two syncs of the same deal at once.
3. **Clean-up after creating.** After creating line items, the service re-reads the deal. If the
   same key now appears twice, it keeps the copy with the lowest ID and removes the rest. This
   catches a second server instance or a retried request that had in fact gone through. Every
   process picks the same copy to keep, so two clean-ups can never remove all of them.

## Setting it up

### 1. Create the HubSpot app

You need an access token and a client secret (for webhook signatures). Either kind of app works.

**Option A: Legacy private app (quickest; must be created before 26 October 2026).**
In HubSpot: *Settings → Integrations → Private apps* (may be labelled *Legacy apps*) → *Create*.

- **Scopes:** `crm.objects.deals.read`, `crm.objects.deals.write`, `crm.objects.line_items.read`,
  `crm.objects.line_items.write`, `crm.objects.quotes.read` and `e-commerce` (products).
  `npm run setup` and `npm run check` also need permission to read and create deal properties
  (`crm.schemas.deals.read` / `crm.schemas.deals.write`). If HubSpot labels scopes differently,
  pick the equivalents.
- **Token:** *Auth* tab → access token. **Client secret:** same tab.
- **Webhooks:** *Webhooks* tab. Set the target URL (`https://<your host>/webhooks/hubspot`) once the
  service is deployed (step 4).

**Option B: Project-based app (HubSpot's replacement for private apps).**
`hubspot-project/` holds the app definition (`app-hsmeta.json`, static auth, private
distribution) and the webhook subscriptions (`webhooks/webhooks-hsmeta.json`). Install the
[HubSpot CLI](https://developers.hubspot.com/docs/developer-tooling/local-development/hubspot-cli/install-the-cli),
then:

```sh
npm run webhooks -- --target-url https://<your host>    # fill in subscriptions + target URL
cd hubspot-project && hs project upload
```

Then install the app in your account and copy its static access token and client secret from the
app's settings. These files follow HubSpot's documented format but haven't yet been uploaded to
HubSpot. If `hs project upload` rejects a field, fix it as the CLI says; nothing in the service
depends on these files.

### 2. Describe your calculators

Edit `config/calculators.json`. The shipped file is an **example** (a marquee calculator and a
furniture calculator) to replace with your real deal properties and product SKUs. See the
[config reference](#calculator-config-reference) below.

### 3. Check it locally

Needs Node.js 20.12 or later.

```sh
cp .env.example .env              # add HUBSPOT_ACCESS_TOKEN
npm test                          # unit tests, no HubSpot needed
npm run check                     # config valid? properties and SKUs exist in HubSpot?
npm run setup                     # create the app's deal + line item properties (safe to re-run)
npm run plan -- 123456789         # dry run on a real deal: shows the lines and changes, writes nothing
npm run sync -- 123456789         # actually sync that deal
```

`setup` creates these properties (or create them by hand in *Settings → Properties*; the
definitions are in `src/properties.js`):

| Object | Property | Purpose |
| --- | --- | --- |
| Deal | Calculator line items: status | Ready for review / Skipped / Needs attention |
| Deal | Calculator line items: details | What the last sync did, or what to fix |
| Deal | Calculator line items: last synced | When |
| Deal | Calculator line items: freeze | Tick to stop changes; untick to re-sync |
| Deal | Calculator line items: fingerprint | Internal: skips no-op syncs |
| Line item | Calculator line key | Marks line items the service owns |

### 4. Deploy

Any host that runs Node.js 20.12+ (or the included `Dockerfile`) behind HTTPS works, e.g. Render,
Railway, Fly.io, Google Cloud Run or a small VM. Run **one instance**. More are safe because of
the clean-up step, but one is all this needs. Start command: `npm start`.

| Variable | Required | |
| --- | --- | --- |
| `HUBSPOT_ACCESS_TOKEN` | yes | App access token |
| `HUBSPOT_CLIENT_SECRET` | yes | Verifies webhook signatures; unsigned webhooks are refused |
| `PUBLIC_URL` | recommended | e.g. `https://line-items.example.com`; the URL HubSpot signs. Without it, the URL is rebuilt from proxy headers |
| `HUBSPOT_PORTAL_ID` | no | Ignore webhooks from other HubSpot accounts |
| `SYNC_API_KEY` | no | Enables `POST /sync` |
| `SYNC_DEBOUNCE_MS` | no | Quiet period before syncing (default 5000) |
| `SYNC_CONCURRENCY` | no | Deals synced in parallel (default 2) |
| `CALCULATORS_CONFIG` | no | Config path (default `config/calculators.json`) |
| `PORT` | no | Default 3000 |

### 5. Turn on webhooks

```sh
npm run webhooks
```

This lists the deal properties to subscribe to: every property the calculators read, plus the
freeze checkbox. In a legacy private app, add a **Deal → Property changed** subscription for each
one. For a project app, run it with `--target-url` (step 1) and upload.

> [!NOTE]
> If a calculator output is a HubSpot *calculation* property, HubSpot may not send change events
> for it. `npm run check` flags these; subscribe to the properties it is calculated from as well.

**No-webhook alternative:** if you have Operations Hub Professional, a deal workflow with a
*Send a webhook* action can POST to `https://<your host>/sync` with header
`Authorization: Bearer <SYNC_API_KEY>`. The service reads the deal ID from the workflow payload.

### 6. Team workflow

1. The calculator fills in the deal. Within a few seconds the line items appear and
   **Calculator line items: status** shows *Ready for review*, with a summary in *details*.
2. Add those two properties to the deal sidebar and to a saved deal view filtered to
   *Ready for review*. That view is the review queue.
3. Adjust anything by hand if needed: add lines, change discounts. Then create the quote.
   - Once a quote exists, the service stops changing the deal's line items.
   - To lock a deal's line items without a quote, tick **freeze**.
4. *Needs attention* means the calculator output couldn't become line items, for example a
   blank input or an unknown SKU. *Details* names the property or SKU. Fix it and the next change
   re-syncs; or tick and untick **freeze** to re-run straight away.

## Calculator config reference

```jsonc
{
  "settings": {
    "skipWhenQuoteExists": true,            // default true
    "setLineOrder": true,                   // default true: order lines as in this file (hs_position_on_quote)
    "syncWhen": "dealstage != \"closedwon\"" // optional: deals failing this are ignored entirely
  },
  "calculators": [
    {
      "id": "marquee",                       // letters, numbers, - and _; part of each line's key
      "name": "Marquee calculator",          // used in status messages
      "appliesWhen": "marquee_width_m > 0",  // optional: when false, this calculator's lines are removed
      "lineItems": [
        {
          "key": "flooring",                 // unique within the calculator; don't rename once live
          "product": { "sku": "MQ-FLOOR" },  // or { "id": "1234567" } (HubSpot product ID)
          "quantity": "marquee_width_m * marquee_length_m",
          "unitPrice": "marquee_floor_rate", // optional: price per unit
          // "totalPrice": "...",            // optional instead: line total; divided by quantity
          "includeWhen": "hasOption(marquee_extras, \"flooring\")", // optional
          "name": "Flooring ({{marquee_width_m}}m x {{marquee_length_m}}m)", // optional
          "description": "..."               // optional, same {{ }} templates
        }
      ]
    }
  ]
}
```

- Leave out `unitPrice`/`totalPrice` to use the product library price. Leave out `name` to use the
  product name.
- A quantity of **0 leaves the line off**, so "no heaters" needs no special rule. Negative
  quantities and prices are errors.
- Keys starting with `$` (e.g. `"$comment"`) are ignored, so you can annotate the JSON. Unknown
  fields are errors, which catches typos.
- **Renaming** a calculator `id` or line `key` makes existing deals' lines look new on their next
  sync: the old lines are removed and new ones created.

### Formulas

Formulas refer to deal properties by **internal name**.

| | |
| --- | --- |
| Arithmetic | `+ - * / %`, parentheses |
| Comparison | `== != < <= > >=` (text in quotes: `tier == "premium"`) |
| Logic | `&& \|\| !` |
| Functions | `ceil(x)` `floor(x)` `round(x, digits)` `min(a, b, …)` `max(a, b, …)` `abs(x)` |
| | `if(condition, then, else)`: only the chosen branch is evaluated |
| | `coalesce(a, b, …)`: first non-blank value, e.g. `coalesce(discount, 0)` |
| | `isBlank(x)` |
| | `hasOption(prop, "value")`: for multiple-checkbox properties |

- Blank properties are blank, not zero. Using one in arithmetic is an error that names the
  property; use `coalesce(prop, 0)` where blank should mean 0.
- Comparisons with a blank are false, so `guest_count > 0` is just false on deals without a
  guest count.
- Checkbox values work as true/false: `includeWhen: "needs_heating"`.

## Operating it

| Endpoint | |
| --- | --- |
| `GET /health` | Liveness check |
| `POST /webhooks/hubspot` | HubSpot webhooks (v3 signature required) |
| `POST /sync` | `{"dealId": "123"}` or `{"dealIds": [...]}` or a workflow webhook payload; `Authorization: Bearer <SYNC_API_KEY>`. Add `?wait=true` to get the result, `&force=true` to re-apply even if unchanged |

Logs are one JSON object per line, one `deal sync` entry per sync with its outcome
(`synced`, `unchanged`, `skipped`, `noop`, `error`).

Webhooks are answered at once and synced in the background. If the process restarts during
the 5-second wait, that sync is lost, but the next change to the deal triggers another. To
re-run by hand, use `npm run sync -- <dealIds…>` or tick and untick freeze.

## Limitations and things to verify

- **Not yet run against a live HubSpot account.** The test suite runs against a simulated
  HubSpot, and the API calls follow HubSpot's documentation. Before going live, run `npm run plan`
  then `npm run sync` on a test deal and check the result in HubSpot.
- **Line item order:** the service sets `hs_position_on_quote` in config order. HubSpot documents
  this property only lightly. If HubSpot rejects it, set `"setLineOrder": false` and reorder on
  the quote instead.
- **Multi-currency:** new line items get the deal's currency (`deal_currency_code`). If you
  don't set prices in the config, check that the product library price is right for that
  currency.
- **API versions:** all HubSpot endpoints are in `src/hubspot.js`. Before September 2027, move
  them to HubSpot's date-based API versions.
- If someone deletes a calculator line by hand, it stays deleted until the calculator output
  changes (or a forced sync).

## Project layout

```
config/calculators.json   calculator rules (edit this)
src/server.js             HTTP endpoints
src/sync.js               the sync: evaluate → compare → apply → status
src/calculators.js        evaluates calculator rules for a deal
src/expression.js         the formula language (no eval)
src/reconcile.js          diffing and duplicate detection
src/queue.js              debounce + one sync per deal at a time
src/hubspot.js            HubSpot API client (all endpoint paths)
src/webhooks.js           webhook signature check and event parsing
src/cli.js                check / setup / plan / sync / webhooks commands
hubspot-project/          app definition for HubSpot's project-based apps
test/                     node --test suites
```
