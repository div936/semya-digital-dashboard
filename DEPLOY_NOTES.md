# What's in this package

This is your full `semya-dashboard` project with all fixes from our
debugging session applied on top. Everything not listed below is
unchanged from your original upload.

## Files changed

| File | What changed | Why |
|---|---|---|
| `main/backend/db/migrations/2026-08_revenue_data_dedup_v2.sql` | **New file.** One-time migration. | Adds real de-dup protection to `revenue_data` (it had none) using the old dashboard's exact 3-tier algorithm. Cleans up existing duplicate rows already in the database. |
| `main/backend/db/supabase_schema.sql` | Added `standard_order_item_id`, `row_hash`, `dedup_method` columns to `revenue_data`; made all `CREATE POLICY`/`CREATE TRIGGER` statements idempotent. | So a fresh database setup gets the fix from day one, and the file is safe to re-run against an existing database without "already exists" errors. |
| `main/backend/lib/columnMapper.js` | Split "Order Item ID" into its own `standard_order_item_id` field instead of merging it into `standard_order_id`. | That merge was silently re-inflating order counts for any platform file that only has a line-item ID column, not a separate order ID column. |
| `main/backend/ingestion/fileIngestion.js` | Replaced the plain `INSERT` for `revenue_data` with an upsert using the old dashboard's 3-tier dedup key (`order_item_id` → `order_id+sku` → `date+sku+state+units+revenue`). | `revenue_data` previously had zero duplicate protection — re-uploading a file, or two files with overlapping dates, silently double-counted revenue. This is the single biggest reason totals didn't match the old dashboard. |
| `main/frontend/dashboard.html` and `gh-pages/dashboard.html` (identical) | Added a background keep-alive ping (every 8 min) and an auto-refresh of visible data (every 5 min, tab-visibility aware). | Reduces perceived slow loads and keeps data current without manual refreshing. |
| `.github/workflows/keep-backend-awake.yml` | **New file.** | Pings the Render backend every 10 minutes so it doesn't spin down on the free tier. |

## Deploy order — follow this exactly

1. **Push this whole folder structure to your GitHub repo(s)** as-is —
   `main/` and `gh-pages/` map to whatever branches/repos you're
   already using for those; `.github/workflows/` only matters in
   whichever repo triggers your GitHub Actions.

2. **Run the SQL migration FIRST, before redeploying the backend.**
   Open `main/backend/db/migrations/2026-08_revenue_data_dedup_v2.sql`
   in the Supabase SQL editor and run it against your production
   database. This is safe to run even if you already ran the earlier
   (superseded) `2026-08_revenue_data_dedup.sql` migration from
   earlier in this conversation — step 0 of this file cleans that up
   automatically. **Do not run the full `supabase_schema.sql` file
   against your existing production database** — it's meant for a
   fresh install; use the migration file for an existing database.

3. **Deploy the backend** (`main/backend/`) — this picks up the
   updated `columnMapper.js` and `fileIngestion.js`. The code expects
   the migration's unique constraint (`uq_revenue_data_client_row_hash`)
   to already exist — it'll throw a clear error rather than silently
   reverting to old behavior if it's missing, so deploy order matters.

4. **Deploy the frontend** (`main/frontend/` and/or `gh-pages/`,
   whichever your GitHub Pages site actually serves from).

5. **Confirm the GitHub Action is running**: check the Actions tab of
   whichever repo `.github/workflows/keep-backend-awake.yml` lives in.

## What this does and doesn't fix

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
