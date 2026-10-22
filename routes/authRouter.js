// routes/authRouter.js  (Phase 8 — Magic Link + Approval Flow)
import { Router }       from 'express';
import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../lib/supabase.js';

const router = Router();

const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const ADMIN_EMAIL  = process.env.ADMIN_EMAIL  || 'admin@semyadigital.com';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://div936.github.io/semya-digital-dashboard';
const RENDER_URL   = process.env.RENDER_URL   || 'https://semya-api.onrender.com';

// Express 4 does NOT automatically catch errors thrown/rejected inside
// an async route handler — an uncaught one just hangs the request
// forever with no response ever sent, which is exactly what "Approve
// is clickable but does nothing" turned out to be. This wraps every
// handler in this file so that can't happen again, here or in any
// future endpoint added to this router.
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      console.error('[authRouter] Unhandled error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Unexpected server error: ' + err.message });
    });
  };
}

// Resolves the caller's Supabase auth user + our own admin flag from a
// Bearer token. Returns null (and has already sent a 401/403 response)
// if the caller isn't a valid, active admin — callers should check for
// that and return immediately.
async function requireAdmin(req, res) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) { res.status(401).json({ error: 'Not authenticated.' }); return null; }
  const { data: { user }, error } = await supabaseAuth.auth.getUser(token);
  if (error || !user) { res.status(401).json({ error: 'Invalid or expired session.' }); return null; }
  const { data: dbUser } = await supabaseAdmin.from('users').select('role, is_active').eq('email', user.email).single();
  if (!dbUser?.is_active || dbUser.role !== 'admin') { res.status(403).json({ error: 'Admin only.' }); return null; }
  return user;
}

// Creates (or updates) a Supabase Auth user + our users row, and sends
// a magic sign-in link. Shared by /approve (turning a pending access
// request into a real user) and /admin/invite-employee (an admin
// proactively adding someone without a prior request) — same
// underlying operation either way, just triggered differently.
//
// BUG FIX: this used to always call createUser() + generateLink() —
// neither of which sends any email. generateLink() only RETURNS a
// link; it doesn't dispatch it anywhere. The link was being returned
// in the API response and then silently discarded by the frontend
// (the invite button never read the response body at all), so no
// email was ever going to arrive no matter how long anyone waited —
// there was nothing sending one in the first place.
//
// Fixed to try inviteUserByEmail() first for a brand-new email — this
// is the one Supabase Admin API call that actually sends a real
// email automatically (Supabase's own "You've been invited" template,
// via whatever SMTP is configured on the project — the same
// mechanism already used elsewhere in this file to notify the admin
// of a new access request). Falls back to generateLink() only when
// the person already has an auth account (inviteUserByEmail errors
// on an existing user) — in that case there's no "invite" email to
// send since they're not new, so the magic link is returned in the
// response for the frontend to show directly to the admin instead
// (copy/paste and send however they like), rather than silently
// discarding it again.
async function createOrInviteUser({ email, role, clientId, isLead = false, expiresAt = null }) {
  const cleanEmail = email.toLowerCase().trim();
  // Redirects through set-password.html instead of straight to the
  // dashboard — lets a first-time invite end with the person choosing
  // a real password, so future sign-ins don't require another magic
  // link at all. See set-password.html: it calls supabase.auth.
  // updateUser({ password }) using the session this link itself
  // establishes, then sends them on to the dashboard.
  const redirectTo = `${FRONTEND_URL}/set-password.html`;

  let authUserId = null;
  let emailSent = false;
  let magicLink = null;

  try {
    // New account: this call BOTH creates the auth user AND sends
    // them a real invite email — the only one of these calls that
    // actually dispatches anything.
    const { data: invited, error: inviteErr } = await supabaseAuth.auth.admin.inviteUserByEmail(cleanEmail, { redirectTo });
    if (inviteErr) throw inviteErr;
    authUserId = invited?.user?.id;
    emailSent = true;
  } catch (e) {
    // Most likely cause: this email already has a Supabase Auth
    // account (e.g. re-inviting, or they already have password-based
    // login set up separately) — inviteUserByEmail refuses to send a
    // fresh "invite" email to an existing user. Look up their ID and
    // fall back to a magic link the admin can hand off manually.
    console.warn('[createOrInviteUser] inviteUserByEmail failed, falling back to magic link:', e.message);
    const { data: { users } } = await supabaseAuth.auth.admin.listUsers();
    authUserId = users.find(u => u.email === cleanEmail)?.id;

    try {
      const { data: linkData } = await supabaseAuth.auth.admin.generateLink({
        type: 'magiclink', email: cleanEmail, options: { redirectTo },
      });
      magicLink = linkData?.properties?.action_link || null;
    } catch (e2) {
      console.warn('[createOrInviteUser] generateLink fallback also failed:', e2.message);
    }
  }

  const { error: upsertErr } = await supabaseAdmin.from('users').upsert({
    id: authUserId, email: cleanEmail,
    role: role === 'admin' ? 'admin' : 'client',
    client_id: role === 'admin' ? null : clientId,
    is_lead: role === 'admin' ? false : !!isLead,
    is_active: true,
    hashed_pw: 'MAGIC_LINK_AUTH',
    // Admins are never subject to expiry, regardless of what was
    // passed in — expiry is a client-account concept only.
    access_expires_at: role === 'admin' ? null : expiresAt,
  }, { onConflict: 'email' });
  if (upsertErr) throw new Error('Failed to create/update user record: ' + upsertErr.message);

  return { email: cleanEmail, emailSent, magicLink };
}


// ── POST /auth/check-access ───────────────────────────────────────
// Returns: { status: 'approved' | 'pending' | 'new' | 'expired' }
router.post('/check-access', asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required.' });
  const cleanEmail = email.toLowerCase().trim();

  const { data } = await supabaseAdmin
    .from('access_requests')
    .select('status')
    .eq('email', cleanEmail)
    .single();

  if (data?.status === 'approved') {
    // Approved doesn't automatically mean currently valid — check the
    // real, authoritative expiry on the user record itself (the
    // access_requests row's own access_expires_at is a display copy
    // for the admin UI, not what's actually enforced).
    const { data: userRow } = await supabaseAdmin
      .from('users').select('access_expires_at').eq('email', cleanEmail).single();
    if (userRow?.access_expires_at && new Date(userRow.access_expires_at) < new Date()) {
      return res.json({ status: 'expired' });
    }
  }

  return res.json({ status: data?.status || 'new' });
}));


// ── GET /auth/session-status — checked right after sign-in ────────
// Catches an expired account immediately, before it ever reaches the
// dashboard — rbacMiddleware enforces this too on every subsequent
// API call, but this lets the login page show a clear "access
// expired" message and sign the person back out, instead of them
// landing on a dashboard that then fails every single request with
// no explanation.
router.get('/session-status', asyncHandler(async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Auth required.' });

  const { data: { user }, error } = await supabaseAuth.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token.' });

  const { data: dbUser } = await supabaseAdmin
    .from('users').select('is_active').eq('email', user.email).single();

  if (!dbUser) return res.json({ status: 'not_found' });
  if (!dbUser.is_active) return res.json({ status: 'inactive' });

  let accessExpiresAt = null;
  try {
    const { data: expiryRow } = await supabaseAdmin
      .from('users').select('access_expires_at').eq('email', user.email).single();
    accessExpiresAt = expiryRow?.access_expires_at || null;
  } catch (e) {
    console.warn('[session-status] access_expires_at check failed (treating as no expiry):', e.message);
  }
  if (accessExpiresAt && new Date(accessExpiresAt) < new Date()) {
    return res.json({ status: 'expired' });
  }
  return res.json({ status: 'ok' });
}));


// ── PATCH /auth/admin/access — admin extends or clears an existing
// user's expiry (the "extend" side of the expire → extend-or-relapse
// flow). Body: { email, expiresAt } — expiresAt null means "never
// expires" going forward.
router.patch('/admin/access', asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  const { email, expiresAt } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email is required.' });
  const cleanEmail = email.toLowerCase().trim();

  const { data: targetUser } = await supabaseAdmin.from('users').select('role').eq('email', cleanEmail).single();
  if (!targetUser) return res.status(404).json({ error: 'No user found with that email.' });
  if (targetUser.role === 'admin') return res.status(400).json({ error: 'Admin accounts are never subject to expiry.' });

  const { error } = await supabaseAdmin.from('users').update({ access_expires_at: expiresAt || null }).eq('email', cleanEmail);
  if (error) return res.status(500).json({ error: 'Failed to update access: ' + error.message });

  // Keep the access_requests row's display copy in sync too.
  await supabaseAdmin.from('access_requests').update({ access_expires_at: expiresAt || null }).eq('email', cleanEmail);

  return res.json({ ok: true, email: cleanEmail, expiresAt: expiresAt || null });
}));


// ── POST /auth/request-access ────────────────────────────────────
// New user: create pending request + notify admin by email
router.post('/request-access', asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required.' });
  const cleanEmail = email.toLowerCase().trim();

  // Check if already exists
  const { data: existing } = await supabaseAdmin
    .from('access_requests')
    .select('id, status')
    .eq('email', cleanEmail)
    .single();

  if (existing?.status === 'approved') return res.json({ ok: true });

  // BUG FIX: this used to be `if (!existing) { insert(...) }` — meaning
  // if a row already existed for this email in ANY state other than
  // 'approved' (most commonly 'rejected', but also a 'pending' row an
  // admin somehow never saw), neither branch matched: not approved, so
  // it didn't short-circuit, but also not `!existing`, so nothing was
  // inserted either. The request silently did nothing to the database
  // while still returning { ok: true } — the requester saw a genuine
  // success message for a request that was never actually re-surfaced
  // to any admin. Upserting instead means clicking "Request access"
  // always results in a real pending row, regardless of what state (if
  // any) a previous request for this email was left in.
  await supabaseAdmin.from('access_requests').upsert(
    { email: cleanEmail, status: 'pending', requested_at: new Date().toISOString(), reviewed_at: null, reviewed_by: null },
    { onConflict: 'email' }
  );

  // Notify admin via Supabase email (uses your project SMTP)
  // We send the admin a magic link to a special approve page
  const approveUrl = `${FRONTEND_URL}/approve.html?email=${encodeURIComponent(cleanEmail)}`;
  console.log(`[access-request] NEW from ${cleanEmail}`);
  console.log(`[access-request] Admin approve at: ${approveUrl}`);

  // Use Supabase to send admin a notification
  try {
    await supabaseAuth.auth.admin.inviteUserByEmail(ADMIN_EMAIL, {
      redirectTo: approveUrl,
      data: { notification: 'new_access_request', requester: cleanEmail },
    });
  } catch (e) {
    console.warn('[auth] Admin invite email failed (non-fatal):', e.message);
  }

  return res.json({ ok: true });
}));


// ── GET /auth/requests  — admin: list all requests ────────────────
router.get('/requests', asyncHandler(async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Auth required.' });

  const { data: { user }, error } = await supabaseAuth.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token.' });

  const { data: dbUser } = await supabaseAdmin
    .from('users').select('role').eq('email', user.email).single();
  if (dbUser?.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });

  const { data } = await supabaseAdmin
    .from('access_requests')
    .select('id, email, status, requested_at, client_id, access_expires_at, clients(name,slug)')
    .order('requested_at', { ascending: false });

  return res.json(data || []);
}));


// ── POST /auth/approve  — admin approves + assigns to client ──────
// Body: { email, clientId, role, expiresAt? }
// expiresAt: ISO date string, or omit/null for "never expires".
router.post('/approve', asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;

  const { email, clientId, role, expiresAt } = req.body || {};
  const isAdmin = role === 'admin';
  if (!email) return res.status(400).json({ error: 'email is required.' });
  if (!isAdmin && !clientId) return res.status(400).json({ error: 'clientId is required unless role is "admin".' });

  const cleanEmail = email.toLowerCase().trim();
  const cleanExpiresAt = isAdmin ? null : (expiresAt || null);

  // Update the originating access_requests row
  const { error: reqUpdateErr } = await supabaseAdmin.from('access_requests').update({
    status: 'approved', client_id: isAdmin ? null : clientId, reviewed_at: new Date().toISOString(),
    access_expires_at: cleanExpiresAt,
  }).eq('email', cleanEmail);
  if (reqUpdateErr) console.warn('[auth/approve] access_requests update warning:', reqUpdateErr.message);

  const result = await createOrInviteUser({ email: cleanEmail, role: isAdmin ? 'admin' : 'client', clientId, expiresAt: cleanExpiresAt });

  let client = null;
  if (!isAdmin) {
    const { data } = await supabaseAdmin.from('clients').select('slug, name').eq('id', clientId).single();
    client = data;
  }

  console.log(`[auth] Approved ${cleanEmail} as ${isAdmin ? 'Semya Admin' : 'client user for ' + client?.slug}`);

  return res.json({
    ok: true, email: cleanEmail,
    role: isAdmin ? 'admin' : 'client',
    clientName: client?.name, clientSlug: client?.slug,
    magicLink: result.magicLink,
  });
}));


// ── POST /auth/reject ─────────────────────────────────────────────
router.post('/reject', asyncHandler(async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const { data: { user }, error } = await supabaseAuth.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token.' });

  const { data: dbAdmin } = await supabaseAdmin
    .from('users').select('role').eq('email', user.email).single();
  if (dbAdmin?.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });

  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required.' });

  await supabaseAdmin.from('access_requests').update({
    status: 'rejected', reviewed_at: new Date().toISOString(),
  }).eq('email', email.toLowerCase().trim());

  return res.json({ ok: true });
}));


// ── GET /auth/me ──────────────────────────────────────────────────
router.get('/me', asyncHandler(async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });

  const { data: { user }, error } = await supabaseAuth.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid or expired session.' });

  // Same fail-safe split as rbac.js — see the long comment there for
  // why this can never be one combined query again. This is the
  // endpoint called immediately after every sign-in; it failing
  // outright over a missing optional column is exactly what caused
  // the login/dashboard redirect loop.
  const { data: dbUser } = await supabaseAdmin
    .from('users').select('role, client_id, is_active').eq('email', user.email).single();

  if (!dbUser || !dbUser.is_active) return res.status(403).json({ error: 'Account not active.' });

  let accessExpiresAt = null;
  try {
    const { data: expiryRow } = await supabaseAdmin
      .from('users').select('access_expires_at').eq('email', user.email).single();
    accessExpiresAt = expiryRow?.access_expires_at || null;
  } catch (e) {
    console.warn('[auth/me] access_expires_at check failed (treating as no expiry):', e.message);
  }
  if (accessExpiresAt && new Date(accessExpiresAt) < new Date()) {
    return res.status(403).json({ error: 'Your access has expired. Contact your account admin to renew it.', code: 'access_expired' });
  }

  let clientSlug = null;
  if (dbUser.client_id) {
    const { data: client } = await supabaseAdmin
      .from('clients').select('slug').eq('id', dbUser.client_id).single();
    clientSlug = client?.slug || null;
  }

  return res.json({
    userId: user.id, email: user.email,
    role: dbUser.role, clientId: dbUser.client_id, clientSlug,
  });
}));


// ── GET /auth/clients ──────────────────────────────────────────────
// Lists the clients this user can switch to: all clients for an admin
// (client_id IS NULL), or just their own single client otherwise.
router.get('/clients', asyncHandler(async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });

  const { data: { user }, error } = await supabaseAuth.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid or expired session.' });

  const { data: dbUser } = await supabaseAdmin
    .from('users').select('role, client_id, is_active').eq('email', user.email).single();
  if (!dbUser || !dbUser.is_active) return res.status(403).json({ error: 'Account not active.' });

  if (dbUser.role === 'admin' && !dbUser.client_id) {
    const { data: clients, error: cErr } = await supabaseAdmin
      .from('clients').select('id, slug, name').order('name');
    if (cErr) return res.status(500).json({ error: 'Failed to load client list.' });
    return res.json({ clients: clients || [] });
  }

  if (dbUser.client_id) {
    const { data: client } = await supabaseAdmin
      .from('clients').select('id, slug, name').eq('id', dbUser.client_id).single();
    return res.json({ clients: client ? [client] : [] });
  }

  return res.json({ clients: [] });
}));


// ── POST /auth/logout ─────────────────────────────────────────────
router.post('/logout', asyncHandler(async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (token) {
    try { await supabaseAuth.auth.admin.signOut(token); } catch(e) {}
  }
  return res.json({ ok: true });
}));


// ═══════════════════════════════════════════════════════════════════
// CLIENT ADMINISTRATION  (Settings → Client Administration → Client Section)
// ═══════════════════════════════════════════════════════════════════

// ── POST /auth/admin/clients — create a new client ─────────────────
// Body: { name }
router.post('/admin/clients', asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;

  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required.' });

  // Slugify, then de-duplicate against existing slugs
  let baseSlug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'client';
  let slug = baseSlug, n = 1;
  while (true) {
    const { data: existing } = await supabaseAdmin.from('clients').select('id').eq('slug', slug).maybeSingle();
    if (!existing) break;
    n += 1; slug = `${baseSlug}-${n}`;
  }

  const { data, error } = await supabaseAdmin
    .from('clients')
    .insert({ slug, name, theme: { primary: '#2563eb', deep: '#1e3a8a', accent: '#3b82f6' } })
    .select('id, slug, name')
    .single();

  if (error) return res.status(500).json({ error: 'Failed to create client: ' + error.message });
  return res.json({ ok: true, client: data });
}));


// ── GET /auth/admin/clients — list all clients + employee counts ───
router.get('/admin/clients', asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;

  // Fetch core client data — deliberately excludes registered_brands here
  // because that column may not exist yet if the migration hasn't been run.
  // Failing to select it here would 500 the entire client list. It's fetched
  // separately below in a fail-safe query identical to the rbac.js pattern
  // for access_expires_at — any failure returns null rather than 500.
  const { data: clients, error } = await supabaseAdmin
    .from('clients').select('id, slug, name').order('name');
  if (error) return res.status(500).json({ error: 'Failed to load clients.' });

  // Fail-safe: fetch registered_brands and campaign_naming_patterns separately.
  // These columns may not exist if migrations haven't been run — fail silently.
  let brandMap = {};
  let patternMap = {};
  try {
    const { data: extRows } = await supabaseAdmin
      .from('clients').select('id, registered_brands, campaign_naming_patterns');
    for (const r of extRows || []) {
      brandMap[r.id]   = r.registered_brands        || null;
      patternMap[r.id] = r.campaign_naming_patterns  || null;
    }
  } catch (_) { /* columns may not exist yet — treat as not configured */ }

  const { data: users } = await supabaseAdmin
    .from('users').select('client_id').eq('is_active', true).not('client_id', 'is', null);

  const counts = {};
  for (const u of users || []) counts[u.client_id] = (counts[u.client_id] || 0) + 1;

  return res.json({
    clients: (clients || []).map(c => ({
      ...c,
      registered_brands:        brandMap[c.id]   || null,
      campaign_naming_patterns: patternMap[c.id] || null,
      employeeCount: counts[c.id] || 0,
    })),
  });
}));


// ── PATCH /auth/admin/clients/:id — update a client's settings.
// Accepts: { registeredBrands, campaignNamingPatterns }
router.patch('/admin/clients/:id', asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  const { registeredBrands, campaignNamingPatterns } = req.body || {};

  const updates = {};

  if (registeredBrands !== undefined) {
    const cleaned = Array.isArray(registeredBrands)
      ? registeredBrands.map(b => String(b).trim()).filter(Boolean)
      : [];
    updates.registered_brands = cleaned.length ? cleaned : null;
  }

  if (campaignNamingPatterns !== undefined) {
    // Validate it's an array of pattern objects — store null if empty
    const patterns = Array.isArray(campaignNamingPatterns)
      ? campaignNamingPatterns.filter(p => p && typeof p.platform === 'string')
      : [];
    updates.campaign_naming_patterns = patterns.length ? patterns : null;
  }

  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: 'No valid fields to update.' });
  }

  const { error } = await supabaseAdmin
    .from('clients').update(updates).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Failed to update: ' + error.message });

  return res.json({ ok: true, ...updates });
}));


// ── GET /auth/admin/employees?clientId=X — list employees for a client
// clientId can also be the sentinel "__admin__" to list Semya's own
// admin team (role='admin', not scoped to any single client) rather
// than a specific client's employees.
router.get('/admin/employees', asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;

  const clientId = req.query.clientId;
  if (!clientId) return res.status(400).json({ error: 'clientId is required.' });

  let query = supabaseAdmin.from('users').select('id, email, role, is_lead, is_active, created_at, access_expires_at');
  query = clientId === '__admin__'
    ? query.eq('role', 'admin').is('client_id', null)
    : query.eq('client_id', clientId);

  const { data, error } = await query.order('created_at');
  if (error) return res.status(500).json({ error: 'Failed to load employees.' });
  return res.json({ employees: data || [] });
}));


// ── POST /auth/admin/invite-employee — directly add someone to a client
// Body: { email, clientId, isLead }
// clientId "__admin__" invites them as a Semya admin (all clients)
// instead of a single-client employee.
// Unlike /approve, this doesn't require a prior access_request — an
// admin can proactively add an employee for a client they're setting up.
router.post('/admin/invite-employee', asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;

  const { email, clientId, isLead } = req.body || {};
  if (!email || !clientId) return res.status(400).json({ error: 'email and clientId are required.' });

  if (clientId === '__admin__') {
    const result = await createOrInviteUser({ email, role: 'admin' });
    return res.json({ ok: true, ...result, clientName: 'Semya (Admins)' });
  }

  const { data: client } = await supabaseAdmin.from('clients').select('id, name').eq('id', clientId).single();
  if (!client) return res.status(404).json({ error: 'Client not found.' });

  const result = await createOrInviteUser({ email, role: 'client', clientId, isLead });
  return res.json({ ok: true, ...result, clientName: client.name });
}));


// ── DELETE /auth/admin/clients/:clientId — permanently delete a client
// Cascades automatically (via ON DELETE CASCADE) for: revenue_data,
// campaign_data, uploads, tab_permissions, UTM tracking data, SKU
// costs, platform assumptions.
//
// Two tables do NOT cascade and need explicit handling first:
//   - users.client_id only does ON DELETE SET NULL, which would leave
//     that client's employee accounts dangling (role still 'client',
//     but no client to see) rather than actually removing their
//     access — so those are deactivated first instead.
//   - access_requests.client_id has no ON DELETE behavior configured
//     at all, which means Postgres defaults to blocking the delete
//     entirely with a foreign key violation if any request ever
//     referenced this client — so that column is cleared first.
//
// This cannot be undone; the frontend must get explicit confirmation
// before calling this.
router.delete('/admin/clients/:clientId', asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  const clientId = req.params.clientId;

  const { data: client } = await supabaseAdmin.from('clients').select('id, name').eq('id', clientId).single();
  if (!client) return res.status(404).json({ error: 'Client not found.' });

  await supabaseAdmin.from('users').update({ is_active: false }).eq('client_id', clientId);
  await supabaseAdmin.from('access_requests').update({ client_id: null }).eq('client_id', clientId);

  const { error } = await supabaseAdmin.from('clients').delete().eq('id', clientId);
  if (error) return res.status(500).json({ error: 'Failed to delete client: ' + error.message });

  console.log(`[auth] Deleted client "${client.name}" (${client.id}) and all associated data.`);
  return res.json({ ok: true, deletedClientName: client.name });
}));


// ── PATCH /auth/admin/employee/:userId — update lead/active status ──
// Body: { isLead?, isActive? }
router.patch('/admin/employee/:userId', asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;

  const updates = {};
  if (typeof req.body?.isLead === 'boolean')   updates.is_lead   = req.body.isLead;
  if (typeof req.body?.isActive === 'boolean') updates.is_active = req.body.isActive;
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update.' });

  const { error } = await supabaseAdmin.from('users').update(updates).eq('id', req.params.userId);
  if (error) return res.status(500).json({ error: 'Failed to update employee: ' + error.message });
  return res.json({ ok: true });
}));


// ── DELETE /auth/admin/employee/:userId — remove a client's access ──
// Soft-remove (is_active: false) rather than a hard delete, matching
// the is_active convention already used everywhere else in this app.
router.delete('/admin/employee/:userId', asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;

  const { error } = await supabaseAdmin.from('users').update({ is_active: false }).eq('id', req.params.userId);
  if (error) return res.status(500).json({ error: 'Failed to remove employee: ' + error.message });
  return res.json({ ok: true });
}));



// ── POST /auth/admin/client-link — generate a shareable client dashboard link
// Two modes:
//   1. No email supplied → returns a plain URL (dashboard.html?client=slug)
//      The client must already have an account and sign in normally.
//   2. Email supplied → generates a Supabase magic link for that email,
//      scoped to the client. If the email doesn't have an account yet,
//      one is created automatically as a 'client' role user.
//      Returns { magicLink } — a one-click sign-in URL the admin can
//      paste into an email/WhatsApp and send directly to the client.
router.post('/admin/client-link', asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;

  const { clientSlug, email } = req.body || {};
  if (!clientSlug) return res.status(400).json({ error: 'clientSlug is required.' });

  // Look up the client
  const { data: client, error: clientErr } = await supabaseAdmin
    .from('clients').select('id, name, slug').eq('slug', clientSlug).single();
  if (clientErr || !client) return res.status(404).json({ error: 'Client not found.' });

  // Plain shareable URL — no email, no magic link
  const dashboardLink = `${FRONTEND_URL}/dashboard.html?client=${encodeURIComponent(clientSlug)}`;

  if (!email) {
    return res.json({ dashboardLink, clientName: client.name });
  }

  const cleanEmail = email.trim().toLowerCase();

  // Ensure the user exists in our DB as a client-role user for this client
  const { data: existingUser } = await supabaseAdmin
    .from('users').select('id, role, is_active').eq('email', cleanEmail).maybeSingle();

  if (!existingUser) {
    // Create the user row before generating the link
    const { error: createErr } = await supabaseAdmin.from('users').insert({
      email: cleanEmail,
      role: 'client',
      client_id: client.id,
      is_active: true,
    });
    if (createErr && !createErr.message.includes('duplicate')) {
      return res.status(500).json({ error: 'Failed to create user: ' + createErr.message });
    }
  } else if (!existingUser.is_active) {
    await supabaseAdmin.from('users').update({ is_active: true }).eq('email', cleanEmail);
  }

  // Generate a sign-in link for the client.
  // For new users: inviteUserByEmail → set-password.html → they choose a password.
  //                After that they can log in with email + password directly.
  // For existing users: falls back to a magic link (they already have a password set).
  const setPasswordRedirect = `${FRONTEND_URL}/set-password.html?client=${encodeURIComponent(clientSlug)}`;
  const dashboardRedirect   = `${FRONTEND_URL}/dashboard.html?client=${encodeURIComponent(clientSlug)}`;

  try {
    let actionLink = null;
    let isNewUser  = false;

    // Step 1: Try to invite as a new user (creates Supabase Auth account + set-password flow)
    const { data: invited, error: inviteErr } = await supabaseAuth.auth.admin.inviteUserByEmail(
      cleanEmail, { redirectTo: setPasswordRedirect }
    );
    if (!inviteErr && invited?.user) {
      actionLink = null; // Supabase sends the invite email automatically
      isNewUser  = true;
    } else {
      // Step 2: Existing user — generate a direct magic link to the dashboard
      const { data: linkData, error: linkErr } = await supabaseAuth.auth.admin.generateLink({
        type: 'magiclink',
        email: cleanEmail,
        options: { redirectTo: dashboardRedirect },
      });
      if (!linkErr && linkData?.properties?.action_link) {
        actionLink = linkData.properties.action_link;
      }
      // Step 3: Last resort — signup link (also creates auth account if missing)
      if (!actionLink) {
        const { data: signupData } = await supabaseAuth.auth.admin.generateLink({
          type: 'signup',
          email: cleanEmail,
          options: { redirectTo: setPasswordRedirect },
        });
        actionLink = signupData?.properties?.action_link || null;
      }
    }

    return res.json({
      magicLink:   actionLink,     // null if invite email was auto-sent
      dashboardLink,
      clientName:  client.name,
      email:       cleanEmail,
      isNewUser,                   // true = invite email was sent; false = link returned
      message: isNewUser
        ? `Invite email sent to ${cleanEmail}. They will receive a link to set their password and access the ${client.name} dashboard.`
        : (actionLink ? `One-click sign-in link generated for ${cleanEmail}.` : `Could not generate link — check Supabase Auth settings.`),
    });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to generate link: ' + e.message });
  }
}));

// ── POST /auth/admin/set-client-password ─────────────────────────
// Admin sets a password for a client user directly.
// Creates the user in Supabase Auth + our DB if they don't exist yet.
// Body: { email, password, clientSlug }
router.post('/admin/set-client-password', asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;

  const { email, password, clientSlug } = req.body || {};
  if (!email || !password || !clientSlug) {
    return res.status(400).json({ error: 'email, password, and clientSlug are required.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const cleanEmail = email.trim().toLowerCase();

  // Look up client
  const { data: client, error: clientErr } = await supabaseAdmin
    .from('clients').select('id, name, slug').eq('slug', clientSlug).single();
  if (clientErr || !client) return res.status(404).json({ error: 'Client not found.' });

  // Check if user already exists in Supabase Auth
  const { data: { users: authUsers } } = await supabaseAuth.auth.admin.listUsers();
  const existingAuth = authUsers.find(u => u.email === cleanEmail);

  let authUserId;
  if (existingAuth) {
    // Update password for existing auth user
    authUserId = existingAuth.id;
    const { error: pwErr } = await supabaseAuth.auth.admin.updateUserById(authUserId, { password });
    if (pwErr) return res.status(500).json({ error: 'Failed to set password: ' + pwErr.message });
  } else {
    // Create new auth user with password
    const { data: created, error: createErr } = await supabaseAuth.auth.admin.createUser({
      email: cleanEmail, password, email_confirm: true,
    });
    if (createErr) return res.status(500).json({ error: 'Failed to create user: ' + createErr.message });
    authUserId = created?.user?.id;
  }

  // Upsert our users DB row
  const { error: upsertErr } = await supabaseAdmin.from('users').upsert({
    id: authUserId, email: cleanEmail,
    role: 'client', client_id: client.id,
    is_active: true, is_lead: false, hashed_pw: 'PASSWORD_AUTH',
  }, { onConflict: 'email' });
  if (upsertErr) return res.status(500).json({ error: 'Failed to save user record: ' + upsertErr.message });

  return res.json({
    ok: true,
    email: cleanEmail,
    clientName: client.name,
    loginUrl: `${FRONTEND_URL}/index.html`,
    message: `${cleanEmail} can now log in to the ${client.name} dashboard at ${FRONTEND_URL}/index.html`,
  });
}));

export default router;
