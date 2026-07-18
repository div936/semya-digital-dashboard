-- ═══════════════════════════════════════════════════════════════════
-- SEMYA DIGITAL — SUPABASE SCHEMA
-- Multi-tenant analytics platform
-- ═══════════════════════════════════════════════════════════════════

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ───────────────────────────────────────────────────────────────────
-- 1. CLIENTS
--    One row per e-commerce brand hosted on the platform.
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clients (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT UNIQUE NOT NULL,          -- "neat-everyday" — used in URL
  name          TEXT NOT NULL,                 -- "Neat Everyday"
  logo_url      TEXT,
  theme         JSONB DEFAULT '{}'::JSONB,     -- { primary, accent, bg, ... }
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the first client
INSERT INTO clients (slug, name, theme) VALUES (
  'neat-everyday',
  'Neat Everyday',
  '{
    "primary":  "#0284c7",
    "accent":   "#0ea5e9",
    "bg":       "#f0f4f8",
    "surface":  "#ffffff",
    "border":   "#dce5ef"
  }'::JSONB
) ON CONFLICT (slug) DO NOTHING;


-- ───────────────────────────────────────────────────────────────────
-- 2. USERS
--    Platform users. role = 'admin' | 'client'
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  hashed_pw     TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'client')),
  client_id     UUID REFERENCES clients(id) ON DELETE SET NULL,
                -- NULL for admin users (they can access all clients)
                -- set for client users (scoped to one client)
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ───────────────────────────────────────────────────────────────────
-- 3. TAB PERMISSIONS
--    Admin-controlled toggles per client per tab.
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tab_permissions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  tab_key       TEXT NOT NULL,   -- "platform_sales" | "sku_performance" | etc.
  is_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by    UUID REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, tab_key)
);

-- Seed all tabs as enabled for neat-everyday
WITH c AS (SELECT id FROM clients WHERE slug = 'neat-everyday')
INSERT INTO tab_permissions (client_id, tab_key, is_enabled)
SELECT c.id, tab, TRUE
FROM c,
  UNNEST(ARRAY[
    'platform_sales',
    'sku_performance',
    'campaign_insights',
    'geographic_analysis',
    'ai_insights',
    'daily_targets'
  ]) AS tab
ON CONFLICT (client_id, tab_key) DO NOTHING;


-- ───────────────────────────────────────────────────────────────────
-- 4. REVENUE DATA  (normalised from all platforms)
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS revenue_data (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  platform          TEXT NOT NULL,   -- "amazon" | "flipkart" | "blinkit" | ...
  upload_id         UUID,            -- links back to uploads table
  order_date        DATE,
  standard_sku      TEXT,
  standard_revenue  NUMERIC(14,2),
  standard_units    INTEGER,
  standard_city     TEXT,
  standard_state    TEXT,
  standard_status   TEXT,
  raw_extras        JSONB DEFAULT '{}'::JSONB,  -- leftover unmapped columns
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_revenue_client_date
  ON revenue_data (client_id, order_date DESC);

CREATE INDEX IF NOT EXISTS idx_revenue_sku
  ON revenue_data (client_id, standard_sku);


-- ───────────────────────────────────────────────────────────────────
-- 5. CAMPAIGN DATA  (normalised from all ad platforms)
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaign_data (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  platform          TEXT NOT NULL,
  upload_id         UUID,
  campaign_date     DATE,
  campaign_name     TEXT,
  standard_spend    NUMERIC(14,2),
  standard_revenue  NUMERIC(14,2),
  standard_impressions  BIGINT,
  standard_clicks   BIGINT,
  standard_orders   INTEGER,
  raw_extras        JSONB DEFAULT '{}'::JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_client_date
  ON campaign_data (client_id, campaign_date DESC);


-- ───────────────────────────────────────────────────────────────────
-- 6. UPLOADS  (audit log for every file ingested)
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS uploads (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  uploaded_by   UUID REFERENCES users(id),
  original_name TEXT NOT NULL,
  detected_platform   TEXT,
  detected_data_type  TEXT,    -- "revenue" | "campaign"
  row_count     INTEGER,
  skipped_rows  INTEGER DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','success','error')),
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);


-- ───────────────────────────────────────────────────────────────────
-- 7. ROW-LEVEL SECURITY
--    Client users can only SELECT their own client's data.
--    Admin users bypass RLS via service role key.
-- ───────────────────────────────────────────────────────────────────
ALTER TABLE revenue_data        ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_data       ENABLE ROW LEVEL SECURITY;
ALTER TABLE tab_permissions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE uploads             ENABLE ROW LEVEL SECURITY;

-- Policies: users can only see rows for their own client_id
-- (JWT must carry client_id claim — set in your Supabase auth hook)

CREATE POLICY "client_revenue_isolation" ON revenue_data
  FOR SELECT USING (
    auth.jwt() ->> 'role' = 'admin'
    OR client_id::TEXT = auth.jwt() ->> 'client_id'
  );

CREATE POLICY "client_campaign_isolation" ON campaign_data
  FOR SELECT USING (
    auth.jwt() ->> 'role' = 'admin'
    OR client_id::TEXT = auth.jwt() ->> 'client_id'
  );

CREATE POLICY "client_tab_permissions" ON tab_permissions
  FOR SELECT USING (
    auth.jwt() ->> 'role' = 'admin'
    OR client_id::TEXT = auth.jwt() ->> 'client_id'
  );

CREATE POLICY "client_uploads_isolation" ON uploads
  FOR SELECT USING (
    auth.jwt() ->> 'role' = 'admin'
    OR client_id::TEXT = auth.jwt() ->> 'client_id'
  );


-- ───────────────────────────────────────────────────────────────────
-- 8. HELPER: auto-update updated_at timestamps
-- ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER clients_updated_at
  BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
