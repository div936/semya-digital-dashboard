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

## This round's fixes ("No data" badge race condition, campaign ranking scope)

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

