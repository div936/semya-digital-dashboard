-- ─── Add to supabase_schema.sql ────────────────────────────────────
-- Run this in your Supabase SQL Editor to add targets support.

CREATE TABLE IF NOT EXISTS daily_targets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  target_date DATE NOT NULL,
  platform    TEXT NOT NULL,
  revenue_target  NUMERIC(14,2) NOT NULL DEFAULT 0,
  units_target    INTEGER,
  updated_by  UUID REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, target_date, platform)
);

ALTER TABLE daily_targets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "client_targets_isolation" ON daily_targets
  FOR SELECT USING (
    auth.jwt() ->> 'role' = 'admin'
    OR client_id::TEXT = auth.jwt() ->> 'client_id'
  );

-- Seed default targets for neat-everyday (today's date — adjust as needed)
WITH c AS (SELECT id FROM clients WHERE slug = 'neat-everyday')
INSERT INTO daily_targets (client_id, target_date, platform, revenue_target)
SELECT c.id, CURRENT_DATE, plat, rev
FROM c,
  (VALUES
    ('amazon',   600000),
    ('flipkart', 200000),
    ('blinkit',  100000),
    ('meta',      80000)
  ) AS t(plat, rev)
ON CONFLICT (client_id, target_date, platform) DO NOTHING;
