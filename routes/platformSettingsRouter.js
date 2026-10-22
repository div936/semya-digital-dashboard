// routes/platformSettingsRouter.js
// ─────────────────────────────────────────────────────────────────
// Mounts at root in app.js (NOT under /clients — this isn't scoped
// to any one client):
//   GET   /platform-settings   — PUBLIC, no auth. The login page
//                                 (index.html) calls this before
//                                 anyone is signed in, so it can
//                                 render the right logo/theme/name.
//   PATCH /platform-settings   — ADMIN ONLY. Used by the "Admin"
//                                 side of the Appearance tab in
//                                 Client Administration.
// ─────────────────────────────────────────────────────────────────
import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../lib/supabase.js';

const router = Router();

const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// Deliberately separate from rbacMiddleware in middleware/rbac.js —
// that one requires a :client_slug param and resolves a client, which
// doesn't apply here (platform settings aren't scoped to any client).
// This does the same token verification, minus the client resolution.
async function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    const token = (authHeader && authHeader.startsWith('Bearer ')) ? authHeader.slice(7)
      : req.cookies?.semya_token;
    if (!token) return res.status(401).json({ error: 'Authentication required.' });

    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Invalid or expired token.' });

    const { data: dbUser, error: userError } = await supabaseAdmin
      .from('users')
      .select('id, role, is_active')
      .eq('email', user.email.toLowerCase().trim())
      .single();

    if (userError || !dbUser) return res.status(401).json({ error: 'User not found or not registered.' });
    if (!dbUser.is_active)    return res.status(403).json({ error: 'Account is inactive.' });
    if (dbUser.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });

    req.semyaUser = dbUser;
    return next();
  } catch (err) {
    console.error('[platformSettings] auth error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
}

// ═══════════════════════════════════════════════════════════════════
// GET /platform-settings — public, unauthenticated
// ═══════════════════════════════════════════════════════════════════
router.get('/platform-settings', async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('platform_settings')
    .select('logo_url, brand_name, brand_tagline, theme')
    .eq('id', 1)
    .single();

  if (error) {
    console.error('[platformSettings] GET failed:', error.message);
    // Fail soft: the login page has hardcoded defaults it can fall
    // back to, so a broken settings fetch shouldn't block sign-in.
    return res.status(200).json({
      logoUrl: null,
      brandName: 'Semya Digital',
      brandTagline: 'Analytics Platform',
      theme: { primary: '#0284c7', deep: '#075985', accent: '#0ea5e9' },
    });
  }

  return res.json({
    logoUrl: data.logo_url,
    brandName: data.brand_name,
    brandTagline: data.brand_tagline,
    theme: data.theme,
  });
});

// ═══════════════════════════════════════════════════════════════════
// PATCH /platform-settings — admin only
// Body: { logoUrl?, brandName?, brandTagline?, theme? }
// Only provided fields are updated — omit a field to leave it as-is.
// ═══════════════════════════════════════════════════════════════════
router.patch('/platform-settings', requireAdmin, async (req, res) => {
  const { logoUrl, brandName, brandTagline, theme } = req.body || {};

  const update = { updated_at: new Date().toISOString() };
  if (logoUrl      !== undefined) update.logo_url      = logoUrl;
  if (brandName     !== undefined) update.brand_name     = brandName;
  if (brandTagline  !== undefined) update.brand_tagline  = brandTagline;
  if (theme         !== undefined) update.theme          = theme;

  const { data, error } = await supabaseAdmin
    .from('platform_settings')
    .update(update)
    .eq('id', 1)
    .select('logo_url, brand_name, brand_tagline, theme')
    .single();

  if (error) {
    console.error('[platformSettings] PATCH failed:', error.message);
    return res.status(500).json({ error: 'Failed to save platform settings: ' + error.message });
  }

  return res.json({
    logoUrl: data.logo_url,
    brandName: data.brand_name,
    brandTagline: data.brand_tagline,
    theme: data.theme,
  });
});

export default router;
