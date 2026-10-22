-- ─── Run this in Supabase SQL Editor ────────────────────────────
-- Phase 8: Magic link auth + access request flow

-- 1. Access requests table
CREATE TABLE IF NOT EXISTS access_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at  TIMESTAMPTZ,
  reviewed_by  UUID REFERENCES users(id),
  client_id    UUID REFERENCES clients(id),   -- set when approved
  notes        TEXT                            -- optional admin note
);

CREATE INDEX IF NOT EXISTS idx_access_requests_email  ON access_requests(email);
CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests(status);

ALTER TABLE access_requests ENABLE ROW LEVEL SECURITY;

-- Only admins (service role) can read/write access_requests
-- Regular users never touch this table directly
CREATE POLICY "admin_only_access_requests" ON access_requests
  FOR ALL USING (auth.jwt() ->> 'role' = 'admin');


-- 2. Seed the admin email as pre-approved so they never get blocked
-- Replace with your actual admin email
INSERT INTO access_requests (email, status, reviewed_at)
VALUES ('admin@semyadigital.com', 'approved', NOW())
ON CONFLICT (email) DO NOTHING;
