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
];

function extractToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) return authHeader.slice(7);
  if (req.cookies?.semya_token) return req.cookies.semya_token;
  return null;
}

export async function rbacMiddleware(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'Authentication required.' });

    // Use Supabase to verify the token — works with ES256 tokens
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid or expired token.' });
    }

    const email = user.email;

    // Look up user in our users table by email
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

    const { role, client_id: clientId } = dbUser;

    // Resolve client slug
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

    // Enforce client-role scoping
    if (role === 'client') {
      if (!clientId || clientId !== client.id) {
        return res.status(403).json({ error: 'You do not have access to this client dashboard.' });
      }
    }

    // Load tab permissions
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

    req.semya = {
      user: { id: dbUser.id, role, email: dbUser.email },
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

export function requireTab(tabKey) {
  return (req, res, next) => {
    const perm = req.semya?.permissions?.[tabKey];
    if (!perm?.enabled) {
      return res.status(403).json({ error: `The '${tabKey}' module is not enabled for this client.` });
    }
    return next();
  };
}
