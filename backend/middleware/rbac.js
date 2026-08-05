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
  'projections_insights',
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

    // Look up user in our users table by email — deliberately NOT
    // selecting access_expires_at here. See below for why: this is
    // the query every single login and API call depends on, and it
    // must never fail just because a newer, optional column hasn't
    // been migrated in yet.
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

    // Expiring access — checked as a SEPARATE, fail-safe query.
    //
    // BUG FIX (production outage): this used to be selected in the
    // SAME query as the core user lookup above. The very first time
    // this feature was deployed, the backend went out slightly ahead
    // of its own SQL migration — meaning access_expires_at didn't
    // exist as a column yet, which made that combined query fail for
    // literally every single user, rejecting every login outright.
    // Worse, that combined with index.html's "already have a session
    // → redirect to dashboard" check and the dashboard's own "auth
    // check failed → redirect to login" guard produced an infinite
    // bounce between the two pages (also fixed separately, in
    // semya_auth_guard.js, so a bad backend response can't cause that
    // loop again regardless of the cause).
    //
    // This step is now fully isolated: any failure at all — a missing
    // column, a transient query error, anything — is treated as "no
    // expiry data available," which fails safe (nobody gets locked
    // out because of an infrastructure hiccup) rather than fail
    // dangerous (everybody gets locked out). A real, deliberately-set
    // expiry still works exactly as intended when this query succeeds.
    let accessExpiresAt = null;
    try {
      const { data: expiryRow } = await supabaseAdmin
        .from('users').select('access_expires_at').eq('id', dbUser.id).single();
      accessExpiresAt = expiryRow?.access_expires_at || null;
    } catch (e) {
      console.warn('[rbac] access_expires_at check failed (treating as no expiry):', e.message);
    }

    // A distinct error code, not just a generic 403, so the frontend can
    // show "your access has expired" instead of a plain failure — this
    // is checked again right after sign-in on the login page itself, not
    // just here, so someone doesn't land on a dashboard that then fails
    // every single request with no explanation.
    if (accessExpiresAt && new Date(accessExpiresAt) < new Date()) {
      return res.status(403).json({ error: 'Your access has expired. Contact your account admin to renew it.', code: 'access_expired' });
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
      // PGRST116 = "no rows returned by .single()" — a genuinely missing
      // client. Anything else is a real query error (e.g. a column that
      // doesn't exist yet because a migration hasn't been run) and
      // should not be silently reported as "client not found" — that
      // makes a schema problem look like a data problem and wastes
      // time debugging the wrong thing.
      if (clientError && clientError.code !== 'PGRST116') {
        console.error('[rbac] Client lookup failed (not a missing-client case):', clientError.message);
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
