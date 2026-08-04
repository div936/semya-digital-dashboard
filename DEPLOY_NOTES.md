# What's in this package

This is your full `semya-dashboard` project with all fixes from our
debugging session applied on top. Everything not listed below is
unchanged from your original upload.

## Files changed

| File | What changed | Why |
|---|---|---|
| `main/backend/db/migrations/2026-08_revenue_data_dedup_v2.sql` | **New file.** One-time migration. | Adds real de-dup protection to `revenue_data` (it had none) using the old dashboard's exact 3-tier algorithm. Cleans up existing duplicate rows already in the database. |
| `main/backend/db/platform_settings_schema.sql` | **New file.** One-time schema addition. | Adds the `platform_settings` singleton table — branding for the shared login page (`index.html`), separate from any one client's branding since the login page exists before a client is even selected. |
| `main/backend/db/supabase_schema.sql` | Added `standard_order_item_id`, `row_hash`, `dedup_method` columns to `revenue_data`; made all `CREATE POLICY`/`CREATE TRIGGER` statements idempotent. | So a fresh database setup gets the fix from day one, and the file is safe to re-run against an existing database without "already exists" errors. |
| `main/backend/lib/columnMapper.js` | Split "Order Item ID" into its own `standard_order_item_id` field instead of merging it into `standard_order_id`. | That merge was silently re-inflating order counts for any platform file that only has a line-item ID column, not a separate order ID column. |
| `main/backend/ingestion/fileIngestion.js` | Replaced the plain `INSERT` for `revenue_data` with an upsert using the old dashboard's 3-tier dedup key (`order_item_id` → `order_id+sku` → `date+sku+state+units+revenue`). | `revenue_data` previously had zero duplicate protection — re-uploading a file, or two files with overlapping dates, silently double-counted revenue. This is the single biggest reason totals didn't match the old dashboard. |
| `main/backend/routes/platformSettingsRouter.js` | **New file.** | `GET /platform-settings` (public — the login page loads it pre-auth) and `PATCH /platform-settings` (admin-only) for the shared login page's branding. |
| `main/backend/routes/clientRouter.js` | Added `PATCH /:client_slug/admin/appearance`. | Per-client logo/theme previously only lived in the editing admin's own browser localStorage — never actually saved server-side, so it reset on a different device or for a different admin, and clients never saw it. Now it's real and persisted. |
| `main/backend/app.js` | Mounted `platformSettingsRouter`. | So the two new routes above are reachable. |
| `main/frontend/dashboard.html` and `gh-pages/dashboard.html` (identical) | Added background keep-alive ping + tab-visibility-aware auto-refresh. Added an Admin/Client toggle to Client Administration → Appearance, so admins can edit either the shared login page's branding or the currently-selected client's branding, each persisted to the right place. | Reduces perceived slow loads and keeps data current. Closes the gap where there was no admin-level logo/theme control at all — only ever per-client, and only ever local to one browser. |
| `main/frontend/index.html` and `gh-pages/index.html` (identical) | Fetches `GET /platform-settings` on load and applies the logo, brand name, tagline, and theme colors dynamically. Fails soft to the current hardcoded "Semya Digital" look if the fetch fails. | The login page was 100% hardcoded before — no way to reflect the admin's branding choices at all, which is what prompted this whole feature. |
| `.github/workflows/keep-backend-awake.yml` | **New file.** | Pings the Render backend every 10 minutes so it doesn't spin down on the free tier. |

## Deploy order — follow this exactly

1. **Push this whole folder structure to your GitHub repo(s)** as-is —
   `main/` and `gh-pages/` map to whatever branches/repos you're
   already using for those; `.github/workflows/` only matters in
   whichever repo triggers your GitHub Actions.

2. **Run the SQL migrations FIRST, before redeploying the backend.**
   Run both:
   - `main/backend/db/migrations/2026-08_revenue_data_dedup_v2.sql`
   - `main/backend/db/platform_settings_schema.sql`

   against your production database in the Supabase SQL editor. Both
   are safe to run even if you already ran earlier (superseded)
   migrations from this conversation. **Do not run the full
   `supabase_schema.sql` file against your existing production
   database** — it's meant for a fresh install; use the migration
   files for an existing database.

3. **Deploy the backend** (`main/backend/`) — this picks up the
   updated `columnMapper.js` and `fileIngestion.js`. The code expects
   the migration's unique constraint (`uq_revenue_data_client_row_hash`)
   to already exist — it'll throw a clear error rather than silently
   reverting to old behavior if it's missing, so deploy order matters.

4. **Deploy the frontend** (`main/frontend/` and/or `gh-pages/`,
   whichever your GitHub Pages site actually serves from).

5. **Confirm the GitHub Action is running**: check the Actions tab of
   whichever repo `.github/workflows/keep-backend-awake.yml` lives in.

## New feature: Admin vs. Client branding

In Client Administration → Appearance, there's now a toggle at the top:
**"Client Dashboard"** (default) vs. **"Admin Login Page"**.

- **Client Dashboard** — edits whichever client is currently selected
  in Client Administration. Logo/theme now actually save to that
  client's row in the database (previously this only lived in the
  editing admin's own browser).
- **Admin Login Page** — edits the shared sign-in screen
  (`index.html`), which every user sees before logging in. This is
  the platform-wide setting from `platform_settings`, and only admins
  can see or change it — there's no equivalent toggle or access for
  client users anywhere in the app.

One practical note: logo uploads are stored as base64 data URLs in a
`TEXT` column (matching how this app already handled client logos —
there's no image storage/CDN wired up in this codebase). Fine for
small logo files; if you start uploading large images this will bloat
the database row and slow down the login page's initial fetch. Worth
moving to real object storage (e.g. a Supabase Storage bucket) later
if that becomes a problem — not urgent for a normal small logo file.

## About the app's URL

`main/frontend/index.html` has a hardcoded `DASHBOARD_URL` constant
that points at `https://div936.github.io/semya-digital-dashboard/dashboard.html`.
**If you change the app's URL (custom domain, repo rename, etc.), this
constant needs updating too** — it's what the login page redirects to
after a successful sign-in.

## Correction to the earlier timezone fix — please read before deploying

The previous round's timezone fix (IST-converting every raw file timestamp) was **wrong** and is now partially reverted. Cross-checked directly against your uploaded Amazon file: the IST-converted total for a day came out **₹14,235**, but the business's actual expected number — and Amazon's own daily reporting convention — is **₹15,625**. Converting Amazon's genuinely-UTC `purchase-date` into IST rolled some late-UTC-day orders into the previous calendar day, which is the opposite of what was wanted.

**What changed:** `dateUtils.js` now has two distinct functions instead of one:
- `todayIST()` / `toISTDateString()` — kept, still used for "what's today's real date right now" (Daily Targets' default date, date-picker defaults). This part of the original fix was correct — it's about the server's current moment, unrelated to file parsing.
- `extractLiteralDate()` — **new**, replaces the IST-conversion for reading dates OUT of uploaded files. Reads the calendar date exactly as written in the source column — Amazon's ISO `purchase-date`, Shopify/Meta's `Created at`, and the `campaign_date` fields — no timezone math at all. `columnMapper.js` and `fileIngestion.js` now use this instead.

**If you already deployed the previous (IST-conversion) version and uploaded files through it**, some rows may have been filed under the wrong date during that window — re-upload the affected files after this fix deploys to correct them (the upsert logic from the earlier revenue de-dup fix makes this safe).

## This round's fix — the real cause of numbers changing on a plain page refresh (severe, systemic)

**This explains a lot of the fluctuation seen across recent rounds.** You confirmed no upload, import, or cleanup happened between two screenshots that still showed different totals — that's only possible if the underlying query itself is non-deterministic, and it was.

### The bug
`fetchAllRows()` — the shared helper every major endpoint in `clientRouter.js` uses to page through a client's full dataset (Platform Sales, SKU Performance, Campaign Insights, Geographic Analysis, Fraud Patterns) — paginates using `.range(from, to)` (`LIMIT`/`OFFSET` under the hood). **None of its five call sites included an `.order()` clause.** Without an explicit, unique sort order, Postgres makes no guarantee that two separate executions of the *identical* query return rows in the same order — meaning two consecutive page loads, with zero data changes in between, can genuinely land different rows on each page boundary: some silently skipped, others counted twice. This is a well-known, textbook pitfall with offset-based pagination, and it was present in every single paginated query in this file.

### Fix
Added `.order('id')` (the UUID primary key — guaranteed unique per row) to all five call sites, plus a warning comment directly on the `fetchAllRows` helper so this can't quietly recur if a new caller gets added later without one.

### What this means for everything investigated in this conversation so far
Some of the number fluctuations chased over the last several rounds may have been partly caused by this, layered on top of the real bugs that were also found and fixed (the fingerprint-dedup issue, the Meta/Google mis-split, etc.) — those were all still real and correctly fixed, verified against actual data each time. This pagination bug is a separate, additional source of instability that could have made some of those investigations noisier than they needed to be. Worth re-verifying key numbers again now that this is fixed, since a "genuine" number should now be stable across repeated page loads with no other changes.

**Deploy just the backend for this one.** After deploying, refresh the same page twice in a row with nothing else changed — the numbers should now be identical both times, which is the direct test for whether this fix actually worked.



**Confirmed from the code:** the `platforms` array was never sorted at all — it was whatever order `Object.values()` happened to return, which really just means "whichever platform's first row appeared earliest in the raw database query results." That's why Flipkart (2.6%) could sit above Blinkit (3.2%) — a real revenue-descending sort would never do that.

**Fix, in `clientRouter.js`:** `aggregatePlatformSales()` now explicitly sorts platforms by `totalRevenue` descending before returning — every consumer of `/platform-sales` gets a consistent, sensible highest-to-lowest order for free, not just Platform Split specifically.

**Deploy just the backend for this one.**



**The bug, confirmed:** two different Google revenue figures appeared simultaneously on the same screen (Platform Split: ₹1,960, Platform Health: ₹3,786) because they were never the same data in the first place. `renderPlatformHealth()` (the sidebar widget) was only ever called from the **SKU Performance** tab's fetch function — never from Platform Sales. So while viewing Platform Sales, the sidebar was silently showing whatever date range/filters were active the last time someone visited SKU Performance, completely disconnected from the tab actually on screen.

**Fix:** Platform Sales now also refreshes the Platform Health sidebar itself, using its own current date range and filters — fetching campaign spend data (`/campaign-insights`) alongside its existing `/platform-sales` call, then calling the same `renderPlatformHealth()` function SKU Performance already uses. Whichever tab you're actually looking at now updates that sidebar to match.

**Deploy just the frontend.** Once live, Platform Health should always agree with whatever revenue numbers are shown on the tab currently in view — no more two different totals for the same platform on one screen.



**Changed:** `main/backend/ingestion/fileIngestion.js`. No SQL, no frontend.

### The bug — confirmed directly against your real uploaded file
Platform was decided purely by **filename** — `Meta_File.csv` → every single row tagged `meta`, `Google_File.csv` → every row tagged `google`. But a real Shopify export genuinely contains a **mix** of both: pulled `Meta_File.csv` directly and found rows tagged `source-google` sitting right alongside mostly `source-facebook` ones, in the exact same file. Every Google-attributed order in a file uploaded under the Meta naming convention was silently being counted as Meta instead — this is exactly why `google` had zero revenue rows in your database despite Google Ads clearly being a real, active channel (you have real Google campaign spend data).

### The fix
Added per-row platform detection using each row's own `Tags` column (already silently preserved in `raw_extras`, just never read) — ported directly from the old dashboard's own stated logic for this file type: `source-facebook`/`source-instagram` → Meta, `source-google` → Google, untagged → Meta (same default the old system uses). Verified against your actual file: **5 of 36 rows** in that one sample would now correctly split off as Google instead of being lumped into Meta.

### Important — this does NOT explain the row-count gap on its own
This fixes *mis-attribution* (which channel gets credit), not *missing rows* — the file's total row count doesn't change, just how it's split between Meta and Google. The much larger gap we found (7,240 rows in this system vs. the old dashboard's 23,297 for "Website") is a **separate, likely genuine coverage gap** — most Website order history apparently hasn't been uploaded to this system at all via any correctly-named revenue file.

**Recommended next step**, now that both fixes from this conversation are in place (duplication-safe import + correct Meta/Google splitting): run **Settings → Data Migration → Check All History** again. The "missing rows" it finds for Website-family orders will now be correctly pre-classified as Meta or Google (the same tag logic is already built into `mapOldRowToPlatform` in `reconciliationRouter.js`), and importing them is now safe from the duplication issue fixed last round.

### Deploy order
Backend only this time. **Re-upload your Meta/Google Website files after deploying** to get the corrected per-row split applied — this only affects newly-ingested data going forward, same limitation as every other ingestion-time fix in this conversation.



**This is NOT the bug originally reported** ("standard inserts instead of upserts" — that was checked and disproven: the import always used `upsert` with `onConflict` on `row_hash`). The real mechanism took several rounds of evidence-gathering to pin down, documented here for the full trail:

1. Checked for duplicate `row_hash` values → none found.
2. Checked for duplicate `(order_id, sku)` pairs → none found.
3. Checked for same SKU/date/price with different order IDs → found matches, but they were false positives (different real customers buying the same popular SKU at the same fixed price on the same day).
4. **Pulled the actual `standard_order_id` values side by side for a real SKU** — this is what found it: every normal-upload row for Amazon/Acutas had `standard_order_id = NULL`. Normal uploads for this platform de-duplicate on `order_item_id` or fall back to a composite key — they never populate the plain order ID column at all for this export shape. Every *imported* row, by contrast, has a real order ID, since that's the only identifier the old dashboard's API provides.

**The actual bug:** two rows representing the exact same real sale hash completely differently under `row_hash`, because one side has an order ID to hash and the other genuinely doesn't. Not a broken upsert — a join key (order ID) that was never comparable between these two specific data sources in the first place. This is why it concentrated almost entirely in Amazon+Acutas (11,196 rows vs the old dashboard's 6,154 — nearly double) while Blinkit came out exact (579 = 579, no overlap issue there at all).

### Fix — `reconciliationRouter.js`
The import endpoint now checks for an existing row by a **content fingerprint** (SKU + date + revenue + units) before importing anything — a match that doesn't depend on either side having a usable order ID. Fetched once per request for the whole batch, not per-row. A row matching an existing fingerprint is now skipped and reported separately (`skippedAsExisting`) instead of being inserted as a lookalike duplicate.

### Cleanup — `main/backend/db/cleanup_import_fingerprint_duplicates.sql`
Removes the duplicates already sitting in the database from before this fix, using the identical fingerprint logic. **Three steps, run in order**: a preview count (check the numbers look right — the inflated-revenue figure should land around the ₹32L gap we calculated from the two dashboards' totals), the actual delete, then a confirmation query that should return 0. Only ever deletes rows tagged as imported that match an existing non-imported row — never touches normal upload data, never removes an imported row that's genuinely unique.

### Deploy order
1. Run the SQL cleanup script (all three steps, in order — read the preview before deleting).
2. Deploy the backend.
3. Deploy the frontend.
4. Re-check both dashboards' totals — Amazon+Acutas row counts should now be much closer to the old dashboard's 6,154, and the overall total should drop by roughly the inflated amount the cleanup script reports.

### What's still open
Meta/Website came out the opposite direction — **fewer** rows in the new system (7,240) than the old dashboard's Website count (23,297). That's a real gap, not duplication, and a separate investigation — worth returning to once this cleanup is confirmed and the Amazon-side numbers are verified correct.



**The cause:** the old dashboard's `/data` endpoint returns its entire order history in one response with no pagination at all. For any real dataset, that can genuinely take longer than any single HTTP request should reasonably wait — including limits we don't fully control, like a hosting platform's own gateway timeout ceiling, which raising our own app-level timeout can't get around.

**The fix — background jobs, not a longer wait.** All three checks (missing-rows for a date, missing-rows for all history, logic-differences) now work as: `POST .../start` returns a job ID in milliseconds, the actual work happens afterward in the background, and the frontend polls `GET .../jobs/:jobId` every 2 seconds until it's done. This sidesteps every timeout that matters, since the slow part is no longer inside the lifetime of any single HTTP request at all.

**Also added:** a 5-minute in-memory cache of the old dashboard's full ledger — running "Check All History" and then "Check for Logic Differences" shortly after doesn't mean pulling that same large payload twice.

**What you'll see differently:** the button now shows a live elapsed-time counter ("Pulling the old dashboard's data… 14s") instead of appearing to hang — it's normal for this to take anywhere from several seconds to a couple of minutes depending on how much history exists and whether the old dashboard needs to cold-start.

**Deploy backend then frontend, no SQL.** This is a separate fix from the import-batching note directly below — that one was already for the *import* step timing out; this one is for the *check* step (finding what's missing in the first place) timing out.

## This round's fix — import timing out on large batches (9,000+ rows)

**Changed:** `main/backend/routes/reconciliationRouter.js`, `main/frontend/dashboard.html`.

**The problem:** importing was processing rows one database write at a time, sequentially, inside a single HTTP request — for something like 9,143 rows, that's thousands of round-trips in one request, which reliably times out (the browser, Render's own request limit, or both) long before finishing, no matter how patient anyone is.

**The fix, two parts:**
1. **Backend** now enforces a hard 300-row limit per request (a request over that gets a clear error, not a silent timeout), and processes each request's rows in **concurrent batches of 10** rather than one at a time — the same pattern `bulkInsert()` already uses in `fileIngestion.js` for normal file uploads.
2. **Frontend** now automatically splits a large "Import Selected" click into multiple sequential requests of 300 rows each, showing real progress ("Importing batch 3 of 31…") instead of one giant request with no feedback until it either finishes or times out.

**If a batch fails partway through**, it stops there and tells you exactly how many orders imported successfully before the failure — safe to just click Import again, since already-imported rows are automatically skipped (same de-dup guarantee as before), so nothing gets duplicated by resuming.

**Deploy backend and frontend together** — the 300-row chunk size is hardcoded to match on both sides.



**New:** `main/backend/routes/reconciliationRouter.js` (full rebuild — 4 endpoints now: two missing-orders variants, logic-differences, and import). **Changed:** `main/backend/ingestion/fileIngestion.js` (exported `computeRevenueDedupKey` for reuse), `main/frontend/dashboard.html` (moved out of Daily Targets entirely, now lives only in Settings → Data Migration).

### Where it lives now
**Settings → Data Migration**, admin-only. Nothing about this shows up on any regular tab anymore — the button and card that were previously on Daily Targets are gone; this is the only place it's reachable.

### What it does — three capabilities, as discussed
1. **Missing Orders** — "Check All History" diffs the old dashboard's entire order ledger against this system in one pass (grouped by date, with the full row list below); "Check This Date" scopes it to one day. Either way, results show up as a real row-level list (SKU, Order ID, platform, status, revenue), not just a totals gap.
2. **Logic Differences** — a genuinely different check: dates where the *same* orders exist in both systems but the computed revenue disagrees. That's a calculation bug, not missing data — the same category as the Google Ads rollup-row and Meta discount-allocation issues found earlier in this conversation. Differences under ₹5/day are treated as rounding noise.
3. **Import, with review** — every missing row has a checkbox (all selected by default, deselect what you don't want). Platform mapping uses the old dashboard's own tagging logic exactly as you described: `source_tag == "Amazon"` → Neat, `"Acutas"` → Acutas, Website rows tagged `Meta`/`Google` accordingly, defaulting to Meta when untagged (matching the old system's own stated default). Any row where that mapping couldn't be confirmed gets a ⚠ next to the platform name — worth a manual look before importing those specifically. Import reuses the **exact same `row_hash` de-dup mechanism** protecting every normal file upload — safe to re-run, already-imported rows are automatically skipped, never duplicated.

### Deploy order
Backend, then frontend. No SQL.

### Practical notes
- "Check All History" pulls the old dashboard's *entire* ledger in one request — expect it to take real time on a mature dataset, more if that service needs to cold-start. This is an on-demand migration tool, not something to run casually or repeatedly.
- The ⚠ platform-confidence flag exists specifically because a handful of old-dashboard rows might be untagged (no `source_tag` set) — those get a sensible default (Neat for Amazon-family, Meta for Website) but are flagged so you can manually correct the platform before importing if the default guess is wrong for that specific row.



**New:** `main/backend/routes/reconciliationRouter.js` now has `GET /clients/:slug/reconciliation/missing-rows`. **Changed:** `main/frontend/dashboard.html` — the button on Daily Targets is now **"Find Missing Orders vs. Old Dashboard"**.

### What changed from the previous version
The first version of this feature only compared totals (target/achieved/spend per platform) — useful for spotting *that* something's off, but not *which* orders are actually missing. This replaces that with an actual row-level diff.

### How it works
- Pulls the old dashboard's `/data` endpoint — it returns its **entire** order ledger with no date filter built in, so this filters down to the requested date on our side.
- Matches each old-dashboard row against this system's own `revenue_data` for the same date, using **(Order ID, SKU)** as the key — deliberately not platform, since the two systems use different platform groupings (this app splits Amazon into `amazon`/`acutas`; the old one groups Meta+Google as one "Website") and matching on platform would produce false "missing" results from label differences alone, not real gaps.
- Anything on the old side with no match here is returned individually — SKU, Order ID, platform, state, status, and revenue — plus a running total of how much revenue that missing set represents.
- Old-dashboard rows with no Order ID or SKU at all (some platforms don't always provide one) are reported separately as "can't be verified," not silently counted as either present or missing.

### Deploy order
Backend, then frontend. No SQL. This calls the old dashboard's live `/data` endpoint on every use, which returns its whole ledger — expect it to take a few seconds, more if that service is cold-starting (also on Render's free tier).

### Honest scope note
This tells you exactly *which* orders are missing so you can go investigate why (a file that was never uploaded, a row that failed silently during ingestion, etc.) — it does not import or add anything automatically. Every fix still happens the same way it has this whole conversation: find the specific cause, fix that.



**New:** `main/backend/routes/reconciliationRouter.js`. **Changed:** `main/backend/app.js`, `main/frontend/dashboard.html`.

### What it does
A new **"Compare with Old Dashboard"** button on Daily Targets (admin-only) that pulls the same date's numbers from both systems and shows them side by side — target, achieved, and spend, per platform group, with mismatches highlighted in red — instead of the manual screenshot-and-eyeball comparison that's driven most of the fixes in this conversation so far.

### How it works
- **This system's numbers**: computed the same way Daily Targets already does — same cancelled-order exclusion, same target carry-forward logic, same platform grouping (Amazon = Neat+Acutas, Website = Meta+Google).
- **Old dashboard's numbers**: pulled live, server-to-server, from `https://neat-everyday-performance-kd2j.onrender.com/api/targets/summary?report_date=YYYY-MM-DD`. This works because **the old dashboard's API has no authentication on any route** — confirmed directly from its source code (no auth dependency anywhere) and from the live site loading with no login wall. If that ever changes, this endpoint will need credentials added.
- Differences under ₹1 are treated as rounding noise, not flagged — real discrepancies only.
- If the old dashboard doesn't respond (it's also on Render's free tier and can cold-start, same as this app), this system's own numbers still display, with a clear note that the comparison itself failed rather than silently showing nothing.

### Deploy order
Backend, then frontend. No SQL. Try it on Daily Targets → Compare with Old Dashboard, for a date you already know has a discrepancy (like Aug 3 from this conversation) to confirm it surfaces correctly.

### Honest limitation
This compares **computed totals** (target/achieved/spend), not raw underlying rows — it'll tell you *that* Flipkart's achieved revenue differs by ₹X on a given date, but not *which specific order* caused it. For that level of detail, the per-file, per-row tracing we've been doing manually throughout this conversation is still the right tool. Worth building a deeper "diff the actual orders" version later if platform-level reconciliation stops being precise enough on its own.



**Confirmed with exact math against your uploaded Google Ads file:** real spend was ₹4,182.68 (matches the old dashboard exactly), but the new dashboard showed ~₹16.7K — because Google Ads campaign exports append several aggregate rows after the real per-campaign rows: `Total: Campaigns`, `Total: Account`, `Total: Search`, `Total: Performance Max`, etc. Each of those carries its own real `Cost` figure — a sum of some subset of the campaigns above it — but our ingestion was treating them as ordinary campaign rows and summing their spend right alongside the real campaigns, multiplying the reported total several times over. Verified precisely: summing every row (real campaigns + all the non-zero "Total:" rows) produces ₹16,730.72 — almost exactly what was shown.

**Fix, in `fileIngestion.js`:** rows are now filtered before any other processing touches them — any row whose first column value starts with "Total" (case-insensitive) is dropped as a rollup/summary row, not a real campaign. Ran the exact fixed logic against your uploaded file: **₹4,182.68**, an exact match to the old dashboard.

This is a general filter (not gated to Google specifically) since a real campaign name starting with the word "Total" is extremely unlikely and this exact row shape hasn't appeared in any other platform's export — but worth keeping an eye out if a future platform's real campaign naming ever collides with this.

**Important — re-uploading alone won't remove what's already there.** The bad "Total: ..." rows already in your database have their own distinct campaign names, so a corrected re-upload doesn't overwrite or replace them — it just adds the correct rows alongside the existing bad ones. Clean those up directly first:

```sql
-- See exactly what's there before deleting, per client
select campaign_name, campaign_date, standard_spend, platform
from campaign_data
where campaign_name ilike 'total%'
order by campaign_date desc;

-- Remove them
delete from campaign_data
where campaign_name ilike 'total%';
```

Run the `select` first to confirm these are genuinely all rollup rows (not a real campaign that happens to start with "Total") before running the `delete`.



Same root cause class as the earlier "Website ROAS" fix, found in a different widget: `renderPlatformHealth()` was computing ROAS from each campaign row's own self-reported "conversion value" (`standard_revenue` inside the ad-spend file itself), not the real attributed revenue from actual orders shown right next to it. Meta's ad-spend export apparently doesn't populate a meaningful conversion-value column (common when full server-side purchase tracking isn't wired into the ads platform) — so despite real spend and real revenue existing, the self-reported figure used for the ratio was near zero.

**Fix:** now uses `p.totalRevenue` (the real, actual attributed revenue already being displayed in ₹ next to each platform) divided by real spend — same principle as the Website ROAS fix: real revenue over real spend, never self-reported-over-self-reported. This changes the ROAS shown for every platform in this widget, not just Meta, since the same self-reported-revenue issue was silently present for all of them — worth a quick recheck of Amazon/Flipkart's numbers here too once this deploys, since they may shift slightly.



**Changed:** `main/backend/routes/inventoryRouter.js` (new bulk-upload endpoint), `main/frontend/dashboard.html`.

**Settings → Inventory Settings is now ONLY stock-quantity entry** — two ways:
1. **Manual, one SKU at a time** — SKU, warehouse, quantity, threshold, Save.
2. **Bulk Excel/CSV upload** — new endpoint, `POST /clients/:slug/inventory/stock/bulk-upload`. Expects columns for SKU, Warehouse, Quantity, and optionally a low-stock threshold (column names are matched loosely — "Qty", "Quantity", "Stock", "On Hand" all work for the quantity column, similar spirit to a few other common variants for the others). A row whose warehouse name doesn't exactly match an existing warehouse is skipped and reported back by name and row number, never guessed at or silently misfiled.

**Everything else moved to the UTM Analytics tab**, visible and manageable right there:
- **Warehouses & Platform Mapping** — create/delete warehouses, set the default, and map each platform to a specific warehouse, all inline on the tab.
- **Inventory & Low-Stock Alerts** — unchanged from last round.
- **All Stock** — the full stock table (every SKU/warehouse combination, not just low ones), now visible on the tab instead of only reachable through Settings.

**Deploy just the backend and frontend** — no new SQL this round, the schema from last round already supports this.



**New:** `main/backend/db/inventory_schema.sql`, `main/backend/routes/inventoryRouter.js`. **Changed:** `main/backend/app.js`, `main/backend/ingestion/fileIngestion.js`, `main/frontend/dashboard.html`.

### How it works
- **Settings → Inventory Settings** (new modal): create warehouses, mark one as default, map each platform to a specific warehouse (or leave it on "Default"), and set current on-hand quantity + low-stock threshold per SKU per warehouse.
- **Automatic deduction:** every time a revenue file is uploaded, each sold SKU automatically decreases stock at whichever warehouse its platform is mapped to (or the default warehouse if unmapped). This reuses the exact same `row_hash` already computed for revenue de-duplication as an idempotency key — **re-uploading a file can never deduct the same sale twice**, the same guarantee that already protects revenue totals from double-counting.
- **UTM Analytics tab**: new "Inventory & Low-Stock Alerts" card shows every SKU/warehouse combination at or below its threshold, with a rough "days remaining" estimate based on the last 14 days of sales velocity — explicitly labeled as an estimate, not a promise, since it can't see pending restocks or demand spikes.
- Every stock change (sale or manual edit) is logged in `inventory_movements` — a full audit trail of exactly why a number changed and when.

### Deploy order
1. Run `inventory_schema.sql` in Supabase (seeds a "Main Warehouse" per existing client automatically, so deduction has somewhere to go immediately).
2. Deploy backend.
3. Deploy frontend.
4. Go to Settings → Inventory Settings and set real starting quantities for your SKUs — the system has no way to know your actual current stock until you tell it once; from that point forward, uploads keep it accurate automatically.

### A few suggestions for a stronger inventory view, if useful going forward
- **Per-SKU reorder point instead of a flat threshold** — right now the low-stock trigger is a fixed quantity you set once; a more useful version ties it to *lead time* (e.g. "alert when stock will run out before a replacement order could arrive," using your actual supplier lead time per SKU rather than a guessed number).
- **A dedicated Inventory tab**, not just an alerts card tucked into UTM Analytics — worth doing once you're relying on this daily, with a full stock table (all SKUs, not just low ones), a movement history view, and CSV export for reconciling against a physical stock count.
- **Bulk stock import** — right now setting initial quantities is one SKU at a time in the modal; a CSV upload (SKU, warehouse, quantity) would make the initial setup and periodic physical-count reconciliation much faster.
- **Restock-in-transit tracking** — the days-remaining estimate currently assumes zero incoming stock; even a simple "expected restock date + quantity" field per SKU would make that estimate meaningfully more useful.



| What | Details |
|---|---|
| **"Failed to save" on logo upload** | Express's default JSON body limit is **100kb** — a base64-encoded logo image easily exceeds that (base64 inflates file size by ~33%, so even a modest 75–100KB image becomes 100KB+ as a data URL) and was being rejected by Express itself before ever reaching the route handler. Raised the limit to 5mb in `app.js`, comfortably covering any reasonable logo file. |
| **Recovery link still landing on the login page** | The previous fix (listening for Supabase's `PASSWORD_RECOVERY` event) depends on Supabase's own async URL-parsing finishing and firing that event before anything else reacts — usually reliable, evidently not reliably enough in practice. Replaced the primary mechanism with a synchronous check: `index.html` now reads the URL directly for a recovery indicator (`type=recovery`, in either the hash *or* the query string — Supabase can use either format depending on flow) as the very first thing it does, before even creating the Supabase client, and redirects immediately with no race condition possible. The event-listener approach is kept as a second-layer fallback. Also made `set-password.html` handle the PKCE `?code=...` link format explicitly (`exchangeCodeForSession`), since the hash-based `detectSessionInUrl` auto-parsing doesn't cover that format on its own, and it wasn't clear which format this project's links actually use. |

**Deploy order:** backend first (logo upload fix), then frontend (redirect fix). For the logo, just retry the save — no need to re-upload the file, it should go through now. For the redirect, request a fresh reset link and click it again; the old link's token has already been consumed by the earlier failed attempt(s), so a new one is needed either way.



Only applies when using Supabase's dashboard "send password reset" button directly (not our own invite flow, which was already correctly pointed at `set-password.html`). That button always redirects to your project's configured default **Site URL**, which is the login page — nothing in our own code controls where it goes, since it's not part of our request/response flow at all.

**Fix:** `index.html` now listens for Supabase's `PASSWORD_RECOVERY` auth event (fired specifically when a recovery link's session gets established) and immediately forwards to `set-password.html` when it fires — regardless of which flow actually sent the link. Also made `set-password.html` itself listen for both `SIGNED_IN` and `PASSWORD_RECOVERY` events (a recovery link can fire either depending on the exact flow), so it works correctly whether someone arrives via our invite flow or a direct Supabase Studio reset.

**Worth doing on the Supabase side too, for full control going forward:** under Authentication → URL Configuration, add `set-password.html`'s full URL to the **Redirect URLs** allowlist. Not strictly required for this fix (the `index.html` forwarding handles it either way), but it means a reset triggered via the Admin API with an explicit `redirectTo` would be allowed to land there directly too.



**New file:** `main/frontend/set-password.html` / `gh-pages/set-password.html`. Same black/white Semya branding as the login page.

**What changed:** the invite/magic-link flow now redirects through this page instead of straight to the dashboard. It uses the session the magic link itself establishes to call Supabase's `updateUser({ password })` — the person picks a password once, then can sign in directly with email + password on the regular login page every time after that, no link required. `main/backend/routes/authRouter.js`'s `redirectTo` was updated to point here instead of `dashboard.html` directly.

**Nothing else changes about the sign-in page itself** — `index.html`'s email/password form already works as-is once a password is set this way; this only adds the missing step to actually set one in the first place.

**Deploy order:** backend first (so new invites use the new redirect), then frontend (so the new page + updated invite-response handling from last round are both live). Existing users who already have a password (like `admin@semyadigital.com`, set up via `seed-users.mjs`) are unaffected — this only applies to the invite flow.



**The bug:** the Employee Invite flow's backend called `createUser()` + `generateLink()` — neither of which sends an email. `generateLink()` only *returns* a link; nothing dispatches it anywhere. That link was included in the API response, and the frontend's invite button **never read the response body at all** — it just discarded it. No email was ever going to arrive, no matter how long anyone waited; there was nothing sending one in the first place.

**Fix:** switched to `inviteUserByEmail()` for a brand-new email — the one Supabase Admin API call that actually sends a real email automatically, using the same "You've been invited" template and SMTP configuration already used elsewhere in this app (the admin-notification email for new access requests). Falls back to a copyable magic sign-in link — now actually shown to the admin in a prompt, not discarded — for emails that already have an account, since Supabase won't send a fresh invite email to an existing user.

**On setting a password:** this app uses **magic-link (passwordless) sign-in** for anyone invited this way — clicking the link in the email logs them straight in, no password step exists in this flow at all (`hashed_pw` is set to a fixed placeholder for every invited user, not a real password). There's no in-app way to set one for this flow, and none is needed. **Specifically for `admin@semyadigital.com`** — if `seed-users.mjs` was successfully run for that email a few rounds back (fixing the earlier login bug), it already has a real password-based Supabase Auth account completely separately from this invite flow, and can sign in directly on the login page right now without needing an invite at all.



The scrollable list from last round had no reserved space for its scrollbar, so it sat directly on top of the revenue figures on the right. Added `padding-right:16px` to the scroll container so the scrollbar now sits in its own gutter, clear of the amounts. The app already has a thin (6px) custom scrollbar style applied globally, so no further styling was needed — just the missing space.



**The bug:** `POST /auth/request-access` only handled two cases — already approved (stop), or no existing row (insert). A row that existed in any *other* state — most likely `rejected` from earlier testing, or a `pending` row that was never surfaced — matched neither branch. Nothing got inserted or updated, but the endpoint still returned success. The requester saw a genuine "success" message for a request that silently changed nothing in the database.

**Fix:** changed the insert to an upsert (using `access_requests.email`'s existing unique constraint), resetting the row to `pending` with a fresh timestamp regardless of what state it was previously in. A repeat request now always produces a real, visible pending row.

**For the specific email you tried:** run this to check its actual current state —
```sql
select email, status, requested_at, reviewed_at from access_requests where email = 'THE_EMAIL_HERE';
```
If it shows `rejected` (or anything other than `pending`), that confirms this exact bug for that email. After this deploys, have them click "Request access" again — it'll now correctly show up in Client Administration's Pending Access Requests.



Was truncated to top 5 / bottom 5, hiding everything in between (with 90+ campaigns on some days, that's most of the list). Now shows every campaign live on the selected date, ranked highest to lowest, in a scrollable list with a quick filter box (by campaign name or platform) since a full day's list across every platform can get long. Same single-day scoping and null-date exclusion from the last two rounds — this only changes how many rows are shown, not which ones.



Your hypothesis was exactly right, and better: **the fix for this already existed in the codebase** — it was just never wired into the endpoint feeding this specific card.

`backfillLocationByOrder()` in `columnMapper.js` groups rows by order and fills in a blank `standard_city`/`standard_state` from a sibling line item of the same order that has one — built specifically for the pattern you described: a multi-item order where only the first line item carries shipping details, and every other product in that same order is left blank (the same Shopify/marketplace export quirk behind the Meta discount-allocation fix a few rounds back). This was already correctly applied to the **Geographic Analysis** tab's endpoint — but the **SKU Performance** endpoint (`/sku-performance`, which is what feeds the "Top Cities by Revenue" card you're looking at) never called it, and didn't even fetch the `raw_extras` column the backfill needs to group rows by order in the first place.

Fixed: `/sku-performance` now fetches `raw_extras`, runs the same backfill, then strips `raw_extras` back out before responding (matching the privacy/size handling already done for Geographic Analysis — that field can carry buyer name/phone/address on platforms that expose those in unmapped columns).

**Deploy just the backend for this one.** Once it's live, re-check the Top Cities card — "Unknown" should drop to genuinely unresolvable rows only (an order where *no* line item anywhere had a city, not just one where a sibling row had it and this one didn't).



| What | Details |
|---|---|
| **ROAS hidden for Amazon/Flipkart/Blinkit** | Last round I removed per-platform ROAS everywhere except Website, matching the old dashboard's headline metric definition — but that went too far. Restored it for every platform in Platform Attainment and Ad Spend Breakdown. "Website ROAS" (the KPI card) stays as the one true headline paid-media efficiency number, matching the old dashboard exactly; the per-platform figures elsewhere are supplementary context, not competing with that definition. |
| **The "Admin" badge next to the client switcher was 100% static HTML** | `<span class="tag-admin">Admin</span>` — no logic, no role check, always rendered for every single person who ever loads this page, client or admin. This was actively misleading while debugging the logo issue: it looked like proof `isAdmin` was true when it checked nothing at all. Made it genuinely dynamic, driven by the real `cfg.user.isAdmin` from `applyBranding()`. |

### About the logo issue specifically
With the toggle confirmed off in your screenshot, and now that the "Admin" badge is real, this becomes self-diagnosing in one look: **after this deploys, reload the dashboard as the same account and check whether the "Admin" badge is still there.**
- **If the badge disappears** — this account genuinely isn't flagged `role = 'admin'` in the `users` table, which explains everything: the branding code was correctly showing client branding because, as far as the server is concerned, this isn't an admin session. Fixable directly in Supabase (update that user's `role` to `admin`), not a code issue.
- **If the badge stays** — `isAdmin` is genuinely true, and the real cause is either the `/platform-settings` fetch failing or the admin branding never having actually saved (plausible if it was attempted before the "always shows Saved" bug was fixed a few rounds back). Open the browser console (F12) — the `[branding]` log line added last round will show exactly what happened, and paste it here.



| What | Details |
|---|---|
| **Campaign ranking still showing stale Google data** | Found the exact cause: `/campaign-insights` deliberately includes any campaign row with `campaign_date IS NULL` in *every* date-range query (`campaign_date.is.null` in the OR clause) — reasonable for a general "browse everything" view, wrong for a single-day ranking. That's why the same 5 Google rows (one literally named `--`) appeared identically for every date selected — they're likely leftover from a broken historical import that never got a real date. Fixed in `loadDTCampaignRanking()` to require an exact `campaign_date` match, not just "has revenue." **Worth cleaning up the source data too** — run this to see the actual garbage rows: `select campaign_name, campaign_date, standard_revenue, created_at from campaign_data where client_id = 'b5bdce75-9b69-47ef-a1e7-bc3c09612ef6' and campaign_date is null order by standard_revenue desc;` — if these are confirmed junk, they're worth deleting since they were also silently polluting the general Campaign Insights tab, not just this ranking. |
| **7-Day Attainment Trend was blank** | Found it was never actually a 7-day trend — it plotted one bar per *platform* for the single selected day (mislabeled), and had no data to show whenever that one day's data was sparse. Replaced with `loadDT7DayTrend()`: fetches the real last 7 calendar days (7 parallel calls to the existing `/targets` endpoint, no new backend route needed) and plots genuine day-by-day attainment %, summed across every platform. |
| **Semya logo not showing by default** | Couldn't fully confirm the exact cause without live access — it's either (a) the "View as Client" toggle being on, or (b) the admin branding never having successfully saved before the "always shows Saved" bug was fixed a few rounds back — both look identical from a screenshot. Made it self-diagnosing instead of guessing further: added a visible **"Previewing as client"** badge next to the logo whenever that toggle is active (so it's now obvious at a glance whether that's the cause), and added console logging in `applyBranding()` — open the browser console (F12) and you'll see exactly whether `isAdmin` was true, whether the toggle was on, and what `/platform-settings` actually returned. **Two things to check directly:** confirm the "View as Client" toggle in the Settings menu is off, and re-open Client Administration → Appearance → Admin Login Page and click Save again now that the save-status bug is fixed — if it was silently failing before, this deploy should make a real difference immediately. |



**The bug:** setting a target for one date (e.g. 01-07-2026) had no effect on any later date — 02-07-2026 showed `Target: ₹0` and "No data" as if nothing had ever been set. Confirmed by reading the old dashboard's actual schema: its `platform_targets` table has `platform VARCHAR(50) UNIQUE` — **no date column at all.** A target is a single ongoing setting per platform in the old system; there's no such thing as a "date-specific" target there. This system's schema is date-scoped (`daily_targets` has a `target_date` column) but the lookup only ever matched the exact date, with no fallback — so a target only ever applied to the literal day it was saved under.

**The fix, in `targetsRouter.js`:** kept the date-scoped schema (a real improvement over the old system — it preserves a history of when targets changed, which a single-row-per-platform design can't do at all), but changed the lookup from an exact-date match to "the most recent target row on or before the requested date." Practically: set a target once, it holds for every day after that until you set a new one — matching what the old system does and what you expect — while past dates before a target was ever set still correctly show ₹0 (arguably more correct than the old system, which has no concept of "before this was set" at all).

**No frontend changes needed** — the Daily Revenue Targets modal already reads from this same endpoint, so it automatically shows the carried-forward value when you open it for any date, and saving a new target from the modal correctly becomes the new "effective from" point going forward.



Read `/api/targets/summary`, `/api/marketing/summary`, and the ad-spend endpoints in the old dashboard's actual backend (`mangalam-updated/backend/main.py`, sent earlier in this conversation) instead of reverse-engineering behavior from screenshots. Found two more real, provable bugs.

| What | Old dashboard's actual logic | What this system was doing | Fix |
|---|---|---|---|
| **Cancelled orders in "Achieved"** | `/api/targets/summary` explicitly excludes them — the old code has a comment marking it as a deliberate fix: `"BUG FIX: Exclude Cancelled orders (status = 'Cancelled')"` | No exclusion at all — every cancelled order still counted toward Today's Revenue and everything derived from it | `targetsRouter.js` now excludes `cancelled`/`canceled` orders from achieved revenue, matching exactly |
| **"Total ROAS"** | Always `Website revenue ÷ Website ad spend (Meta + Google only)` — explicitly never blended with Amazon/Flipkart/Blinkit on either side | `totalAchieved ÷ totalSpendActual` — summed revenue from every platform divided by summed spend from every platform, which is misleading since Amazon's mostly-organic marketplace revenue was being credited against total spend that's mostly Amazon's own | Renamed the card to **"Website ROAS"** and fixed the formula to Website-only, matching the old system exactly. Removed the now-inconsistent per-platform ROAS display for Amazon everywhere it appeared (Platform Attainment, Ad Spend Breakdown) — the old dashboard never shows a ROAS figure for marketplace platforms, only for Website. |

**Why ROAS being platform-scoped actually matters, not just cosmetically:** ROAS is fundamentally a paid-traffic efficiency question — "did this ad spend produce this revenue." Amazon/Flipkart/Blinkit sales happen mostly organically on those marketplaces; crediting them against ad spend (mostly Amazon's own sponsored listings) produces a number that looks like marketing efficiency but isn't measuring what it claims to. The old dashboard's own design already recognized this and scoped ROAS accordingly — this brings the new system in line with that reasoning, not just the number.

**Also confirmed while reading this code:** the Ad Spend Breakdown hierarchy from last round (Amazon → Neat + Acutas, Flipkart, Blinkit, Website → Meta + Google) matches the old dashboard's own `amazon_spend_detail` / `website_breakdown` structure closely — good confirmation that feature was built in the right shape from the start.



Thanks to the Aug 2 files you sent alongside the old dashboard's own numbers for the same day, I could directly cross-validate this properly for the first time — and found a better formula than last round's.

**What changed in `allocateOrderLevelDiscount()` (`fileIngestion.js`):** the discount ratio is now computed as `Total / (sum of that order's own Lineitem price values)` — **not** `Total / Subtotal` (the file's own Subtotal column), which is what the previous version used.

**Why:** cross-checking directly against two real uploaded files, a meaningful fraction of orders — 14 of 36 on one day, 15 of 27 on another — have a `Subtotal` that doesn't actually equal the sum of that order's own line items. That's an inconsistency in the export file itself. Trusting it as the discount baseline threw the allocation off. Deriving the ratio from the line items actually being scaled is self-consistent by construction — it always reconstructs the order's real `Total` exactly when summed back up, regardless of whether `Subtotal` agrees with anything.

**Validated end-to-end**, running the actual deployed function against your real Aug 2 Meta file: **₹37,908.03**, against the old dashboard's **₹37,799** for the same day — within 0.3%, the closest of every formula tried (including the previous Subtotal-based one, and a plain "sum of order Totals," both tested against the same file).

Also confirmed independently: your new Amazon (₹12,786) and Acutas (₹4,930) numbers sum to **₹17,716** — an exact match to the old dashboard's combined Amazon figure for Aug 2. The date-extraction fix from a few rounds back is holding up correctly.



| What | Details |
|---|---|
| **Platform Attainment now groups Meta + Google as "Website"** | Was showing them as two separate rows; now merged into one, matching how the rest of the app treats them as a single attribution channel. Amazon and Acutas stay separate (nothing asked for those to merge). |
| **New Ad Spend Breakdown card** | Hierarchical: Amazon (total) → Neat Amazon + Acutas nested underneath; Flipkart and Blinkit standalone; Website (total) → Meta + Google nested underneath. Reuses the same `targets` data already being fetched for the KPI cards — no extra request. |
| **Meta/Shopify revenue — proportional discount allocation** | Implemented in `fileIngestion.js` (`allocateOrderLevelDiscount`): each order's real post-discount `Total` is now allocated across its line items proportionally by each item's share of the pre-discount `Subtotal`, instead of using the pre-discount `Lineitem price` directly. This is a real improvement and preserves per-SKU revenue attribution (which a naive switch to `Total` would have broken — Shopify only populates `Total` on one row per multi-item order). **Important honest caveat below.** |

### Why the Meta total still won't match your number exactly
Tracing this all the way through, I found the uploaded Meta file has internal inconsistencies — several orders where `Subtotal` doesn't actually equal the sum of that order's own `Lineitem price` values, even accounting for every row belonging to that order (e.g. order `NEAT-16153`: a single-line-item order priced at ₹608, but `Subtotal` says ₹1,155.20 — for one line item, those should be equal by definition). Fifteen of twenty-seven orders on Aug 1 have this mismatch. That's a data-quality issue in the source file, not something fixable in code — no formula can reconcile numbers that don't agree with each other in the first place. Worth checking with whoever generates this export whether that's expected/known. The new proportional-allocation logic is still the right general-purpose fix and will produce noticeably better numbers than before on files that don't have this inconsistency.

### Campaign Performance ranking — diagnosis, not yet fixed
The single-day scoping fix from last round IS working (the "Lowest Gross Sales" list correctly changed to show Amazon's ₹0 campaigns for this date). But "Highest Gross Sales" still shows the same large historical Google figures (₹5.38L etc.) unchanged — which means those specific Google campaign rows in the database are themselves tagged with `campaign_date = 2026-08-01` despite representing a much larger figure than a single day's spend would produce. This smells like the same class of bug we already found and fixed for Amazon's `7 Day Total Sales` column (a rolling-window figure mapped as if it were a single day's number) — possibly present in whatever Google Ads export originally populated this data. I don't have that source file to confirm directly. Run this to check:

```sql
select campaign_name, campaign_date, standard_revenue, standard_spend, created_at
from campaign_data
where client_id = 'b5bdce75-9b69-47ef-a1e7-bc3c09612ef6'
  and platform = 'google'
  and campaign_date = '2026-08-01'
order by standard_revenue desc
limit 10;
```
If `created_at` shows these rows were uploaded well before this recent session (i.e. old data from an earlier, unrelated upload), that's the likely explanation — worth checking against whatever Google Ads export file was originally used, and confirming whether its own "sales" column is a rolling window like Amazon's.



| What | Details |
|---|---|
| **"No data — upload a file" showing despite real numbers on screen** | Couldn't reproduce directly, but found a real, plausible cause: `fetchAndRenderDT()` can now legitimately be triggered from multiple places at once — a tab switch, the 5-minute auto-refresh, and the date picker's change handler. Without protection, an older/slower request finishing *after* a newer one would overwrite the newer request's correct results — including flipping the badge back to "No data" even though the numbers on screen were real. Added a request-token guard: every call gets a token, and only the most recent one's results are ever applied to the page. Older, now-stale results are silently dropped instead of overwriting newer ones. |
| **Campaign Performance ranking pulling in unrelated old data** | Was scoped to a rolling 30-day window, which is why a ₹5.38 Lakh historical Google campaign from weeks ago sat at the top of a page otherwise showing single-day numbers in the tens of thousands, while Amazon's own campaign file (uploaded same day) never appeared at all. Changed to match the single date selected on the tab — "what did the file uploaded for this date contain," not a month-long rollup. The card badge now shows the actual selected date instead of "Last 30 days". |

## This round's fixes (Acutas missing from Daily Targets, stuck loading, Total ROAS, campaign ranking)

**Acutas (and Google) were completely missing from Daily Targets** — `PLATFORMS_DT` (used for the platform-attainment list and every KPI total on that tab) was hardcoded to `['amazon', 'flipkart', 'blinkit', 'meta']`, silently excluding Acutas revenue from the platform list, the revenue/units/attainment totals, ad spend, and Total ROAS. Fixed to `['amazon', 'acutas', 'flipkart', 'blinkit', 'meta', 'google']` in all three places it's defined in `dashboard.html`. This was likely the main driver behind Total ROAS looking off too — it's calculated from the same undercounted totals.

## Known issue found, not yet fixed: Meta/Shopify revenue may be slightly overstated
While validating these numbers, `Lineitem price` (used as `standard_revenue` for Meta/Shopify rows) doesn't account for order-level discounts reflected in the `Total` column — e.g. one row: Lineitem price ₹653, Total (after discount) ₹603. Using `Total` directly would fix this but breaks per-line-item revenue attribution for multi-product orders (Shopify only populates `Total` on one line item row per order, leaving the rest at ₹0) — needs a proper proportional-allocation fix, not a quick field swap. Flagging for a follow-up rather than rushing it.



| What | Details |
|---|---|
| **Stuck "Loading…" on Daily Targets** | Couldn't fully reproduce the root cause (all referenced DOM elements exist, and `apiFetch` already has a 35s timeout) — most likely explanation is a Render free-tier cold start caught mid-load in your screenshot, which the keep-alive workflow from earlier reduces but can't fully eliminate (a long-idle period or fresh deploy can still cold-start once). Regardless of cause, added a real safety net: `fetchAndRenderDT()`'s rendering step is now wrapped in try/catch, so **any** unexpected error clears the loading badge to an empty state instead of leaving it stuck indefinitely — this class of bug (an uncaught exception mid-render skipping the badge-clearing call at the end of the function) can't recur even if the specific trigger differs next time. |
| **Total ROAS card** | Added as a 5th KPI card on Daily Targets, same visual treatment as Today's Ad Spend. Reuses the `overallRoas` value already being computed (revenue achieved ÷ spend, for the selected day) — it existed as a small sub-line under Ad Spend before, now it's its own dedicated card as requested. |
| **Campaign Performance ranking** | New card below Platform Attainment: highest-to-lowest gross-sales campaigns, each with its date, over a rolling 30-day window ending on the date selected. Reuses the existing `/campaign-insights` endpoint (already returns raw `campaign_data` rows with `standard_revenue` = the platform's own attributed sales figure, e.g. Amazon's "7 Day Total Sales") rather than adding a new backend route — the ranking itself is a simple client-side sort. Shows top 5 and bottom 5. |



| File | What changed | Why |
|---|---|---|
| `main/backend/lib/dateUtils.js` | **New file.** `toISTDateString()` / `todayIST()` — resolves calendar dates explicitly in Asia/Kolkata, never the server process's own timezone or UTC. | Root cause fix — see below. |
| `main/backend/lib/columnMapper.js` | Date coercion (`order_date`/`campaign_date`) now uses `toISTDateString()` instead of `new Date(x).toISOString().split('T')[0]`. | This is the actual ingestion bug: `.toISOString()` always converts to UTC. An order at 00:15 IST on Aug 2 is 18:45 UTC on Aug 1 — the old code filed it as an Aug 1 order. |
| `main/backend/ingestion/fileIngestion.js` | Preamble-date fallback parser (used for exports like Google Ads with a date range in a header line) now uses the same IST helper. | Same class of bug, different code path. |
| `main/backend/routes/targetsRouter.js` | Daily Targets' default `date` (when no `?date=` is passed) now uses `todayIST()` instead of `new Date().toISOString()...`. | **This is the exact bug behind your screenshot.** For the first ~5.5 hours of every IST day, the UTC clock hasn't rolled over yet, so "today" silently defaulted to yesterday. |
| `main/backend/lib/insightGenerator.js`, `main/backend/lib/projections.js` | 30-day lookback windows and weekly-bucket keys now use the IST helper too. | Same underlying bug, lower-stakes (a few hours of boundary drift on a 30-day window / week bucket) but fixed for consistency. |
| `main/frontend/dashboard.html` / `gh-pages/dashboard.html` | Added a matching `toISTDateString()`/`todayIST()` helper and replaced all 5 places a date-picker defaulted via the same broken UTC-truncation pattern. | So the frontend's idea of "today" always agrees with the backend's. |

### Important — this does NOT retroactively fix historical data
Once a row is stored, only the truncated date survives — the original full timestamp is never kept anywhere (not even in `raw_extras`), so there's no way to detect or auto-correct which existing rows were shifted by this bug. This fix stops it from happening to any newly-ingested data. For historical rows:

- **Re-uploading original source files after this deploy will self-correct most rows automatically** — anything with a real order ID or order-item ID (most Amazon/Acutas data) upserts safely via `row_hash`, which doesn't include the date for those tiers, so a corrected date just updates the existing row.
- **Rows keyed only by the composite fallback hash** (no order ID at all — see `computeRevenueDedupKey` in `fileIngestion.js`) DO include the date in their hash, so a corrected date produces a different hash and could insert as a new row alongside the old, wrong-dated one on re-upload. Worth a manual spot-check after re-uploading if this matters for a specific report.



| File | What changed | Why |
|---|---|---|
| `main/backend/db/seed-users.mjs` | Now actually creates a **Supabase Auth** account via the admin API, not just an app-level `users` table row. | Root cause of "Incorrect email or password" for `admin@semyadigital.com`: the old script only wrote to your own `users` table with a `hashed_pw` column that **login never reads** — sign-in goes through Supabase Auth directly, completely separately. A `users` row with no matching Supabase Auth account can never sign in, no matter the password. |
| `main/frontend/dashboard.html` / `gh-pages/dashboard.html` | Fixed `saveAppearance()` always showing "✓ Saved" even when the server request failed. Reworked branding logic: admins now see Semya's own branding by default everywhere (header logo/name/theme), regardless of which client's data they're viewing — previously the client switcher silently re-branded the header to match whichever client's data was selected, which is why a saved admin logo appeared to do nothing. Added a **"View as Client"** toggle in the Settings menu so admins can deliberately preview a specific client's white-labeled look. Removed the old `restoreAppearance()` that replayed stale localStorage branding on every load, which fought with the new server-driven logic. Added a **Noir** (true black) theme preset. | You reported the admin logo not appearing anywhere after saving — this was two compounding bugs: (1) the save button lied about success, and (2) even on a real save, the dashboard's own branding logic overwrote it back to whichever client was selected. |
| `main/frontend/index.html` / `gh-pages/index.html` | Brand panel redesigned to pure black, using your actual **SEM'YA logo file** (now included at `assets/semya-logo.jpg`) instead of a generic blue "SD" square. Blue accent colors replaced with neutral greys. | To match the real brand identity you shared, not the placeholder blue theme the scaffold shipped with. |
| `main/backend/db/platform_settings_schema.sql`, `platformSettingsRouter.js` | Default theme changed from blue to the same black/near-black (`#111111` / `#000000`) used on the login page. | Consistency — a fresh install's admin theme now matches the actual brand instead of defaulting to blue. |

### About the login fix specifically
The updated `seed-users.mjs` is safe to re-run — it now creates the Supabase Auth account if missing, or updates its password if the account already exists (so re-running with a new password actually changes it). **Fastest fix for right now, before you even redeploy:** open Supabase → Authentication → Users and check whether `admin@semyadigital.com` is listed. If not, that confirms this exactly, and you can create it there directly with whatever password you want — sign-in will work immediately, no redeploy needed.

### About "View as Client"
Settings → (new toggle, admin-only) **"View as Client"**. Off by default — you always see Semya's branding. Turning it on previews whichever client is currently selected in the client switcher, using that client's own logo/theme/name from their `clients` row. Turn it back off to return to Semya's default look. This is per-browser (stored in localStorage), not synced across devices — it's a personal preview toggle, not a setting that should affect what other admins see.

**Fixes:**
- Revenue/units no longer double-count on re-upload or overlapping
  date-range files — the root cause of most of the gap we found.
- Order counts stop being inflated for files that only have an Order
  Item ID column.
- Going forward, uploading the same files should converge toward the
  old dashboard's numbers, since both systems now use the same
  de-duplication logic.

**Doesn't fix (separate, already-tracked issues):**
- **Blinkit** has no data in the new system at all (only one file,
  dated 2026-06-01, was ever meant to be uploaded, and hasn't been).
  Needs a manual upload — not a code bug.
- **Platform labels don't map 1:1** between dashboards (old groups by
  fulfillment channel; new groups by source file — "acutas" is really
  Amazon, "meta"/"google" are really Website). Any platform-by-platform
  comparison needs that regrouping done manually until unified.
- The old dashboard's `/admin/dedup-report` diagnostic endpoint
  (duplicate detection, per-date/platform inflation view) hasn't been
  ported over yet — still worth doing as a follow-up.

