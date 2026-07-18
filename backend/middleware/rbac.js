// middleware/rbac.js
// ─────────────────────────────────────────────────────────────────
// Attaches to every /clients/:client_slug/* route.
//
// What it does:
//   1. Verifies the Bearer JWT (issued by your auth layer)
//   2. Resolves the :client_slug to a client row in Supabase
//   3. For 'client' role users: enforces they can only view THEIR client
//   4. Loads the tab_permissions for the resolved client
//   5. Attaches req.semya = { client, user, permissions } for downstream use
//
// Usage:
//   router.use('/:client_slug', rbacMiddleware, yourHandler)
// ─────────────────────────────────────────────────────────────────
import jwt from 'jsonwebtoken';
import { supabaseAdmin } from '../lib/supabase.js';

const JWT_SECRET = process.env.JWT_SECRET;

// All valid tab keys — single source of truth
export const ALL_TABS = [
  'platform_sales',
  'sku_performance',
  'campaign_insights',
  'geographic_analysis',
  'ai_insights',
  'daily_targets',
];

// ─── Token extraction helper ──────────────────────────────────────
function extractToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  // Also allow token via cookie for SSR pages
  if (req.cookies?.semya_token) {
    return req.cookies.semya_token;
  }
  return null;
}

// ─── Main RBAC middleware ─────────────────────────────────────────
export async function rbacMiddleware(req, res, next) {
  try {
    // 1. Extract and verify JWT
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired token.' });
    }

    const { userId, role, clientId } = decoded;

    // 2. Resolve the :client_slug from the URL to a client row
    const requestedSlug = req.params.client_slug;

    const { data: client, error: clientError } = await supabaseAdmin
      .from('clients')
      .select('id, slug, name, logo_url, theme, is_active')
      .eq('slug', requestedSlug)
      .single();

    if (clientError || !client) {
      return res.status(404).json({ error: `Client '${requestedSlug}' not found.` });
    }

    if (!client.is_active) {
      return res.status(403).json({ error: 'This client account is inactive.' });
    }

    // 3. Enforce client-role scoping
    //    Admin users can view any client_slug.
    //    Client users can ONLY view their own client.
    if (role === 'client') {
      if (!clientId || clientId !== client.id) {
        return res.status(403).json({
          error: 'You do not have access to this client dashboard.',
        });
      }
    }

    // 4. Load tab permissions for this client
    const { data: tabRows, error: tabError } = await supabaseAdmin
      .from('tab_permissions')
      .select('tab_key, is_enabled')
      .eq('client_id', client.id);

    if (tabError) {
      console.error('[rbac] Failed to load tab permissions:', tabError.message);
      return res.status(500).json({ error: 'Failed to load permissions.' });
    }

    // Build a clean permissions map: { platform_sales: true, ai_insights: false, ... }
    // Admins always get all tabs; the map is still populated for UI hints
    const tabPermissions = {};
    for (const tab of ALL_TABS) {
      const row = tabRows?.find((r) => r.tab_key === tab);
      if (role === 'admin') {
        // Admins see everything, but we still surface the client's toggle state
        tabPermissions[tab] = { enabled: true, clientEnabled: row?.is_enabled ?? true };
      } else {
        tabPermissions[tab] = { enabled: row?.is_enabled ?? false };
      }
    }

    // 5. Attach resolved context to request for downstream handlers
    req.semya = {
      user: { id: userId, role },
      client,
      permissions: tabPermissions,
      isAdmin: role === 'admin',
    };

    return next();
  } catch (err) {
    console.error('[rbac] Unexpected error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
}


// ─── Tab guard helper ─────────────────────────────────────────────
// Use inside route handlers to block access to a specific tab.
//
// Usage:
//   router.get('/sku-data', rbacMiddleware, requireTab('sku_performance'), handler)
//
export function requireTab(tabKey) {
  return (req, res, next) => {
    const perm = req.semya?.permissions?.[tabKey];
    if (!perm?.enabled) {
      return res.status(403).json({
        error: `The '${tabKey}' module is not enabled for this client.`,
      });
    }
    return next();
  };
}
