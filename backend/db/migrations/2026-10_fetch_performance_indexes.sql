-- 2026-10_fetch_performance_indexes.sql
-- Indexes used by lib/fetchRows.js (per-day keyset paging).
-- Safe to re-run. Read-only speed-up: no data is changed.
--
-- The revenue_data one was already created by hand on 2026-10-23;
-- "if not exists" makes this a no-op for it.

create index if not exists idx_revenue_data_client_date_id
  on revenue_data (client_id, order_date, id);

create index if not exists idx_campaign_data_client_date_id
  on campaign_data (client_id, campaign_date, id);

-- Refresh planner statistics so Postgres starts using them right away.
analyze revenue_data;
analyze campaign_data;
