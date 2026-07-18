-- ─── Add to Supabase — run in SQL Editor ─────────────────────────
-- Phase 7: AI Insights storage

CREATE TABLE IF NOT EXISTS ai_insights (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  upload_id      UUID REFERENCES uploads(id) ON DELETE SET NULL,
  insight_type   TEXT NOT NULL CHECK (insight_type IN ('warn', 'positive', 'neutral')),
  tag            TEXT NOT NULL,           -- e.g. "⚠ Inventory Burn Rate"
  body           TEXT NOT NULL,           -- full markdown-free insight text
  confidence     NUMERIC(5,2),            -- 0–100
  platform       TEXT,                    -- nullable — insight may span platforms
  sku            TEXT,                    -- nullable — insight may be cross-SKU
  generated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  model          TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
  is_active      BOOLEAN NOT NULL DEFAULT TRUE   -- soft-delete / supersede old runs
);

CREATE INDEX IF NOT EXISTS idx_ai_insights_client
  ON ai_insights (client_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_insights_active
  ON ai_insights (client_id, is_active, generated_at DESC);

ALTER TABLE ai_insights ENABLE ROW LEVEL SECURITY;

CREATE POLICY "client_insights_isolation" ON ai_insights
  FOR SELECT USING (
    auth.jwt() ->> 'role' = 'admin'
    OR client_id::TEXT = auth.jwt() ->> 'client_id'
  );
