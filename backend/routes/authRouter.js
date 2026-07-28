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


// ── POST /auth/check-access ───────────────────────────────────────
// Returns: { status: 'approved' | 'pending' | 'new' }
router.post('/check-access', asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required.' });

  const { data } = await supabaseAdmin
    .from('access_requests')
    .select('status')
    .eq('email', email.toLowerCase().trim())
    .single();

  return res.json({ status: data?.status || 'new' });
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
  if (!existing) {
    await supabaseAdmin.from('access_requests').insert({ email: cleanEmail, status: 'pending' });
  }

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
    .select('id, email, status, requested_at, client_id, clients(name,slug)')
    .order('requested_at', { ascending: false });

  return res.json(data || []);
}));


// ── POST /auth/approve  — admin approves + assigns to client ──────
// Body: { email, clientId }
router.post('/approve', async (req, res) => {
 try {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const { data: { user }, error } = await supabaseAuth.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token.' });

  const { data: dbAdmin } = await supabaseAdmin
    .from('users').select('role').eq('email', user.email).single();
  if (dbAdmin?.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });

  const { email, clientId, role } = req.body || {};
  const isAdmin = role === 'admin';
  if (!email) return res.status(400).json({ error: 'email is required.' });
  if (!isAdmin && !clientId) return res.status(400).json({ error: 'clientId is required unless role is "admin".' });

  const cleanEmail = email.toLowerCase().trim();

  // 1. Update access_requests
  const { error: reqUpdateErr } = await supabaseAdmin.from('access_requests').update({
    status: 'approved', client_id: isAdmin ? null : clientId, reviewed_at: new Date().toISOString(),
  }).eq('email', cleanEmail);
  if (reqUpdateErr) console.warn('[auth/approve] access_requests update warning:', reqUpdateErr.message);

  // 2. Create Supabase Auth user if they don't exist yet
  let authUserId = null;
  try {
    const { data: newAuthUser } = await supabaseAuth.auth.admin.createUser({
      email: cleanEmail, email_confirm: true,
    });
    authUserId = newAuthUser?.user?.id;
  } catch (e) {
    // User may already exist in Auth — look them up
    const { data: { users } } = await supabaseAuth.auth.admin.listUsers();
    authUserId = users.find(u => u.email === cleanEmail)?.id;
  }

  // 3. Upsert into our users table — admin approvals get role='admin'
  //    and no client_id (client_id NULL means "can access every
  //    client", per the same convention already used everywhere else
  //    in this app, e.g. GET /auth/clients and rbacMiddleware).
  const { error: upsertErr } = await supabaseAdmin.from('users').upsert({
    id: authUserId, email: cleanEmail,
    role: isAdmin ? 'admin' : 'client',
    client_id: isAdmin ? null : clientId,
    is_active: true,
    hashed_pw: 'MAGIC_LINK_AUTH',
  }, { onConflict: 'email' });
  if (upsertErr) {
    console.error('[auth/approve] users upsert failed:', upsertErr.message);
    return res.status(500).json({ error: 'Failed to create/update user record: ' + upsertErr.message });
  }

  // 4. Send approved user a magic sign-in link — wrapped separately:
  //    this can fail independently (e.g. email/SMTP not configured on
  //    the Supabase project) without that meaning the approval itself
  //    failed. The user record above is already saved either way.
  let magicLink = null;
  try {
    const { data: linkData } = await supabaseAuth.auth.admin.generateLink({
      type: 'magiclink', email: cleanEmail,
      options: { redirectTo: `${FRONTEND_URL}/dashboard.html` },
    });
    magicLink = linkData?.properties?.action_link || null;
  } catch (e) {
    console.warn('[auth/approve] generateLink failed (user was still approved):', e.message);
  }

  // Get client info for response (not applicable for a Semya Admin
  // approval — there's no single client to look up, and querying
  // .eq('id', undefined) here is exactly what was silently breaking
  // "Approve" whenever the admin path was chosen).
  let client = null;
  if (!isAdmin) {
    const { data } = await supabaseAdmin
      .from('clients').select('slug, name').eq('id', clientId).single();
    client = data;
  }

  console.log(`[auth] Approved ${cleanEmail} as ${isAdmin ? 'Semya Admin' : 'client user for ' + client?.slug}`);

  return res.json({
    ok: true, email: cleanEmail,
    role: isAdmin ? 'admin' : 'client',
    clientName: client?.name, clientSlug: client?.slug,
    magicLink,
  });
 } catch (err) {
  // With Express 4, a throw anywhere above that isn't caught means the
  // request hangs forever with no response — this outer catch is what
  // guarantees the frontend always gets *something* back instead of a
  // silent, indefinite hang on "Approving...".
  console.error('[auth/approve] Unexpected error:', err);
  return res.status(500).json({ error: 'Approval failed unexpectedly: ' + err.message });
 }
});


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

  const { data: dbUser } = await supabaseAdmin
    .from('users').select('role, client_id, is_active').eq('email', user.email).single();

  if (!dbUser || !dbUser.is_active) return res.status(403).json({ error: 'Account not active.' });

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


export default router;
