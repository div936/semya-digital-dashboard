// lib/supabase.js
// ─────────────────────────────────────────────────────────────────
// Exports two Supabase clients:
//   supabase      — anon/public key, respects RLS (used in API routes)
//   supabaseAdmin — service role key, bypasses RLS (used in ingestion)
// ─────────────────────────────────────────────────────────────────
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    'Missing Supabase env vars. ' +
    'Set SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY in .env'
  );
}

// Respects Row Level Security — use for all client-facing queries
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Bypasses RLS — use ONLY in server-side ingestion and admin operations
export const supabaseAdmin = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);
