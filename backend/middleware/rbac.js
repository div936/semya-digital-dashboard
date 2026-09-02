// middleware/rbac.js
import { supabaseAdmin } from '../lib/supabase.js';
import { createClient } from '@supabase/supabase-js';

const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

export const ALL_TABS = [
  'platform_sales',
  'sku_performance',
  'campaign_insights',
  'geographic_analysis',
  'ai_insights',
  'daily_targets',
  'utm_analytics',
  'inventory',
  'projections_insights',
];

function extractToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) return authHeader.slice(7);
  if (req.cookies?.semya_token) return req.cookies.semya_token;
  return null;
}

// ─── In-memory RBAC cache ─────────────────────────────────────────
// Problem: Every API request triggered 4-5 separate Supabase queries
// in rbacMiddleware (auth.getUser → users row → users.access_expires_at
// → clients row → tab_permissions). The dashboard fires ~8 parallel
// requests on every page load, meaning 8 × 5 = 40 Supabase queries
// hit simultaneously — enough to trigger 429 rate-limiting on
// Supabase's free tier, which caused the entire dashboard to show ₹0
// and all-zero stats with "429" errors in the network tab.
//
// Fix: cache the resolved rbac context in memory for 60 seconds,
// keyed by token. Parallel requests from the same page load (which
// all carry the same Bearer token) will share one Supabase lookup
// instead of each firing their own 5 queries.
//
// TTL of 60s means:
//   - A newly revoked/expired account stays locked out within 1 minute.
//   - Tab permission changes take effect within 1 minute.
//   - Normal usage (page loads, tab switches) hits Supabase once per
//     minute instead of 40 times per page load.
//
// Map is bounded: entries are deleted after TTL_MS, so it won't grow
// without bound even in a long-running process.
// ─────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000; // 60 seconds
const _rbacCache   = new Map(); // token → { expiresAt, context }

function getCached(token) {
  const entry = _rbacCache.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _rbacCache.delete(token);
    return null;
  }
  return entry.context;
}

function setCache(token, context) {
  _rbacCache.set(token, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    context,
  });
  // Auto-evict after TTL so the Map doesn't grow forever
  setTimeout(() => _rbacCache.delete(token), CACHE_TTL_MS);
}

// ─────────────────────────────────────────────────────────────────

export async function rbacMiddleware(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'Authentication required.' });

    // ── Check cache first ────────────────────────────────────────
    const requestedSlug = req.params.client_slug;
    const cacheKey      = `${token}:${requestedSlug}`;
    const cached        = getCached(cacheKey);

    if (cached) {
      req.semya = cached;
      return next();
    }

    // ── Cache miss — do the full Supabase lookup ─────────────────

    // 1. Verify JWT
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid or expired token.' });
    }

    const email = user.email;

    // 2. Core user row
    const { data: dbUser, error: userError } = await supabaseAdmin
      .from('users')
      .select('id, email, role, client_id, is_active')
      .eq('email', email.toLowerCase().trim())
      .single();

    if (userError || !dbUser) {
      console.error('[rbac] User not found for email:', email);
      return res.status(401).json({ error: 'User not found or not registered.' });
    }

    if (!dbUser.is_active) {
      return res.status(403).json({ error: 'Account is inactive.' });
    }

    // 3. access_expires_at — separate fail-safe query (see original
    //    comment for why this must stay separate from query #2).
    let accessExpiresAt = null;
    try {
      const { data: expiryRow } = await supabaseAdmin
        .from('users').select('access_expires_at').eq('id', dbUser.id).single();
      accessExpiresAt = expiryRow?.access_expires_at || null;
    } catch (e) {
      console.warn('[rbac] access_expires_at check failed (treating as no expiry):', e.message);
    }

    if (accessExpiresAt && new Date(accessExpiresAt) < new Date()) {
      return res.status(403).json({
        error: 'Your access has expired. Contact your account admin to renew it.',
        code:  'access_expired',
      });
    }

    const { role, client_id: clientId } = dbUser;

    // 4. Client row
    const { data: client, error: clientError } = await supabaseAdmin
      .from('clients')
      .select('id, slug, name, logo_url, theme, is_active')
      .eq('slug', requestedSlug)
      .single();

    if (clientError || !client) {
      if (clientError && clientError.code !== 'PGRST116') {
        console.error('[rbac] Client lookup failed:', clientError.message);
        return res.status(500).json({ error: 'Failed to look up client: ' + clientError.message });
      }
      return res.status(404).json({ error: `Client '${requestedSlug}' not found.` });
    }

    if (!client.is_active) {
      return res.status(403).json({ error: 'This client account is inactive.' });
    }

    // Enforce client-role scoping
    if (role === 'client') {
      if (!clientId || clientId !== client.id) {
        return res.status(403).json({ error: 'You do not have access to this client dashboard.' });
      }
    }

    // 5. Tab permissions
    const { data: tabRows, error: tabError } = await supabaseAdmin
      .from('tab_permissions')
      .select('tab_key, is_enabled')
      .eq('client_id', client.id);

    if (tabError) {
      return res.status(500).json({ error: 'Failed to load permissions.' });
    }

    const tabPermissions = {};
    for (const tab of ALL_TABS) {
      const row = tabRows?.find((r) => r.tab_key === tab);
      if (role === 'admin') {
        tabPermissions[tab] = { enabled: true, clientEnabled: row?.is_enabled ?? true };
      } else {
        tabPermissions[tab] = { enabled: row?.is_enabled ?? false };
      }
    }

    const context = {
      user:        { id: dbUser.id, role, email: dbUser.email },
      client,
      permissions: tabPermissions,
      isAdmin:     role === 'admin',
    };

    // ── Store in cache for next 60 seconds ───────────────────────
    setCache(cacheKey, context);

    req.semya = context;
    return next();

  } catch (err) {
    console.error('[rbac] Unexpected error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
}

export function requireTab(tabKey) {
  return (req, res, next) => {
    const perm = req.semya?.permissions?.[tabKey];
    if (!perm?.enabled) {
      return res.status(403).json({ error: `The '${tabKey}' module is not enabled for this client.` });
    }
    return next();
  };
}
