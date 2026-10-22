-- ═══════════════════════════════════════════════════════════════════
-- MIGRATION: de-duplicate revenue_data using the old dashboard's
-- exact 3-tier dedup algorithm (ported from mangalam-updated/backend/
-- main.py), replacing the flatter fingerprint approach from the first
-- attempt at this fix.
--
-- SUPERSEDES the earlier "2026-08_revenue_data_dedup.sql" migration
-- (the one keyed on row_fingerprint). If you already ran that one,
-- this migration cleans it up and replaces it — see step 0 below. If
-- you haven't run anything yet, just run this one; you don't need the
-- old one at all.
--
-- Tier logic (most to least reliable), matching computeRevenueDedupKey()
-- in fileIngestion.js exactly:
--   1. order_item_id  — unique per LINE ITEM. ("0" treated as absent —
--      some Amazon exports use it as a placeholder on zero-revenue
--      adjustment rows.)
--   2. order_id + sku — unique per order+product, when there's an
--      order-level ID but no line-item-level one.
--   3. composite(order_date, sku, state, units, revenue) — last
--      resort. Can rarely false-positive-collide (two different
--      orders sharing all five values) — same known caveat the old
--      system carries.
--
-- Safe to run more than once. Run BEFORE deploying the updated
-- fileIngestion.js / columnMapper.js, so the constraint exists before
-- the app starts upserting against it.
-- ═══════════════════════════════════════════════════════════════════

-- 0. Clean up the previous attempt at this fix, if it was applied.
DROP INDEX IF EXISTS uq_revenue_data_client_fingerprint;
ALTER TABLE revenue_data DROP COLUMN IF EXISTS row_fingerprint;

-- 1. Add the columns this algorithm needs.
--    - standard_order_item_id: the line-item-level ID, now a distinct
--      field from standard_order_id (see the columnMapper.js comment
--      on why these must not be merged — that merge was itself a bug).
--    - row_hash: the dedup key produced by whichever tier matched.
--    - dedup_method: which tier was used, for the same visibility the
--      old system's /admin/dedup-report endpoint provides.
ALTER TABLE revenue_data
  ADD COLUMN IF NOT EXISTS standard_order_item_id TEXT,
  ADD COLUMN IF NOT EXISTS row_hash      TEXT,
  ADD COLUMN IF NOT EXISTS dedup_method  TEXT NOT NULL DEFAULT 'composite';

-- 2. Backfill row_hash for every existing row using the same 3-tier
--    logic, in SQL, since standard_order_item_id doesn't exist yet on
--    historical rows (they predate this migration) — so in practice
--    every pre-existing row falls to tier 2 or tier 3 here. That's
--    expected and fine: it's only newly-ingested rows (after the
--    matching fileIngestion.js deploy) that will actually populate
--    standard_order_item_id and get tier-1 treatment.
UPDATE revenue_data
SET
  row_hash = CASE
    WHEN standard_order_id IS NOT NULL AND standard_order_id != '' THEN
      encode(digest('order_id_sku:' || standard_order_id || '|' || COALESCE(standard_sku, ''), 'sha256'), 'hex')
    ELSE
      encode(digest(
        'composite:' || COALESCE(order_date::text, '') || '|' || COALESCE(standard_sku, '') || '|' ||
        COALESCE(standard_state, '') || '|' || COALESCE(standard_units::text, '') || '|' ||
        COALESCE(to_char(standard_revenue, 'FM999999999990.00'), ''),
        'sha256'
      ), 'hex')
  END,
  dedup_method = CASE
    WHEN standard_order_id IS NOT NULL AND standard_order_id != '' THEN 'order_id_sku'
    ELSE 'composite'
  END
WHERE row_hash IS NULL;

-- Requires pgcrypto for digest() — already enabled by supabase_schema.sql
-- (CREATE EXTENSION IF NOT EXISTS "pgcrypto"), but guard here too in
-- case this migration is ever run against a database that skipped it.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 3. Informational: see the scale of duplication before it's removed.
--    (Mirrors the old dashboard's /admin/dedup-report endpoint —
--    worth adding an equivalent route to this backend later so this
--    kind of check doesn't require going into the SQL editor by hand.)
--
--    SELECT client_id, row_hash, dedup_method, COUNT(*) AS dup_count,
--           SUM(standard_revenue) AS inflated_revenue_from_dupes
--    FROM revenue_data
--    GROUP BY client_id, row_hash, dedup_method
--    HAVING COUNT(*) > 1
--    ORDER BY inflated_revenue_from_dupes DESC;

-- 4. Remove duplicate rows, keeping the earliest-inserted copy of each
--    (client_id, row_hash) pair. (created_at, id) as the tie-breaker
--    handles rows inserted in the same batch with identical timestamps.
DELETE FROM revenue_data a
USING revenue_data b
WHERE a.client_id = b.client_id
  AND a.row_hash = b.row_hash
  AND (a.created_at, a.id) > (b.created_at, b.id);

-- 5. Enforce uniqueness going forward.
CREATE UNIQUE INDEX IF NOT EXISTS uq_revenue_data_client_row_hash
  ON revenue_data (client_id, row_hash);

-- 6. Make row_hash NOT NULL now that every row has one.
ALTER TABLE revenue_data
  ALTER COLUMN row_hash SET NOT NULL;
