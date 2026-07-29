-- db/dedup_schema.sql
-- ─────────────────────────────────────────────────────────────────
-- DEDUPLICATION
--
-- revenue_data: dedup via a computed row_hash (see computeDedupKey()
-- in columnMapper.js) — a 3-tier key (line-item ID > order+SKU >
-- composite fallback) ported from the previous dashboard's design.
-- Re-uploading the same or an overlapping export upserts matching
-- rows (their status/revenue/units are replaced with the newest
-- values) instead of creating duplicates.
--
-- campaign_data: dedup via a natural key (platform + campaign name +
-- date) — campaign rows don't have per-line-item granularity, so no
-- hash is needed; a plain composite unique index is sufficient.
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE revenue_data ADD COLUMN IF NOT EXISTS row_hash       TEXT;
ALTER TABLE revenue_data ADD COLUMN IF NOT EXISTS order_id       TEXT;
ALTER TABLE revenue_data ADD COLUMN IF NOT EXISTS order_item_id  TEXT;
ALTER TABLE revenue_data ADD COLUMN IF NOT EXISTS dedup_method   TEXT;

-- Rows from before this migration existed have row_hash = NULL.
-- Postgres unique indexes treat every NULL as distinct from every
-- other NULL, so these old rows simply never conflict with anything
-- (no dedup applied retroactively) — only newly-ingested rows (which
-- always compute a real hash) participate in the upsert going forward.
CREATE UNIQUE INDEX IF NOT EXISTS uq_revenue_row_hash
  ON revenue_data (client_id, row_hash);

CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_natural_key
  ON campaign_data (client_id, platform, campaign_name, campaign_date);

-- Track dedup outcomes per upload for admin visibility (Upload History).
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS rows_updated           INTEGER DEFAULT 0; -- matched an existing row, values replaced
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS rows_duplicate_in_file INTEGER DEFAULT 0; -- same file had the row twice
