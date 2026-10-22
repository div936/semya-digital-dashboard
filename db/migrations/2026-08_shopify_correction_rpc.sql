-- ═══════════════════════════════════════════════════════════════════
-- MIGRATION: Shopify Revenue Correction RPC Function
--
-- Creates a PostgreSQL function called by fileIngestion.js after
-- every Meta_File / Google_File upload to fix multi-line-item
-- revenue inflation automatically.
--
-- Run this in Supabase SQL Editor ONCE before deploying the updated
-- fileIngestion.js.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION correct_shopify_sub_rows(
  p_client_id UUID,
  p_upload_id UUID
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- Zero revenue AND units on all sub-rows for this upload.
  -- Sub-rows = rows that share a standard_order_id with another row
  -- in the same upload, but are NOT the row with the highest revenue
  -- for that order.
  --
  -- This fixes Shopify's multi-line-item export structure where
  -- an order with 3 products creates 3 rows all with the same Total,
  -- causing 3× revenue inflation.

  UPDATE revenue_data r
  SET
    standard_revenue = 0,
    standard_units   = 0
  WHERE r.client_id  = p_client_id
    AND r.upload_id  = p_upload_id
    AND r.standard_order_id IS NOT NULL
    AND r.standard_status != 'Cancelled'  -- already handled separately
    AND r.id NOT IN (
      -- Keep only the row with the highest revenue per order
      -- (this is the main order row with the correct Total)
      SELECT DISTINCT ON (standard_order_id) id
      FROM revenue_data
      WHERE client_id  = p_client_id
        AND upload_id  = p_upload_id
        AND standard_order_id IS NOT NULL
        AND standard_status != 'Cancelled'
      ORDER BY standard_order_id, standard_revenue DESC, created_at ASC
    );

END;
$$;

-- Grant execute permission to the service role (used by the backend)
GRANT EXECUTE ON FUNCTION correct_shopify_sub_rows(UUID, UUID) TO service_role;
