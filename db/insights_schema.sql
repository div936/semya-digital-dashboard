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


-- ═══════════════════════════════════════════════════════════════════
-- AI NARRATIVE SUMMARIES  (sidebar "smart suggestion" widget)
--
-- One row per (client, scope). "scope" is either 'all' or a single raw
-- platform ('amazon' | 'acutas' | 'flipkart' | 'blinkit' | 'meta' |
-- 'google'). Grouped filters (Amazon = amazon+acutas, Website =
-- meta+google) are composed on the frontend by showing the relevant
-- individual-platform rows side by side — no separate "group" scope
-- is stored, so there's nothing to keep in sync when a new sub-brand
-- is added later.
--
-- Regenerated automatically after every successful upload (all scopes
-- in one Claude call, see insightGenerator.js) and upserted — this
-- table always reflects the latest state, unlike ai_insights above
-- which keeps a full is_active history. Reading it is just a plain
-- SELECT, so switching the platform filter never triggers a live
-- Claude call or incurs extra cost/latency.
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS ai_narrative_summaries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  scope          TEXT NOT NULL,           -- 'all' | 'amazon' | 'acutas' | 'flipkart' | 'blinkit' | 'meta' | 'google'
  narrative      TEXT NOT NULL,           -- 2-4 sentence passage
  pointers       JSONB NOT NULL DEFAULT '[]', -- array of short bullet strings
  confidence     NUMERIC(5,2),
  has_data       BOOLEAN NOT NULL DEFAULT TRUE, -- false = "not enough data yet" placeholder, not a real analysis
  generated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  model          TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
  UNIQUE (client_id, scope)
);

CREATE INDEX IF NOT EXISTS idx_ai_narrative_client
  ON ai_narrative_summaries (client_id, scope);

ALTER TABLE ai_insights ENABLE ROW LEVEL SECURITY;

CREATE POLICY "client_insights_isolation" ON ai_insights
  FOR SELECT USING (
    auth.jwt() ->> 'role' = 'admin'
    OR client_id::TEXT = auth.jwt() ->> 'client_id'
  );
