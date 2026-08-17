-- Migration: Add cancelled_date column to revenue_data
-- 
-- This enables Shopify-matched Net Revenue calculation where Sales Reversals
-- are counted by the date the cancellation/refund was PROCESSED, not the
-- date the order was placed. This matches Shopify Analytics exactly.
--
-- After running this migration, re-upload the Shopify CSV so existing rows
-- get their cancelled_date populated from raw_extras['Cancelled at'].
--
-- HOW TO RUN: Supabase → SQL Editor → paste and run

ALTER TABLE revenue_data
  ADD COLUMN IF NOT EXISTS cancelled_date DATE;

-- Backfill from raw_extras for existing rows
UPDATE revenue_data
SET cancelled_date = (raw_extras->>'Cancelled at')::DATE
WHERE raw_extras->>'Cancelled at' IS NOT NULL
  AND raw_extras->>'Cancelled at' NOT IN ('', 'nan', 'none')
  AND cancelled_date IS NULL;

-- Index for fast period queries on reversal date
CREATE INDEX IF NOT EXISTS idx_revenue_cancelled_date
  ON revenue_data (client_id, cancelled_date)
  WHERE cancelled_date IS NOT NULL;

-- Verify
SELECT
  COUNT(*) FILTER (WHERE cancelled_date IS NOT NULL) AS rows_with_cancel_date,
  COUNT(*) FILTER (WHERE standard_status = 'Cancelled') AS rows_with_cancelled_status,
  COUNT(*) AS total_rows
FROM revenue_data;
