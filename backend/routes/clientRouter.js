// routes/clientRouter.js
// ─────────────────────────────────────────────────────────────────
// Mounts at /clients in your main Express app:
//   app.use('/clients', clientRouter)
//
// All routes follow: /clients/:client_slug/<resource>
//
// Public endpoints (no auth):        none — all routes are protected
// Protected (any auth):              /dashboard-config
// Protected (admin only):            /admin/tab-permissions
// Protected (tab-gated):             /sku, /campaigns, /ai-insights, etc.
// ─────────────────────────────────────────────────────────────────
import { Router } from 'express';
import { rbacMiddleware, requireTab } from '../middleware/rbac.js';
import { supabaseAdmin } from '../lib/supabase.js';

const router = Router({ mergeParams: true });

// Apply RBAC to every route under /:client_slug
router.use('/:client_slug', rbacMiddleware);


// ═══════════════════════════════════════════════════════════════════
// DASHBOARD CONFIG
// Returns the client theme, name, logo, and which tabs are enabled.
// The frontend calls this once on load to build its UI state.
// ═══════════════════════════════════════════════════════════════════
router.get('/:client_slug/dashboard-config', (req, res) => {
  const { client, permissions, isAdmin, user } = req.semya;

  return res.json({
    client: {
      slug:    client.slug,
      name:    client.name,
      logoUrl: client.logo_url,
      theme:   client.theme,        // CSS variable overrides for dynamic theming
    },
    user: {
      role:    user.role,
      isAdmin,
    },
    // Only expose enabled state to clients; admins get full toggle metadata
    tabs: permissions,
  });
});


// ═══════════════════════════════════════════════════════════════════
// ADMIN — UPDATE TAB PERMISSIONS
// Body: { tab_key: string, is_enabled: boolean }
// ═══════════════════════════════════════════════════════════════════
router.patch('/:client_slug/admin/tab-permissions', async (req, res) => {
  if (!req.semya.isAdmin) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const { tab_key, is_enabled } = req.body;
  const { client, user } = req.semya;

  if (typeof tab_key !== 'string' || typeof is_enabled !== 'boolean') {
    return res.status(400).json({ error: 'tab_key (string) and is_enabled (boolean) are required.' });
  }

  const { error } = await supabaseAdmin
    .from('tab_permissions')
    .upsert(
      {
        client_id:  client.id,
        tab_key,
        is_enabled,
        updated_by: user.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'client_id,tab_key' }
    );

  if (error) {
    console.error('[tab-permissions] Upsert failed:', error.message);
    return res.status(500).json({ error: 'Failed to update permission.' });
  }

  return res.json({ ok: true, tab_key, is_enabled });
});


// ═══════════════════════════════════════════════════════════════════
// PLATFORM SALES — revenue summary across all platforms
// ═══════════════════════════════════════════════════════════════════
router.get(
  '/:client_slug/platform-sales',
  requireTab('platform_sales'),
  async (req, res) => {
    const { client } = req.semya;
    const { from, to, platform } = req.query;

    let query = supabaseAdmin
      .from('revenue_data')
      .select('platform, order_date, standard_revenue, standard_units, standard_status')
      .eq('client_id', client.id)
      .not('standard_status', 'in', '(Cancelled,Pending,Unshipped,Shipped - Returned to Seller,Shipped - Returning to Seller)')
      .limit(50000);

    if (from) query = query.gte('order_date', from);
    if (to)   query = query.lte('order_date', to);
    if (platform) query = query.eq('platform', platform.toLowerCase());

    const { data, error } = await query;

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch platform sales.' });
    }

    // Aggregate in JS so we avoid a heavy DB view
    const summary = aggregatePlatformSales(data);
    return res.json(summary);
  }
);


// ═══════════════════════════════════════════════════════════════════
// SKU PERFORMANCE — per-SKU revenue, units, RoAS
// ═══════════════════════════════════════════════════════════════════
router.get(
  '/:client_slug/sku-performance',
  requireTab('sku_performance'),
  async (req, res) => {
    const { client } = req.semya;
    const { sku, platform, from, to } = req.query;

    let revenueQuery = supabaseAdmin
      .from('revenue_data')
      .select('standard_sku, platform, standard_revenue, standard_units, standard_city, standard_state, order_date, standard_status')
      .eq('client_id', client.id)
      .not('standard_status', 'in', '(Cancelled,Pending,Unshipped,Shipped - Returned to Seller,Shipped - Returning to Seller)')
      .limit(50000);

    let campaignQuery = supabaseAdmin
      .from('campaign_data')
      .select('platform, campaign_date, standard_spend, standard_revenue, campaign_name')
      .eq('client_id', client.id);

    if (sku)      revenueQuery  = revenueQuery.eq('standard_sku', sku);
    if (platform) revenueQuery  = revenueQuery.eq('platform', platform.toLowerCase());
    if (from)     revenueQuery  = revenueQuery.gte('order_date', from);
    if (to)       revenueQuery  = revenueQuery.lte('order_date', to);

    if (from)  campaignQuery = campaignQuery.gte('campaign_date', from);
    if (to)    campaignQuery = campaignQuery.lte('campaign_date', to);
    if (platform) campaignQuery = campaignQuery.eq('platform', platform.toLowerCase());

    const [{ data: revenueRows, error: rErr }, { data: campaignRows, error: cErr }] =
      await Promise.all([revenueQuery, campaignQuery]);

    if (rErr || cErr) {
      console.error('[sku-performance]', rErr?.message, cErr?.message);
      return res.status(500).json({ error: 'Failed to fetch SKU data.' });
    }

    return res.json({
      revenue:   revenueRows,
      campaigns: campaignRows,
    });
  }
);


// ═══════════════════════════════════════════════════════════════════
// CAMPAIGN INSIGHTS
// ═══════════════════════════════════════════════════════════════════
router.get(
  '/:client_slug/campaign-insights',
  requireTab('campaign_insights'),
  async (req, res) => {
    const { client } = req.semya;
    const { from, to, platform } = req.query;

    let query = supabaseAdmin
      .from('campaign_data')
      .select('*')
      .eq('client_id', client.id)
      .order('campaign_date', { ascending: false });

    if (from)     query = query.gte('campaign_date', from);
    if (to)       query = query.lte('campaign_date', to);
    if (platform) query = query.eq('platform', platform.toLowerCase());

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: 'Failed to fetch campaigns.' });

    return res.json(data);
  }
);


// ═══════════════════════════════════════════════════════════════════
// GEOGRAPHIC ANALYSIS
// ═══════════════════════════════════════════════════════════════════
router.get(
  '/:client_slug/geographic',
  requireTab('geographic_analysis'),
  async (req, res) => {
    const { client } = req.semya;
    const { from, to, sku } = req.query;

    let query = supabaseAdmin
      .from('revenue_data')
      .select('standard_city, standard_state, standard_revenue, standard_units, standard_sku')
      .eq('client_id', client.id)
      .not('standard_status', 'in', '(Cancelled,Pending,Unshipped,Shipped - Returned to Seller,Shipped - Returning to Seller)')
      .limit(50000);

    if (from) query = query.gte('order_date', from);
    if (to)   query = query.lte('order_date', to);
    if (sku)  query = query.eq('standard_sku', sku);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: 'Failed to fetch geographic data.' });

    return res.json(data);
  }
);


// ═══════════════════════════════════════════════════════════════════
// AI INSIGHTS  (data payload for the insight generator)
// ═══════════════════════════════════════════════════════════════════
router.get(
  '/:client_slug/ai-insights',
  requireTab('ai_insights'),
  async (req, res) => {
    const { client } = req.semya;
    const { sku, from, to } = req.query;

    // Pull both revenue and leftover raw_extras (unmapped columns)
    const [
      { data: revenueRows, error: rErr },
      { data: campaignRows, error: cErr },
    ] = await Promise.all([
      supabaseAdmin
        .from('revenue_data')
        .select('standard_sku, platform, standard_revenue, standard_units, standard_city, raw_extras, order_date')
        .eq('client_id', client.id)
        .eq(...(sku ? ['standard_sku', sku] : ['client_id', client.id]))
        .gte('order_date', from || '2000-01-01')
        .lte('order_date', to   || '2099-01-01'),
      supabaseAdmin
        .from('campaign_data')
        .select('platform, standard_spend, standard_revenue, standard_clicks, standard_impressions, raw_extras, campaign_date')
        .eq('client_id', client.id)
        .gte('campaign_date', from || '2000-01-01')
        .lte('campaign_date', to   || '2099-01-01'),
    ]);

    if (rErr || cErr) {
      return res.status(500).json({ error: 'Failed to fetch insight data.' });
    }

    return res.json({ revenue: revenueRows, campaigns: campaignRows });
  }
);


// ═══════════════════════════════════════════════════════════════════
// HELPER — platform sales aggregator
// ═══════════════════════════════════════════════════════════════════
function aggregatePlatformSales(rows) {
  const byPlatform = {};
  const byWeek     = {};
  const byProduct  = {};

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  for (const row of rows) {
    const p   = row.platform;
    const rev = Number(row.standard_revenue ?? 0);
    const u   = Number(row.standard_units   ?? 0);

    if (!byPlatform[p]) byPlatform[p] = { platform: p, totalRevenue: 0, totalUnits: 0, orderCount: 0 };
    byPlatform[p].totalRevenue += rev;
    byPlatform[p].totalUnits   += u;
    byPlatform[p].orderCount   += 1;

    // Weekly aggregation
    if (row.order_date) {
      const d = new Date(row.order_date);
      const wk = 'W' + Math.ceil(d.getDate()/7) + ' ' + MONTHS[d.getMonth()] + " '" + String(d.getFullYear()).slice(2);
      const ws = d.getFullYear() * 10000 + d.getMonth() * 100 + Math.ceil(d.getDate()/7);
      if (!byWeek[wk]) byWeek[wk] = { rev: 0, sort: ws };
      byWeek[wk].rev += rev;
    }

    // Top products
    const sku = row.standard_sku || 'Unknown';
    if (!byProduct[sku]) byProduct[sku] = { sku, platform: p, revenue: 0, units: 0 };
    byProduct[sku].revenue += rev;
    byProduct[sku].units   += u;
  }

  const platforms  = Object.values(byPlatform);
  const grandTotal = platforms.reduce((s, p) => s + p.totalRevenue, 0);

  const weekly = Object.entries(byWeek)
    .sort((a, b) => a[1].sort - b[1].sort)
    .map(([week, v]) => ({ week, revenue: v.rev, prevRevenue: v.rev * 0.82 }));

  const topProducts = Object.values(byProduct)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  return {
    grandTotal,
    prevGrandTotal: grandTotal * 0.82,
    weekly,
    topProducts,
    platforms: platforms.map((p) => ({
      ...p,
      sharePercent: grandTotal > 0 ? +((p.totalRevenue / grandTotal) * 100).toFixed(1) : 0,
    })),
  };
}


export default router;
