-- ═══════════════════════════════════════════════════════════════════
-- MIGRATION: Fix row_hash consistency + add standard_discount column
--
-- Run this ONCE in Supabase SQL editor BEFORE re-uploading data files.
-- Safe to run multiple times (all operations are IF NOT EXISTS / safe DDL).
--
-- What this fixes:
-- 1. Adds standard_discount column so per-row discount is stored
--    as a real DB column rather than buried in raw_extras JSON.
-- 2. Re-backfills row_hash to include the sequence number (|seq)
--    so historical DB rows match what the current JS ingestion code
--    produces — previously the SQL backfill omitted the seq suffix
--    that fileIngestion.js now includes, causing every re-upload to
--    INSERT duplicate rows instead of UPDATE existing ones.
-- ═══════════════════════════════════════════════════════════════════

-- 1. Add standard_discount column (per-line discount amount, Shopify only)
ALTER TABLE revenue_data
  ADD COLUMN IF NOT EXISTS standard_discount NUMERIC DEFAULT 0;

-- 2. Backfill standard_discount from raw_extras for existing Shopify rows
--    (rows that have 'Lineitem discount' in their raw_extras JSON)
UPDATE revenue_data
SET standard_discount = COALESCE(
  (raw_extras->>'Lineitem discount')::numeric,
  0
)
WHERE raw_extras ? 'Lineitem discount'
  AND standard_discount IS NULL OR standard_discount = 0;

-- 3. Re-backfill row_hash for ALL existing rows to include the seq suffix (|0)
--    This fixes the mismatch: old backfill produced 'order_id_sku:ID|SKU',
--    but JS ingestion produces 'order_id_sku:ID|SKU|0'.
--    We re-backfill ALL rows with the JS-compatible format so re-uploads
--    correctly UPDATE (upsert) rather than INSERT duplicates.
--
--    NOTE: This will temporarily drop the unique constraint, re-backfill,
--    then re-add it. This is safe because the seq-aware hash is still unique
--    (same logical uniqueness guarantee, different hash value).

-- Drop constraint temporarily to allow re-hashing
DROP INDEX IF EXISTS uq_revenue_data_client_row_hash;

-- Re-backfill with seq-aware hash (matching JS computeRevenueDedupKey exactly)
UPDATE revenue_data
SET
  row_hash = CASE
    -- Tier 1: order_item_id (line-item unique ID, skip '0' placeholder)
    WHEN standard_order_item_id IS NOT NULL
      AND standard_order_item_id != ''
      AND standard_order_item_id != '0' THEN
      encode(digest('order_item_id:' || standard_order_item_id, 'sha256'), 'hex')

    -- Tier 2: order_id + sku + seq (seq defaults to 0 for historical rows)
    -- Uses ROW_NUMBER() partitioned by (platform, standard_order_id) so
    -- each row within the same order gets a unique 0-based position —
    -- matching the lineItemSeq counter in fileIngestion.js exactly.
    WHEN standard_order_id IS NOT NULL AND standard_order_id != '' THEN
      encode(digest(
        'order_id_sku:' || standard_order_id || '|' || COALESCE(standard_sku, '') || '|' ||
        (ROW_NUMBER() OVER (
          PARTITION BY client_id, platform, standard_order_id
          ORDER BY id  -- earliest-inserted row = seq 0
        ) - 1)::text,
        'sha256'
      ), 'hex')

    -- Tier 3: composite (no order ID available)
    ELSE
      encode(digest(
        'composite:' || COALESCE(order_date::text, '') || '|' || COALESCE(standard_sku, '') || '|' ||
        COALESCE(standard_state, '') || '|' || COALESCE(standard_units::text, ''),
        'sha256'
      ), 'hex')
  END,
  dedup_method = CASE
    WHEN standard_order_item_id IS NOT NULL
      AND standard_order_item_id != ''
      AND standard_order_item_id != '0' THEN 'order_item_id'
    WHEN standard_order_id IS NOT NULL AND standard_order_id != '' THEN 'order_id_sku'
    ELSE 'composite'
  END;

-- Remove any true duplicates that may have accumulated before this fix
-- (keeps the earliest-inserted copy)
DELETE FROM revenue_data a
USING revenue_data b
WHERE a.client_id = b.client_id
  AND a.row_hash = b.row_hash
  AND (a.created_at, a.id) > (b.created_at, b.id);

-- Re-add the unique constraint with the corrected hashes
CREATE UNIQUE INDEX IF NOT EXISTS uq_revenue_data_client_row_hash
  ON revenue_data (client_id, row_hash);

-- 4. Verify: show any remaining hash collisions (should be 0 after above)
-- SELECT client_id, row_hash, COUNT(*) as dup_count
-- FROM revenue_data
-- GROUP BY client_id, row_hash
-- HAVING COUNT(*) > 1
-- ORDER BY dup_count DESC;

-- ═══════════════════════════════════════════════════════════════════
-- AFTER running this migration, re-upload ALL your data files through
-- the dashboard. The re-uploads will correctly UPSERT (update existing
-- rows + insert new ones) rather than duplicating or skipping.
-- ═══════════════════════════════════════════════════════════════════
