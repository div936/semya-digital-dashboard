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
