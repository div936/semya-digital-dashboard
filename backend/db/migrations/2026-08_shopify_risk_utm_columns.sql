-- ═══════════════════════════════════════════════════════════════════
-- MIGRATION: Add risk_level, tags, UTM, and financial_status columns
-- to revenue_data for Shopify API sync and AI Insights cards.
--
-- Safe to run more than once (all ADD COLUMN IF NOT EXISTS).
-- Run this in Supabase SQL Editor BEFORE deploying the updated code.
-- ═══════════════════════════════════════════════════════════════════

-- 1. New columns on revenue_data
ALTER TABLE revenue_data
  ADD COLUMN IF NOT EXISTS financial_status   TEXT,       -- raw Shopify: 'paid' | 'pending' | 'voided' | 'refunded'
  ADD COLUMN IF NOT EXISTS risk_level         TEXT,       -- 'High' | 'Low' | null  (from Shopify Risk Level column)
  ADD COLUMN IF NOT EXISTS tags               TEXT,       -- raw Shopify Tags string e.g. "COD, source-facebook, High Risk"
  ADD COLUMN IF NOT EXISTS utm_source         TEXT,       -- from note_attributes.utm_source (GoKwik)
  ADD COLUMN IF NOT EXISTS utm_campaign       TEXT,       -- from note_attributes.utm_campaign
  ADD COLUMN IF NOT EXISTS utm_medium         TEXT,       -- from note_attributes.utm_medium
  ADD COLUMN IF NOT EXISTS utm_content        TEXT,       -- from note_attributes.utm_content
  ADD COLUMN IF NOT EXISTS utm_term           TEXT,       -- from note_attributes.utm_term (ad ID)
  ADD COLUMN IF NOT EXISTS is_duplicate_flag  BOOLEAN DEFAULT FALSE;  -- Tags contains DUPLICATE_ORDER

-- 2. Indexes for the new columns (AI Insights queries filter by these)
CREATE INDEX IF NOT EXISTS idx_revenue_financial_status
  ON revenue_data (client_id, financial_status);

CREATE INDEX IF NOT EXISTS idx_revenue_risk_level
  ON revenue_data (client_id, risk_level);

CREATE INDEX IF NOT EXISTS idx_revenue_utm_campaign
  ON revenue_data (client_id, utm_campaign);

-- 3. New refunds_data table — tracks each refund independently of
--    the original order date (solves the late-return tracking problem)
CREATE TABLE IF NOT EXISTS refunds_data (
  id                    BIGSERIAL PRIMARY KEY,
  client_id             UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  platform              TEXT NOT NULL DEFAULT 'website',
  refund_id             TEXT NOT NULL,          -- Shopify refund object ID
  order_id              TEXT NOT NULL,          -- links to revenue_data.standard_order_id
  refund_line_item_id   TEXT,                   -- line item within the refund
  refund_date           DATE NOT NULL,          -- when refund was PROCESSED (not order date)
  order_date            DATE,                   -- original order date (for lag analysis)
  refund_amount         NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency              TEXT DEFAULT 'INR',
  sku                   TEXT,
  product_name          TEXT,
  quantity_returned     INTEGER DEFAULT 0,
  refund_reason         TEXT,
  refund_note           TEXT,
  restock               BOOLEAN DEFAULT FALSE,
  refund_type           TEXT,                   -- 'full' | 'partial' | 'cancellation'
  synced_at             TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (client_id, refund_id, refund_line_item_id)
);

CREATE INDEX IF NOT EXISTS idx_refunds_client_date
  ON refunds_data (client_id, refund_date);

CREATE INDEX IF NOT EXISTS idx_refunds_order_id
  ON refunds_data (client_id, order_id);

-- 4. sync_log — one row per Shopify API sync run (for visibility)
CREATE TABLE IF NOT EXISTS sync_log (
  id          BIGSERIAL PRIMARY KEY,
  client_id   UUID REFERENCES clients(id) ON DELETE CASCADE,
  sync_type   TEXT,         -- 'orders' | 'refunds'
  synced_at   TIMESTAMPTZ DEFAULT NOW(),
  status      TEXT,         -- 'success' | 'error'
  rows_synced INTEGER DEFAULT 0,
  error_msg   TEXT
);

-- Enable RLS on new tables (matches existing pattern in supabase_schema.sql)
ALTER TABLE refunds_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_log     ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS (same as every other table in the schema)
CREATE POLICY IF NOT EXISTS "service_role_refunds"
  ON refunds_data FOR ALL TO service_role USING (true);

CREATE POLICY IF NOT EXISTS "service_role_sync_log"
  ON sync_log FOR ALL TO service_role USING (true);
