// routes/authRouter.js
// ─────────────────────────────────────────────────────────────────
// Auth endpoints:
//   POST /auth/login    — validate credentials, issue JWT + cookie
//   POST /auth/logout   — clear cookie
//   GET  /auth/me       — return decoded token payload (token check)
//
// Mount in app.js:
//   import authRouter from './routes/authRouter.js';
//   app.use('/auth', authRouter);
// ─────────────────────────────────────────────────────────────────
import { Router } from 'express';
import jwt        from 'jsonwebtoken';
import bcrypt     from 'bcrypt';
import { supabaseAdmin } from '../lib/supabase.js';

const router     = Router();
const JWT_SECRET = process.env.JWT_SECRET;

// Cookie config — httpOnly so JS can't touch it, Secure in prod
const COOKIE_NAME = 'semya_token';
const cookieOpts  = {
  httpOnly: true,
  secure:   process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge:   7 * 24 * 60 * 60 * 1000,   // 7 days in ms
  path:     '/',
};


// ═══════════════════════════════════════════════════════════════════
// POST /auth/login
// Body: { email, password }
// ═══════════════════════════════════════════════════════════════════
router.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  // 1. Look up user + their client association
  const { data: user, error } = await supabaseAdmin
    .from('users')
    .select('id, email, hashed_pw, role, client_id, is_active')
    .eq('email', email.toLowerCase().trim())
    .single();

  // Deliberate vague error — don't reveal whether email exists
  if (error || !user) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  if (!user.is_active) {
    return res.status(403).json({ error: 'This account has been deactivated.' });
  }

  // 2. Verify password
  const passwordMatch = await bcrypt.compare(password, user.hashed_pw);
  if (!passwordMatch) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  // 3. Build JWT payload
  const payload = {
    userId:   user.id,
    email:    user.email,
    role:     user.role,
    clientId: user.client_id ?? null,
  };

  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

  // 4. Resolve the redirect URL
  //    Admin → dashboard of first client (or admin home)
  //    Client → their own client slug dashboard
  let redirectTo = '/';
  if (user.role === 'client' && user.client_id) {
    const { data: client } = await supabaseAdmin
      .from('clients')
      .select('slug')
      .eq('id', user.client_id)
      .single();
    if (client) {
      redirectTo = `/clients/${client.slug}/dashboard`;
    }
  } else if (user.role === 'admin') {
    // Admins land on the first active client by default
    const { data: firstClient } = await supabaseAdmin
      .from('clients')
      .select('slug')
      .eq('is_active', true)
      .order('created_at', { ascending: true })
      .limit(1)
      .single();
    redirectTo = firstClient
      ? `/clients/${firstClient.slug}/dashboard`
      : '/admin';
  }

  // 5. Set httpOnly cookie
  res.cookie(COOKIE_NAME, token, cookieOpts);

  return res.json({
    ok: true,
    token,          // also returned in body so JS can store in localStorage
    role:       user.role,
    redirectTo,
  });
});


// ═══════════════════════════════════════════════════════════════════
// POST /auth/logout
// ═══════════════════════════════════════════════════════════════════
router.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  return res.json({ ok: true });
});


// ═══════════════════════════════════════════════════════════════════
// GET /auth/me  — lightweight token validation
// Returns the decoded payload; 401 if missing/expired
// ═══════════════════════════════════════════════════════════════════
router.get('/me', (req, res) => {
  const token =
    req.cookies?.[COOKIE_NAME] ||
    req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return res.json({
      userId:   decoded.userId,
      email:    decoded.email,
      role:     decoded.role,
      clientId: decoded.clientId,
    });
  } catch {
    return res.status(401).json({ error: 'Token expired or invalid.' });
  }
});


export default router;
