-- db/client_admin_schema.sql
-- ─────────────────────────────────────────────────────────────────
-- CLIENT ADMINISTRATION
--
-- Adds "lead" designation for client-side employees — the person(s)
-- an admin marks as the main point of contact for that client company.
-- Doesn't grant any extra permissions by itself (that's still governed
-- by role + tab_permissions); it's informational, so the admin panel
-- can show who's the lead at a glance.
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_lead BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_users_client_id ON users (client_id);
