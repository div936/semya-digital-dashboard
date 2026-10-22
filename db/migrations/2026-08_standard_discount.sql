-- ═══════════════════════════════════════════════════════════════════
-- MIGRATION: Add standard_discount column to revenue_data
--
-- Replaces reading 'Lineitem discount' from raw_extras for the
-- Apply Discounts toggle. Once this column is populated, raw_extras
-- is only needed for fraud detection (buyer PII).
--
-- Run in Supabase SQL Editor before deploying the updated code.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE revenue_data
  ADD COLUMN IF NOT EXISTS standard_discount NUMERIC(12,2) DEFAULT 0;

-- Index helps the discount query filter efficiently
CREATE INDEX IF NOT EXISTS idx_revenue_discount
  ON revenue_data (client_id, standard_discount)
  WHERE standard_discount > 0;

-- Backfill existing rows from raw_extras where possible
-- This updates any row that has 'Lineitem discount' stored in raw_extras
UPDATE revenue_data
SET standard_discount = (raw_extras->>'Lineitem discount')::numeric
WHERE raw_extras->>'Lineitem discount' IS NOT NULL
  AND (raw_extras->>'Lineitem discount')::numeric > 0;
