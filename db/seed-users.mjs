// db/seed-users.mjs
// ─────────────────────────────────────────────────────────────────
// Run once to create your initial admin + client users.
//
//   node db/seed-users.mjs
//
// Change the emails and passwords below before running.
// ─────────────────────────────────────────────────────────────────
import 'dotenv/config';
import bcrypt from 'bcrypt';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SALT_ROUNDS = 12;

const usersToSeed = [
  {
    email:    'admin@semyadigital.com',
    password: 'ChangeMe123!',          // ← change before running
    role:     'admin',
    clientSlug: null,                  // admins aren't scoped to one client
  },
  {
    email:    'contact@neateveryday.com',
    password: 'NeatClient2025!',       // ← change before running
    role:     'client',
    clientSlug: 'neat-everyday',       // scoped to this client
  },
];

async function run() {
  for (const u of usersToSeed) {
    // Resolve client_id from slug (if applicable)
    let clientId = null;
    if (u.clientSlug) {
      const { data: client, error } = await supabase
        .from('clients')
        .select('id')
        .eq('slug', u.clientSlug)
        .single();

      if (error || !client) {
        console.error(`✗ Client '${u.clientSlug}' not found — run the schema first.`);
        process.exit(1);
      }
      clientId = client.id;
    }

    // Hash password
    const hashed_pw = await bcrypt.hash(u.password, SALT_ROUNDS);

    // Upsert user (safe to re-run)
    const { error: insertError } = await supabase
      .from('users')
      .upsert(
        { email: u.email, hashed_pw, role: u.role, client_id: clientId },
        { onConflict: 'email' }
      );

    if (insertError) {
      console.error(`✗ Failed to seed ${u.email}:`, insertError.message);
    } else {
      console.log(`✓ Seeded ${u.role} user: ${u.email}`);
    }
  }

  console.log('\nDone. You can now log in at the login page.');
}

run();
