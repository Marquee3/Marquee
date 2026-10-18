# Calculator line items for HubSpot

A small service that turns the pricing your calculators put on a HubSpot deal into the deal's
**line items**, with the right products and quantities, so the team only has to review them and
create the quote.

- **Built to grow.** Each calculator is one small file in `config/calculators/`. To support a
  new calculator, add a file. Nothing else changes, not even the HubSpot app's settings (see
  [Adding a calculator](#adding-a-calculator)).
- **Dynamic quantities and prices.** Quantities, prices and line names are formulas over deal
  properties, e.g. `ceil(licence_seats / 25)`.
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
 A calculator writes its results to deal properties
            │
            ▼
 The service notices the deal changed:
   • every minute it asks HubSpot for recently changed deals (works for any calculator), and/or
   • HubSpot webhooks tell it straight away (optional)
            │
            ▼
 Sync the deal (one sync per deal at a time)
   1. read the deal's calculator properties
   2. evaluate every calculator → the line items the deal should have
   3. look up products by SKU in the product library
   4. compare with the line items already on the deal
   5. create / update / remove only the calculators' own line items
   6. write status + summary to the deal: "Ready for review"
```

Each line item the service creates has a **Calculator line key** property (`calc_line_key`), set
to `<calculator id>:<line key>`, e.g. `licences:seats`. That key is how it recognises its own line
items on later syncs.

### What a sync changes

| Situation | What happens |
| --- | --- |
| Calculator output now includes a line the deal doesn't have | Line item created from the product |
| Quantity / price / name changed | Existing line item updated in place |
| Line no longer in the output (excluded, quantity 0, calculator no longer applies) | That line item removed |
| The line's product changed | Old line item removed, new one created from the new product |
| Line items added by hand (no calculator key) | **Never touched** |
| Discounts, tax or other fields the team edits on a calculator line | **Kept**; only quantity, position and (if configured) price, name and description are managed |
| Calculator output unchanged since last sync | Nothing written, so manual tweaks survive unrelated edits to the deal |
| Deal has a quote | Nothing changed; status says why (configurable) |
| "Calculator line items: freeze" ticked | Nothing changed; unticking re-syncs |
| A calculator input is blank or invalid | Nothing changed; status "Needs attention" says which property |
| No calculator applies and the service has never touched the deal | Nothing read beyond the deal, nothing written |

### How duplicates are prevented

1. **Keyed line items.** Syncs match existing line items by `calc_line_key` and update them, so
   running a sync twice gives the same result as running it once.
2. **Debounce and per-deal serialization.** A calculator often writes several properties, and
   each can trigger the service. It waits until a deal has been quiet for 5 seconds, then runs one
   sync. It never runs two syncs of the same deal at once.
3. **Clean-up after creating.** After creating line items, the service re-reads the deal. If the
   same key now appears twice, it keeps the copy with the lowest ID and removes the rest. This
   catches a second server instance or a retried request that had in fact gone through. Every
   process picks the same copy to keep, so two clean-ups can never remove all of them.

## Adding a calculator

A calculator here is whatever puts numbers on a deal: a HubSpot calculation property, a form, a
workflow, an external pricing tool. The service only needs those numbers to land in **deal
properties**. To support a new one:

1. **Make sure its outputs are deal properties**, and note their *internal* names (Settings →
   Properties → the property → internal name).
2. **Make sure its products are in the product library** with a SKU (or note their product IDs).
3. **Create the calculator file:**

   ```sh
   npm run new-calculator -- training "Training calculator"
   ```

   This creates `config/calculators/training.json` with placeholders. Fill it in (see
   [Calculator file reference](#calculator-file-reference), and the two worked examples in
   [`examples/calculators/`](examples/calculators/)):

   ```json
   {
     "id": "training",
     "name": "Training calculator",
     "appliesWhen": "training_places > 0",
     "lineItems": [
       { "key": "places", "product": { "sku": "TRN-PLACE" }, "quantity": "training_places", "unitPrice": "training_price" },
       { "key": "materials", "product": { "sku": "TRN-PACK" }, "quantity": "ceil(training_places / 10)" }
     ]
   }
   ```

4. **Check it:** `npm run check` validates every calculator file and confirms the properties and
   SKUs exist in HubSpot. Then `npm run plan -- <test deal id>` shows exactly what the new
   calculator would add to a real deal, without changing anything.
5. **Deploy:** commit the file and redeploy. Most hosts redeploy automatically on a push. On the
   next poll (within a minute), deals using the new calculator get their line items.

That's all: no code changes, and no changes to the HubSpot app. If you use webhooks for instant
updates, re-run `npm run webhooks` and add the new calculator's properties to the subscriptions.
Until you do, the minute-by-minute poll still covers it.

Calculators are independent: a deal can use one, several or none. Each owns only its own lines.
Files load in name order, which is also the order lines appear on the deal (prefix names with
`10-`, `20-`… to control it). **Don't rename** a calculator's `id` or a line's `key` once it's
live: existing deals' lines would look new, so they'd be removed and recreated on the next sync.

## Setting it up

### 1. Create the HubSpot app

The service needs an access token. A client secret is only needed if you add webhooks. Either kind
of app works.

**Option A: Legacy private app (quickest; must be created before 26 October 2026).**
In HubSpot: *Settings → Integrations → Private apps* (may be labelled *Legacy apps*) → *Create*.

- **Scopes:** `crm.objects.deals.read`, `crm.objects.deals.write`, `crm.objects.line_items.read`,
  `crm.objects.line_items.write`, `crm.objects.quotes.read` and `e-commerce` (products).
  `npm run setup` and `npm run check` also need permission to read and create deal properties
  (`crm.schemas.deals.read` / `crm.schemas.deals.write`). If HubSpot labels scopes differently,
  pick the equivalents.
- **Token** (and client secret, for webhooks): the app's *Auth* tab.

**Option B: Project-based app (HubSpot's replacement for private apps).**
`hubspot-project/` holds the app definition (`app-hsmeta.json`: static auth, private
distribution, the scopes above). With the
[HubSpot CLI](https://developers.hubspot.com/docs/developer-tooling/local-development/hubspot-cli/install-the-cli)
installed: `cd hubspot-project && hs project upload`, install the app in your account, and copy
its static access token. These files follow HubSpot's documented format but haven't yet been
uploaded to HubSpot. If `hs project upload` rejects a field, fix it as the CLI says; nothing in
the service depends on these files.

### 2. Check it locally

Needs Node.js 20.12 or later.

```sh
cp .env.example .env              # add HUBSPOT_ACCESS_TOKEN
npm test                          # unit tests, no HubSpot needed
npm run setup                     # create the app's deal + line item properties (safe to re-run)
npm run new-calculator -- …       # add your first calculator (see above)
npm run check                     # config valid? properties and SKUs exist in HubSpot?
npm run plan -- 123456789         # dry run on a real deal: shows the lines and changes, writes nothing
npm run sync -- 123456789         # actually sync that deal
```

`setup` creates these properties (or create them by hand in *Settings → Properties*; the
definitions are in `src/properties.js`):

| Object | Property | Purpose |
| --- | --- | --- |
| Deal | Calculator line items: status | Ready for review / Skipped / Needs attention |
| Deal | Calculator line items: details | What the last sync did, or what to fix |
| Deal | Calculator line items: last updated | When the status last changed |
| Deal | Calculator line items: freeze | Tick to stop changes; untick to re-sync |
| Deal | Calculator line items: fingerprint | Internal: skips no-op syncs |
| Line item | Calculator line key | Marks line items the service owns |

### 3. Deploy

Any host that runs Node.js 20.12+ (or the included `Dockerfile`) works, e.g. Render, Railway,
Fly.io, Google Cloud Run or a small VM. Run **one instance**. More are safe because of the
clean-up step, but one is all this needs. Start command: `npm start`. Choose a host that
redeploys on a push, and adding a calculator is just a commit.

| Variable | | |
| --- | --- | --- |
| `HUBSPOT_ACCESS_TOKEN` | required | App access token |
| `SYNC_POLL_SECONDS` | default 60 | How often to check HubSpot for changed deals; `0` turns polling off (webhooks only) |
| `SYNC_POLL_LOOKBACK_MINUTES` | default 60 | On startup, how far back to look, to catch changes made while the service was down |
| `HUBSPOT_CLIENT_SECRET` | for webhooks | Verifies webhook signatures; webhooks are refused without it |
| `PUBLIC_URL` | for webhooks | e.g. `https://line-items.example.com`; the URL HubSpot signs. Without it, the URL is rebuilt from proxy headers |
| `HUBSPOT_PORTAL_ID` | optional | Ignore webhooks from other HubSpot accounts |
| `SYNC_API_KEY` | optional | Enables `POST /sync` |
| `SYNC_DEBOUNCE_MS` | default 5000 | Quiet period before syncing a deal |
| `SYNC_CONCURRENCY` | default 2 | Deals synced in parallel |
| `CONFIG_DIR` | default `config` | Folder holding `settings.json` and `calculators/` |
| `PORT` | default 3000 | |

The poll uses HubSpot's search API: one request per minute, plus one read per changed deal that
uses a calculator. That is well inside HubSpot's API limits.

### 4. Optional: webhooks for instant updates

With polling, line items appear within about a minute. For near-instant updates, add webhooks:

```sh
npm run webhooks
```

This lists the deal properties to subscribe to: every property the calculators read, plus the
freeze checkbox. In a legacy private app, add a **Deal → Property changed** subscription for each
one on the *Webhooks* tab, with target URL `https://<your host>/webhooks/hubspot`. For a project
app, run `npm run webhooks -- --target-url https://<your host>` to write
`hubspot-project/src/app/webhooks/webhooks-hsmeta.json`, then `hs project upload`. Set
`HUBSPOT_CLIENT_SECRET` and `PUBLIC_URL`. Polling keeps running alongside webhooks as a safety
net.

**Workflow alternative:** with Operations Hub Professional, a deal workflow's *Send a webhook*
action can POST to `https://<your host>/sync` with header `Authorization: Bearer <SYNC_API_KEY>`.

### 5. Team workflow

1. The calculator fills in the deal. Shortly after, the line items appear and
   **Calculator line items: status** shows *Ready for review*, with a summary in *details*.
2. Add those two properties to the deal sidebar and to a saved deal view filtered to
   *Ready for review*. That view is the review queue.
3. Adjust anything by hand if needed: add lines, change discounts. Then create the quote.
   - Once a quote exists, the service stops changing the deal's line items.
   - To lock a deal's line items without a quote, tick **freeze**.
4. *Needs attention* means the calculator output couldn't become line items, for example a
   blank input or an unknown SKU. *Details* names the property or SKU. Fix it and the deal
   re-syncs on the next poll.

## Calculator file reference

One calculator per file in `config/calculators/`:

```jsonc
{
  "id": "licences",                       // letters, numbers, - and _; unique; part of each line's key
  "name": "Licence calculator",           // used in status messages
  "appliesWhen": "licence_seats > 0",     // optional: when false, this calculator's lines are removed
  "lineItems": [
    {
      "key": "seats",                     // unique within the calculator
      "product": { "sku": "LIC-SEAT" },   // or { "id": "1234567" } (HubSpot product ID)
      "quantity": "licence_seats",
      "unitPrice": "licence_price_per_seat", // optional: price per unit
      // "totalPrice": "...",             // optional instead: line total; divided by quantity
      "includeWhen": "support_tier == \"premium\"", // optional
      "name": "Licences ({{licence_seats}} seats)", // optional
      "description": "..."                // optional, same {{ }} templates
    }
  ]
}
```

- Leave out `unitPrice`/`totalPrice` to use the product library price. Leave out `name` to use the
  product name.
- A quantity of **0 leaves the line off**, so "no travel" needs no special rule. Negative
  quantities and prices are errors.
- Keys starting with `$` (e.g. `"$comment"`) are ignored, so you can annotate the JSON. Unknown
  fields are errors, which catches typos.

### Settings

`config/settings.json` applies to all calculators:

| Setting | Default | |
| --- | --- | --- |
| `skipWhenQuoteExists` | `true` | Leave a deal's line items alone once it has a quote |
| `setLineOrder` | `true` | Order lines on the deal as in the config (`hs_position_on_quote`) |
| `syncWhen` | none | Formula; deals that don't match are ignored entirely, e.g. `"dealstage != \"closedwon\""` |

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
- Comparisons with a blank are false, so `licence_seats > 0` is just false on deals without seats.
- Checkbox values work as true/false: `includeWhen: "needs_onboarding"`.

## Operating it

| Endpoint | |
| --- | --- |
| `GET /health` | Liveness check |
| `POST /webhooks/hubspot` | HubSpot webhooks (v3 signature required) |
| `POST /sync` | `{"dealId": "123"}` or `{"dealIds": [...]}` or a workflow webhook payload; `Authorization: Bearer <SYNC_API_KEY>`. Add `?wait=true` to get the result, `&force=true` to re-apply even if unchanged |

Logs are one JSON object per line: a `deal sync` entry per sync, with its outcome (`synced`,
`unchanged`, `skipped`, `noop`, `error`), and a `deal poll` entry when a poll finds changed deals.
After each sync, the next poll sees the deal changed (the service just wrote its status) and
checks it once more. That check finds nothing to do and writes nothing, so it stops there.

To re-run a deal by hand: `npm run sync -- <dealIds…>` (add `--force` to re-apply even if the
calculator output hasn't changed), or tick and untick freeze on the deal.

## Limitations and things to verify

- **Not yet run against a live HubSpot account.** The test suite runs against a simulated
  HubSpot, and the API calls follow HubSpot's documentation. Before going live, run `npm run plan`
  then `npm run sync` on a test deal and check the result in HubSpot.
- **Calculator changes need a redeploy.** Calculators are files in this repository, so adding or
  editing one means a commit and a deploy, not a change in HubSpot's UI.
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
config/settings.json        settings for all calculators
config/calculators/         one file per calculator (add yours here)
examples/calculators/       worked examples to copy from
src/server.js               HTTP endpoints, starts the poller
src/poller.js               finds recently changed deals
src/sync.js                 the sync: evaluate → compare → apply → status
src/calculators.js          evaluates calculator rules for a deal
src/config.js               loads and validates the config folder
src/expression.js           the formula language (no eval)
src/reconcile.js            diffing and duplicate detection
src/queue.js                debounce + one sync per deal at a time
src/hubspot.js              HubSpot API client (all endpoint paths)
src/webhooks.js             webhook signature check and event parsing
src/cli.js                  new-calculator / check / setup / plan / sync / webhooks
hubspot-project/            app definition for HubSpot's project-based apps
test/                       node --test suites
```
