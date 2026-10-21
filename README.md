# Calculator line items for HubSpot

A small service that turns the pricing your calculators put on a HubSpot deal into the deal's
**line items**, with the right products and quantities, so the team only has to review them and
create the quote.

- **Built to grow.** Each calculator is one small file in `config/calculators/`. To support a new
  calculator, add a file and deploy. The HubSpot app doesn't need changing (see
  [Adding a calculator](#adding-a-calculator)).
- **Dynamic quantities and prices.** Quantities, prices and line names are formulas over deal
  properties, e.g. `ceil(licence_seats / 25)`.
- **No duplicates.** Re-running, retries and overlapping triggers update the existing line items
  rather than adding more (see [How duplicates are prevented](#how-duplicates-are-prevented)).
- **Ready for review, and respects the team's edits.** Each sync writes a status and a
  plain-English summary on the deal. A line is only re-applied when its own calculated values
  change. Line items added by hand are never touched, and the service stops changing a deal once
  it has a quote.

It runs on **Cloudflare Workers** (free plan, or $5/month for headroom) with a **HubSpot
project-based app**. It can also run as an ordinary Node.js service
([Running on a Node host](#running-on-a-node-host-instead)).

> [!IMPORTANT]
> **Built for HubSpot's current platform.** Legacy private apps can't be created after
> 26 October 2026 and go unsupported in September 2027. HubSpot's numbered APIs go
> unsupported too: `/v4/` on 30 March 2027 and `/v3/` in September 2027. This service uses a
> project-based app on developer platform `2026.09` and HubSpot's date-based API `2026-09`,
> both supported until at least March 2028. See [Staying current](#staying-current).

## How it works

```
 A calculator writes its results to deal properties
            │
            ▼
 Every minute (Cloudflare cron trigger)              Optional: HubSpot webhook
 search HubSpot for deals changed recently           for instant updates
 and work out which need a sync (no extra calls)             │
            │                                                │
            └──────────────► Cloudflare Queue ◄──────────────┘
                             one message per deal, one at a time, retried on failure
                                      │
                                      ▼
                             Sync the deal
                               1. evaluate every calculator → lines the deal should have
                               2. look up products by SKU in the product library
                               3. compare with the deal's line items
                               4. create / update / remove only lines whose output changed
                               5. write status + summary: "Ready for review"
```

Each line item the service creates has a **Calculator line key** property (`calc_line_key`), set
to `<calculator id>:<line key>`, e.g. `licences:seats`. That key is how it recognises its own line
items on later syncs.

### What a sync changes

| Situation | What happens |
| --- | --- |
| Calculator output includes a line the deal doesn't have yet | Line item created from the product |
| A line's calculated quantity / price / name changed | That line item is updated in place |
| A line is no longer in the output (excluded, quantity 0, calculator no longer applies) | That line item removed |
| A line's product changed | Old line item removed, new one created from the new product |
| A line's calculated values did **not** change | **Left as the team left it**: hand edits, or a deliberate deletion, stand |
| Line items added by hand (no calculator key) | **Never touched** |
| Discounts, tax or other fields the team edits | **Never touched**: only quantity, position and (if configured) price, name and description are managed |
| Line items from a calculator whose file was removed from the config | **Never touched** (`npm run plan` lists them) |
| Deal has a quote | Nothing changed; status says why (configurable). Not re-checked until the calculator output changes again |
| "Calculator line items: freeze" ticked | Nothing changed; unticking re-syncs |
| A calculator input is blank or invalid, or a SKU isn't in the product library | Nothing changed; status "Needs attention" says which property or SKU; re-checked every 15 minutes. Once fixed, only lines whose values changed are re-applied |
| No calculator applies and the service has never touched the deal | Nothing written |

### How duplicates are prevented

1. **Keyed line items.** Syncs match existing line items by `calc_line_key` and update them, so
   running a sync twice gives the same result as running it once.
2. **One sync at a time.** On Cloudflare, the queue processes one deal at a time; on a Node host,
   syncs of the same deal never overlap. Deals that changed in the last few seconds wait for the
   next check, so a calculator that writes several properties is synced once it's finished.
3. **Clean-up after creating.** After creating line items, the service re-reads the deal. If the
   same key now appears twice, it keeps the copy with the lowest ID and removes the rest. This
   catches a retried request that had in fact gone through, or a manual sync running alongside the
   service. Every process picks the same copy to keep, so two clean-ups can never remove all of
   them.

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

   This creates `config/calculators/training.json` with placeholders. Fill it in (see the
   [Calculator file reference](#calculator-file-reference) and the worked examples in
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
   SKUs exist in HubSpot. `npm run plan -- <test deal id>` shows exactly what the calculator would
   do to a real deal, without changing anything.
5. **Deploy:** commit the file and deploy (`npm run deploy`, or automatically on push if you
   connect the repository to Cloudflare). A broken calculator file fails the build, so it can't go
   live.
6. **Backfill existing deals:** deals changed after the deploy pick up the new calculator within
   a minute. Deals that already have its values but don't change again need a one-off sync:

   ```sh
   npm run sync -- --calculator training --dry-run   # see what would change
   npm run sync -- --calculator training             # do it
   ```

The HubSpot app doesn't need changing. If you've added webhooks for instant updates, also add the
new calculator's properties to them (`npm run webhooks`). Until then, the minute-by-minute check
covers it.

Calculators are independent: a deal can use one, several or none, and each owns only its own
lines. Files load in name order, which is also the order lines appear on the deal (prefix names
with `10-`, `20-`… to control it). **Don't rename** a calculator's `id` or a line's `key` once
it's live: existing deals' lines would look new, so they'd be removed and recreated on the next
sync. **Deleting a calculator file** leaves its existing lines on deals, so remove them by hand if
needed.

## Setting it up

### 1. Get an access token

**Already have a `pat-` access token** (for example from whoever manages the HubSpot account)?
Use it and skip creating an app. Put it in `.env` as `HUBSPOT_ACCESS_TOKEN` and run
`npm run check`. The first lines show which HubSpot account the token belongs to, and whether it
has every permission listed below. If the token comes from a *legacy* private app, it works until
HubSpot ends support for those in September 2027. Swapping in a token from a project-based app
(below) then is a settings change, with no code changes. A token used only by this service is
best: it can be rotated or revoked without affecting anything else.

**Otherwise, create the HubSpot app:**

The app gives the service an access token, plus a client secret if you add webhooks.
`hubspot-project/` holds the app definition: platform `2026.09`, private distribution, static
auth, and these scopes: `crm.objects.deals.read`, `crm.objects.deals.write`,
`crm.objects.line_items.read`, `crm.objects.line_items.write`, `crm.objects.quotes.read`,
`crm.schemas.deals.read`, `crm.schemas.deals.write`, `crm.schemas.line_items.read` and
`e-commerce` (products).

```sh
npm install -g @hubspot/cli     # HubSpot's CLI
hs account auth                 # connect it to your HubSpot account
cd hubspot-project && hs project upload
```

Then, in HubSpot, open the app (Development → Projects), install it in your account, and copy its
**access token** (and **client secret**, for webhooks) from the app's auth settings. If
`hs project upload` rejects a field (HubSpot's config format moves quickly), fix it as the CLI
says; nothing in the service depends on these files.


### 2. Try it locally

Needs Node.js 22 or later.

```sh
npm install                       # installs Wrangler (Cloudflare's CLI); the service itself has no dependencies
cp .env.example .env              # add HUBSPOT_ACCESS_TOKEN, for the commands below
npm test                          # unit tests, no HubSpot needed
npm run setup                     # create the app's deal + line item properties (safe to re-run)
npm run new-calculator -- …       # add your first calculator (see above)
npm run check                     # token's account and permissions; config valid; properties and SKUs exist?
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
| Deal | Calculator line items: fingerprint | Internal: which line values were last applied |
| Line item | Calculator line key | Marks line items the service owns |

### 3. Deploy to Cloudflare

One-off setup, from the repository folder:

```sh
npx wrangler login
npx wrangler queues create calculator-line-items
npx wrangler secret put HUBSPOT_ACCESS_TOKEN
npm run deploy
```

`npm run deploy` validates and bundles `config/` into the Worker, then deploys it with a cron
trigger (every minute) and the queue. To deploy automatically on every push, connect the GitHub
repository in the Cloudflare dashboard (Workers & Pages → the worker → Settings → Builds), using
`npx wrangler deploy` as the deploy command. Then adding a calculator really is just a commit.

Logs: `npx wrangler tail`, or the worker's Logs tab in the Cloudflare dashboard. Look for
`deal sync` and `deal poll` entries.

**Free plan or Paid ($5/month)?** Start on the free plan; move to Paid if the logs show runs
being cut short.
- **Requests and queue:** a minute-by-minute check is about 1,440 cron runs a day, plus about
  three Queue operations for each deal synced. That's inside the free plan's 100,000 requests and
  10,000 queue operations a day for up to roughly 3,000 deal syncs a day. A bulk change to many
  deals can queue some deals two or three times while the queue catches up, so it uses more; so
  does a deal stuck on "Needs attention" for a reason outside the deal (about 300 operations a
  day each, from the 15-minute re-check).
- **Per run:** the free plan gives each run 10 ms of CPU time and 50 outbound requests. One deal
  sync uses about 5–15 requests, and an ordinary check is a single search. The catch-up checks
  every 30 minutes look back an hour, which in a busy account can be several hundred deals and
  may go over 10 ms.
- **Cut-short runs lose nothing:** deals are queued as each search page is processed, and
  anything missed is picked up by the next catch-up.
- **Paid** removes these ceilings, and is the safer choice for busy accounts.

Optional Worker settings (`vars` in `wrangler.jsonc`, or the dashboard; `keep_vars` means
deploys keep what you set there):

| Variable | Default | |
| --- | --- | --- |
| `HUBSPOT_API_VERSION` | from `src/hubspot.js` | Overrides the HubSpot API version; `legacy` uses the old numbered APIs |
| `SYNC_POLL_WINDOW_MINUTES` | 3 | How far back each check looks. Keep it at least twice the cron interval, plus 1 |
| `SYNC_CATCH_UP_MINUTES` | 65 | Every 30 minutes, look back this far, to catch anything missed |
| `SYNC_ERROR_RECHECK_MINUTES` | 15 | How often deals showing "Needs attention" are re-checked |
| `SYNC_MAX_PAGES_PER_RUN` | 10 | Search pages (200 deals each) per check; more are picked up by later checks |
| `SYNC_DEBOUNCE_SECONDS` | 5 | Wait this long after a change before syncing |
| `HUBSPOT_PORTAL_ID` | none | Ignore webhooks from other HubSpot accounts |

To check less often, change the cron in `wrangler.jsonc` (e.g. `*/5 * * * *`) and raise
`SYNC_POLL_WINDOW_MINUTES` to match (e.g. 11).

### 4. Optional: webhooks for instant updates

With the minute-by-minute check, line items appear within about a minute. For near-instant
updates:

```sh
npm run webhooks -- --target-url https://calculator-line-items.<your-subdomain>.workers.dev
cd hubspot-project && hs project upload
npx wrangler secret put HUBSPOT_CLIENT_SECRET
```

This subscribes to "deal property changed" for every property the calculators read, plus the
freeze checkbox. Re-run it after adding a calculator. The minute-by-minute check keeps running
alongside as a safety net. These webhook config lines follow HubSpot's documented format but
haven't been uploaded to HubSpot yet. If the CLI rejects them, the service works without
webhooks.

**Workflow alternative:** with Operations Hub Professional, a deal workflow's *Send a webhook*
action can POST to `https://<your worker>/sync` with header `Authorization: Bearer <SYNC_API_KEY>`
(set it with `npx wrangler secret put SYNC_API_KEY`).

### 5. Team workflow

1. The calculator fills in the deal. Within about a minute, the line items appear and
   **Calculator line items: status** shows *Ready for review*, with a summary in *details*.
2. Add those two properties to the deal sidebar and to a saved deal view filtered to
   *Ready for review*. That view is the review queue.
3. Adjust anything by hand: add lines, change discounts or quantities. Your edits stay unless that
   line's calculated values change. Then create the quote.
   - Once a quote exists, the service stops changing the deal's line items.
   - To lock a deal's line items without a quote, tick **freeze**.
4. *Needs attention* means the calculator output couldn't become line items, for example a blank
   input or an unknown SKU. *Details* names the property or SKU. Fix it on the deal and it
   re-syncs within a minute. Fix it elsewhere (adding a product, correcting a calculator file)
   and it's picked up by the 15-minute re-check. Or tick and untick **freeze** to re-run at once.

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
- Without `appliesWhen`, a calculator applies to **every** deal; `npm run check` warns about this.
- Keys starting with `$` (e.g. `"$comment"`) are ignored, so you can annotate the JSON. Unknown
  fields are errors, which catches typos.

### Settings

`config/settings.json` applies to all calculators:

| Setting | Default | |
| --- | --- | --- |
| `skipWhenQuoteExists` | `true` | Leave a deal's line items alone once it has a quote |
| `setLineOrder` | `true` | Keep calculator lines in config order (`hs_position_on_quote`), applied whenever the deal syncs. Turn off to order lines by hand |
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
- `< <= > >=` with a blank are false, so `licence_seats > 0` is just false on deals without seats.
  But `!=` with a blank is **true**: `support_tier != "none"` is true when the tier is blank. Use
  `!isBlank(support_tier) && support_tier != "none"` to exclude blanks.
- Checkbox values work as true/false: `includeWhen: "needs_onboarding"`.

## Operating it

| Endpoint | |
| --- | --- |
| `GET /health` | Liveness check; lists the deployed calculators |
| `POST /webhooks/hubspot` | HubSpot webhooks (v3 signature required) |
| `POST /sync` | `{"dealId": "123"}` or `{"dealIds": [...]}` or a workflow webhook payload; `Authorization: Bearer <SYNC_API_KEY>`. `?wait=true` syncs up to 3 deals and returns the results (more are queued; failures are queued for retry); `&force=true` re-applies every line |

What runs on its own:
- **Every minute:** deals changed in the last 3 minutes are triaged from the search results
  alone. Only those that need a sync go on the queue, so unchanged deals cost nothing beyond the
  search.
- **Every 30 minutes:** the same check looks back 65 minutes, to catch anything a delayed or
  failed run missed. Every moment is covered by two catch-ups.
- **Every 15 minutes:** deals showing *Needs attention* are re-checked (the 2,000 most recently
  changed). Closed deals excluded by `syncWhen`, and inputs that are still wrong, are skipped
  without being queued, so only problems fixed outside the deal (e.g. a product added to the
  library) cost anything.
- **When a sync fails** for a temporary reason (HubSpot unavailable, rate limited), the queue
  retries it a minute later, up to 5 times.

Commands, run locally against your account:

```sh
npm run plan -- <dealId> [--force]              # what a sync would do
npm run sync -- <dealId>... [--force]           # sync specific deals now
npm run sync -- --calculator <id> [--dry-run]   # backfill a calculator's deals
npm run sync -- --all [--dry-run]               # every deal with calculator inputs or lines
```

## Running on a Node host instead

The same service runs as a long-lived Node.js process (`npm start`, or the `Dockerfile`, Node 24)
on Railway, Render, Fly.io, Cloud Run or a VM. It must run **continuously**: hosts that sleep or
scale to zero when idle (Render's free tier, Cloud Run with min instances 0, Fly with auto-stop)
stop the minute-by-minute check. Settings are environment variables (see `.env.example`):

| Variable | Default | |
| --- | --- | --- |
| `HUBSPOT_ACCESS_TOKEN` | required | App access token |
| `SYNC_POLL_SECONDS` | 60 | How often to check for changed deals. `0` turns checking off, leaving webhooks as the only trigger, so every calculator input must then be subscribed |
| `SYNC_POLL_LOOKBACK_MINUTES` | 60 | On startup, how far back to look |
| `HUBSPOT_CLIENT_SECRET`, `PUBLIC_URL` | for webhooks | Signature checking; `PUBLIC_URL` is the URL HubSpot calls |
| `SYNC_API_KEY` | optional | Enables `POST /sync` |
| `SYNC_DEBOUNCE_MS`, `SYNC_CONCURRENCY` | 5000, 2 | Quiet period; deals synced in parallel |
| `CONFIG_DIR` | `config` | Folder holding `settings.json` and `calculators/` |
| `HUBSPOT_API_VERSION` | from `src/hubspot.js` | As on Cloudflare |

A blank value means the default; an invalid one stops the service at startup with a clear error.

## Staying current

Everything that ages is in one place:

| What | Where | Supported until | To update |
| --- | --- | --- | --- |
| HubSpot API version | `DEFAULT_API_VERSION` in `src/hubspot.js` (unless overridden with `HUBSPOT_API_VERSION`) | `2026-09`: at least March 2028 | Set the newer version (new ones ship each March and September), run `npm test`, then `npm run plan` on a test deal, then deploy |
| HubSpot developer platform | `platformVersion` in `hubspot-project/hsproject.json` | `2026.09`: about March 2028 | Bump, then `hs project upload` |
| Cloudflare runtime | `compatibility_date` in `wrangler.jsonc` | Indefinitely: a deployed Worker keeps its behaviour | Optional |
| Node.js (Node host only) | `Dockerfile` | Node 24: April 2028 | Bump the image |

If HubSpot's new API paths misbehave on your account, setting `HUBSPOT_API_VERSION` to `legacy`
switches back to the older numbered APIs. That's a stop-gap: HubSpot stops supporting the v4
associations API it uses on 30 March 2027, and the v3 APIs in September 2027.

## Limitations and things to verify

- **Not yet run against a live HubSpot or Cloudflare account.** The test suite runs against a
  simulated HubSpot, and the Worker has been run in Cloudflare's local runtime (workerd) against a
  mock HubSpot API. The API calls follow HubSpot's `2026-09` documentation. Before going live, run
  `npm run plan` then `npm run sync` on a test deal and check the result in HubSpot.
- **Line item order:** the service sets `hs_position_on_quote` to keep calculator lines in config
  order. HubSpot documents this property only lightly. If HubSpot rejects it, set
  `"setLineOrder": false` and reorder on the quote instead.
- **Products swapped in the library:** if a SKU is moved to a different product, existing lines
  keep the old product until their values change. Run `npm run sync -- --all --force` to move them
  all now. A forced sync re-applies every line, so it also resets hand edits.
- **Multi-currency:** new line items get the deal's currency (`deal_currency_code`). If you don't
  set prices in the config, check that the product library price is right for that currency.
- **Bulk updates:** each Cloudflare check covers up to 2,000 changed deals
  (`SYNC_MAX_PAGES_PER_RUN`). Beyond that, for example a large import, the catch-ups every 30
  minutes cover more, and `npm run sync -- --all` catches anything left.
- If someone deletes a calculator line by hand, it stays deleted until that line's calculated
  values change (or a forced sync).

## Project layout

```
config/settings.json        settings for all calculators
config/calculators/         one file per calculator (add yours here)
examples/calculators/       worked examples to copy from
wrangler.jsonc              Cloudflare Worker: cron trigger, queue, settings
src/worker.js               Cloudflare handlers: webhooks, cron, queue consumer
src/server.js, poller.js    Node host equivalents
src/sync.js                 the sync: evaluate → compare → apply → status
src/triage.js               what a sync would do, from a deal's properties alone
src/sweep.js                finding changed deals with HubSpot's search
src/calculators.js          evaluates calculator rules for a deal
src/config.js               validates calculator config (config-loader.js reads the folder)
src/expression.js           the formula language (no eval)
src/reconcile.js            diffing, duplicate detection, orphan protection
src/hubspot.js              HubSpot API client (all endpoint paths)
src/webhooks.js             webhook signature check and event parsing
src/cli.js                  new-calculator / check / setup / plan / sync / webhooks
scripts/bundle-config.js    validates and bundles config/ into the Worker at deploy
hubspot-project/            the HubSpot project-based app
test/                       node --test suites
```
