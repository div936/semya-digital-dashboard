-- db/projections_schema.sql
-- ─────────────────────────────────────────────────────────────────
-- PROJECTIONS INSIGHTS
--
-- Two settings tables feed the profit/projection calculation:
--
-- sku_costs — effective-dated cost price per SKU. Multiple rows per
-- SKU are expected: when a price changes, a NEW row is inserted with
-- its own effective_from date rather than overwriting the old one, so
-- past orders keep being priced at whatever was in effect on their
-- own order date. See lib/projections.js: resolveSkuCost() picks the
-- row with the latest effective_from <= the order's date.
--
-- platform_cost_assumptions — commission % and flat shipping cost per
-- platform. Order-level files rarely carry this data reliably (Meta's
-- Shopify export has a Shipping column; Amazon/Acutas's don't have
-- either at all), so these are admin-entered assumptions used as a
-- fallback wherever the file itself doesn't state a real number.
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sku_costs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  sku            TEXT NOT NULL,
  cost_price     NUMERIC(12,2) NOT NULL,
  effective_from DATE NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, sku, effective_from)
);

CREATE INDEX IF NOT EXISTS idx_sku_costs_lookup
  ON sku_costs (client_id, sku, effective_from DESC);

CREATE TABLE IF NOT EXISTS platform_cost_assumptions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  platform            TEXT NOT NULL,
  commission_percent  NUMERIC(5,2) NOT NULL DEFAULT 0,  -- e.g. 15.00 = 15%
  shipping_cost_flat  NUMERIC(10,2) NOT NULL DEFAULT 0, -- ₹ per order, used only when the
                                                          -- order's own file has no shipping figure
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, platform)
);
