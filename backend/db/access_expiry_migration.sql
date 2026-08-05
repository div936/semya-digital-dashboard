-- db/access_expiry_migration.sql
-- ─────────────────────────────────────────────────────────────────
-- Adds expiring access for client accounts. NULL means "never
-- expires" (the default for existing users and for admins, who
-- should never be subject to this at all).
--
-- Checked in two places:
--   1. middleware/rbac.js — every API call rejects with a distinct
--      'access_expired' error code once this date has passed.
--   2. index.html, right after a successful sign-in — catches it
--      immediately rather than letting someone land on a dashboard
--      that then fails every single request.
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS access_expires_at TIMESTAMPTZ NULL;

-- Track the currently-approved expiry on the request record too, so
-- admins reviewing access_requests can see what was last granted
-- without needing to cross-reference the users table.
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS access_expires_at TIMESTAMPTZ NULL;
