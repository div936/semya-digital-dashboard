-- 2026-09_inventory_city_leadtime.sql
-- ─────────────────────────────────────────────────────────────────
-- Adds two columns supporting city-level Days-in-Hand calculation:
--
--   warehouses.city
--     The city name used to match against standard_city in
--     revenue_data when computing per-warehouse sales velocity.
--     Separate from the display name (warehouses.name) so you can
--     name a warehouse "Mumbai WH" while the lookup key stays
--     "Mumbai". NULL means no city configured — velocity shows as
--     NULL and the UI shows a yellow warning on that warehouse row.
--
--   inventory_stock.lead_time_days
--     Per-SKU per-warehouse replenishment lead time in days.
--     Used to compute "Reorder by" date:
--       reorder_by = today + days_remaining - lead_time_days
--     Stored here (not on warehouses) because the same warehouse
--     can have different lead times for different SKUs (e.g. a
--     fast-moving product might have a reliable 5-day restock while
--     a slower one takes 14 days from the same supplier/location).
--     Defaults to 0 (no lead-time offset shown) until set by admin.
-- ─────────────────────────────────────────────────────────────────

-- Safe to re-run: IF NOT EXISTS / column-already-exists errors are
-- suppressed by the DO block below.
DO $$
BEGIN
  -- warehouses.city
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'warehouses' AND column_name = 'city'
  ) THEN
    ALTER TABLE warehouses ADD COLUMN city TEXT;
  END IF;

  -- inventory_stock.lead_time_days
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'inventory_stock' AND column_name = 'lead_time_days'
  ) THEN
    ALTER TABLE inventory_stock
      ADD COLUMN lead_time_days INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;

-- Index so city-based velocity lookups (WHERE standard_city = ?)
-- don't do full table scans on large revenue_data tables.
CREATE INDEX IF NOT EXISTS idx_revenue_data_city_sku
  ON revenue_data (client_id, standard_city, standard_sku, order_date);
