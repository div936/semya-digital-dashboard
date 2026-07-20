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
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://bright-twilight-fcf255.netlify.app';
const RENDER_URL   = process.env.RENDER_URL   || 'https://semya-api.onrender.com';


// ── POST /auth/check-access ───────────────────────────────────────
// Returns: { status: 'approved' | 'pending' | 'new' }
router.post('/check-access', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required.' });

  const { data } = await supabaseAdmin
    .from('access_requests')
    .select('status')
    .eq('email', email.toLowerCase().trim())
    .single();

  return res.json({ status: data?.status || 'new' });
});


// ── POST /auth/request-access ────────────────────────────────────
// New user: create pending request + notify admin by email
router.post('/request-access', async (req, res) => {
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
});


// ── GET /auth/requests  — admin: list all requests ────────────────
router.get('/requests', async (req, res) => {
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
});


// ── POST /auth/approve  — admin approves + assigns to client ──────
// Body: { email, clientId }
router.post('/approve', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const { data: { user }, error } = await supabaseAuth.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token.' });

  const { data: dbAdmin } = await supabaseAdmin
    .from('users').select('role').eq('email', user.email).single();
  if (dbAdmin?.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });

  const { email, clientId } = req.body || {};
  if (!email || !clientId) return res.status(400).json({ error: 'email and clientId required.' });

  const cleanEmail = email.toLowerCase().trim();

  // 1. Update access_requests
  await supabaseAdmin.from('access_requests').update({
    status: 'approved', client_id: clientId, reviewed_at: new Date().toISOString(),
  }).eq('email', cleanEmail);

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

  // 3. Upsert into our users table
  await supabaseAdmin.from('users').upsert({
    id: authUserId, email: cleanEmail,
    role: 'client', client_id: clientId, is_active: true,
    hashed_pw: 'MAGIC_LINK_AUTH',
  }, { onConflict: 'email' });

  // 4. Send approved user a magic sign-in link
  const { data: linkData } = await supabaseAuth.auth.admin.generateLink({
    type: 'magiclink', email: cleanEmail,
    options: { redirectTo: `${FRONTEND_URL}/dashboard.html` },
  });

  // Get client info for response
  const { data: client } = await supabaseAdmin
    .from('clients').select('slug, name').eq('id', clientId).single();

  console.log(`[auth] Approved ${cleanEmail} for client ${client?.slug}`);

  return res.json({
    ok: true, email: cleanEmail,
    clientName: client?.name, clientSlug: client?.slug,
    magicLink: linkData?.properties?.action_link || null,
  });
});


// ── POST /auth/reject ─────────────────────────────────────────────
router.post('/reject', async (req, res) => {
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
});


// ── GET /auth/me ──────────────────────────────────────────────────
router.get('/me', async (req, res) => {
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
});


// ── POST /auth/logout ─────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (token) {
    try { await supabaseAuth.auth.admin.signOut(token); } catch(e) {}
  }
  return res.json({ ok: true });
});


export default router;
