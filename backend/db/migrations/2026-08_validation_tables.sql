-- ═══════════════════════════════════════════════════════════════════
-- MIGRATION: Upload Validation + Data Health Log tables
-- Run in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════

-- upload_validations: one row per upload, stores validation result
CREATE TABLE IF NOT EXISTS upload_validations (
  id              BIGSERIAL PRIMARY KEY,
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  upload_id       UUID NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  platform        TEXT,
  status          TEXT NOT NULL DEFAULT 'unknown', -- 'ok' | 'warning' | 'error' | 'unknown'
  row_count       INTEGER DEFAULT 0,
  order_count     INTEGER DEFAULT 0,
  revenue_total   NUMERIC(14,2) DEFAULT 0,
  cancelled_count INTEGER DEFAULT 0,
  issues          JSONB DEFAULT '[]',
  ai_summary      TEXT,
  ai_flags        JSONB DEFAULT '[]',
  validated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (upload_id)
);

CREATE INDEX IF NOT EXISTS idx_upload_validations_client
  ON upload_validations (client_id, validated_at DESC);

-- data_health_log: one row per scheduled health check run
CREATE TABLE IF NOT EXISTS data_health_log (
  id                  BIGSERIAL PRIMARY KEY,
  client_id           UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  checked_at          TIMESTAMPTZ DEFAULT NOW(),
  overall_status      TEXT DEFAULT 'ok',  -- 'ok' | 'warning' | 'error'
  platform_stats      JSONB DEFAULT '[]',
  issues              JSONB DEFAULT '[]',
  ai_summary          TEXT,
  ai_recommendations  JSONB DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_data_health_client
  ON data_health_log (client_id, checked_at DESC);

-- RLS
ALTER TABLE upload_validations ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_health_log    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_upload_validations" ON upload_validations;
CREATE POLICY "service_role_upload_validations"
  ON upload_validations FOR ALL TO service_role USING (true);

DROP POLICY IF EXISTS "service_role_data_health_log" ON data_health_log;
CREATE POLICY "service_role_data_health_log"
  ON data_health_log FOR ALL TO service_role USING (true);
