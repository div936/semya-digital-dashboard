// db/seed-users.mjs
// ─────────────────────────────────────────────────────────────────
// Run once to create your initial admin + client users.
//
//   node db/seed-users.mjs
//
// Change the emails and passwords below before running.
//
// FIXED: this used to only insert a row into the `users` table with
// a bcrypt-hashed password in `hashed_pw` — but login never actually
// checks that column. Sign-in goes through Supabase Auth directly
// (_sb.auth.signInWithPassword in index.html), completely separate
// from this app's own `users` table. A user seeded the old way exists
// in `users` but has NO matching Supabase Auth account, so sign-in
// fails with "Incorrect email or password" — which is accurate:
// Supabase Auth genuinely has no such account. This version creates
// the REAL Supabase Auth user first (via the admin API, which
// requires the service role key — already configured, since this
// script already uses it), then links it to the app-level `users` row.
// ─────────────────────────────────────────────────────────────────
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

    // Step 1: create (or find) the REAL Supabase Auth account. This is
    // what actually lets someone sign in — the users table row below
    // is just app-level metadata (role, client_id) keyed on the same
    // email, checked AFTER Supabase Auth already verified the password.
    let authUserId = null;
    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email: u.email,
      password: u.password,
      email_confirm: true, // skip the confirmation-email step — this is a seed script, not a real signup
    });

    if (createErr) {
      // Most common case on a re-run: the auth user already exists.
      // Look it up instead of failing, and update its password to
      // whatever's in this script now, so re-running with a new
      // password actually changes it rather than silently no-op'ing.
      if (createErr.message?.toLowerCase().includes('already') || createErr.status === 422) {
        const { data: list, error: listErr } = await supabase.auth.admin.listUsers();
        const existing = listErr ? null : list.users.find(x => x.email?.toLowerCase() === u.email.toLowerCase());
        if (!existing) {
          console.error(`✗ ${u.email}: auth user reported as existing but couldn't be found to update:`, createErr.message);
          continue;
        }
        authUserId = existing.id;
        const { error: updateErr } = await supabase.auth.admin.updateUserById(authUserId, {
          password: u.password,
          email_confirm: true,
        });
        if (updateErr) {
          console.error(`✗ Failed to update existing auth user ${u.email}:`, updateErr.message);
          continue;
        }
        console.log(`↻ Auth account already existed for ${u.email} — password updated.`);
      } else {
        console.error(`✗ Failed to create auth user ${u.email}:`, createErr.message);
        continue;
      }
    } else {
      authUserId = created.user.id;
      console.log(`✓ Created Supabase Auth account: ${u.email}`);
    }

    // Step 2: upsert the app-level users row (role + client scoping).
    // hashed_pw is kept only because the column is NOT NULL in the
    // current schema and nothing else reads it — real auth is fully
    // handled by Supabase Auth above now.
    const { error: insertError } = await supabase
      .from('users')
      .upsert(
        { email: u.email, hashed_pw: 'unused-see-supabase-auth', role: u.role, client_id: clientId, is_active: true },
        { onConflict: 'email' }
      );

    if (insertError) {
      console.error(`✗ Failed to seed app-level users row for ${u.email}:`, insertError.message);
    } else {
      console.log(`✓ Seeded ${u.role} user (app row): ${u.email}`);
    }
  }

  console.log('\nDone. You can now log in at the login page.');
}

run();
