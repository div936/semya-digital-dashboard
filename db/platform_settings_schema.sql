-- db/platform_settings_schema.sql
-- ─────────────────────────────────────────────────────────────────
-- PLATFORM SETTINGS
--
-- Branding for the ADMIN / LOGIN page (index.html) — the one page
-- that exists before any client is selected, so it can't live on a
-- per-client `clients` row. This is a deliberate single-tenant
-- concept: there is exactly one login page, one logo, one theme for
-- it, controlled only by admins. Clients never see or edit this —
-- their own branding is what's already on `clients.logo_url` /
-- `clients.theme`, unaffected by this table.
--
-- Modeled as a singleton (always exactly one row, id = 1) rather than
-- a key/value table, since there's only ever one thing to configure.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_settings (
  id             INTEGER PRIMARY KEY DEFAULT 1,
  logo_url       TEXT,
  brand_name     TEXT NOT NULL DEFAULT 'Semya Digital',
  brand_tagline  TEXT NOT NULL DEFAULT 'Analytics Platform',
  theme          JSONB NOT NULL DEFAULT '{
    "primary": "#111111",
    "deep":    "#000000",
    "accent":  "#3f3f46"
  }'::JSONB,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT platform_settings_singleton CHECK (id = 1)
);

INSERT INTO platform_settings (id) VALUES (1)
  ON CONFLICT (id) DO NOTHING;

-- No RLS needed here the way `clients`/`revenue_data` have it —
-- GET is intentionally public (the login page loads it before
-- anyone is authenticated), and PATCH is gated in application code
-- by requireAdmin in platformSettingsRouter.js, not by a Postgres
-- policy, since there's no per-row tenant boundary to enforce.
