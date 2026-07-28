// routes/projectionsRouter.js
// ─────────────────────────────────────────────────────────────────
// GET   /clients/:client_slug/projections
//   Main endpoint — profit series + linear/growth-rate projections.
//   Query: ?from=&to=&bucket=day|week|month&periodsAhead=8
//
// GET/POST /clients/:client_slug/sku-costs
//   List / add effective-dated SKU cost prices.
//
// GET/PATCH /clients/:client_slug/platform-assumptions
//   Per-platform commission % + flat shipping cost settings.
// ─────────────────────────────────────────────────────────────────
import { Router } from 'express';
import { rbacMiddleware, requireTab } from '../middleware/rbac.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { computeProfitSeries, projectProfit } from '../lib/projections.js';

const router = Router({ mergeParams: true });
router.use('/:client_slug', rbacMiddleware);

const PLATFORMS = ['amazon', 'acutas', 'flipkart', 'blinkit', 'meta', 'google'];


// ═══════════════════════════════════════════════════════════════════
// GET /clients/:client_slug/projections
// ═══════════════════════════════════════════════════════════════════
router.get(
  '/:client_slug/projections',
  requireTab('projections_insights'),
  async (req, res) => {
    const { client } = req.semya;
    const { from, to } = req.query;
    const bucket = ['day', 'week', 'month'].includes(req.query.bucket) ? req.query.bucket : 'week';
    const periodsAhead = Math.min(Math.max(parseInt(req.query.periodsAhead) || 8, 1), 26);

    let revQ = supabaseAdmin
      .from('revenue_data')
      .select('platform, standard_sku, standard_units, standard_revenue, standard_status, order_date, raw_extras')
      .eq('client_id', client.id)
      .limit(20000);
    if (from) revQ = revQ.or(`order_date.gte.${from},order_date.is.null`);
    if (to)   revQ = revQ.or(`order_date.lte.${to},order_date.is.null`);

    let campQ = supabaseAdmin
      .from('campaign_data')
      .select('platform, standard_spend, campaign_date')
      .eq('client_id', client.id)
      .limit(10000);
    if (from) campQ = campQ.or(`campaign_date.gte.${from},campaign_date.is.null`);
    if (to)   campQ = campQ.or(`campaign_date.lte.${to},campaign_date.is.null`);

    const [{ data: revRows, error: e1 }, { data: campRows, error: e2 }, { data: costRows, error: e3 }, { data: assumptionRows, error: e4 }] = await Promise.all([
      revQ, campQ,
      supabaseAdmin.from('sku_costs').select('sku, cost_price, effective_from').eq('client_id', client.id),
      supabaseAdmin.from('platform_cost_assumptions').select('platform, commission_percent, shipping_cost_flat').eq('client_id', client.id),
    ]);

    if (e1 || e2 || e3 || e4) return res.status(500).json({ error: 'Failed to fetch data for projections.' });

    const assumptions = {};
    for (const p of PLATFORMS) assumptions[p] = { commission_percent: 0, shipping_cost_flat: 0 };
    for (const a of (assumptionRows || [])) assumptions[a.platform] = a;

    const { series, totals, unpricedSkus, unpricedRevenue } = computeProfitSeries(
      revRows || [], campRows || [], costRows || [], assumptions, bucket
    );
    const projection = projectProfit(series, periodsAhead);

    return res.json({
      bucket, periodsAhead,
      series, totals, projection,
      unpricedSkus, unpricedRevenue,
      hasCostData: (costRows || []).length > 0,
    });
  }
);


// ═══════════════════════════════════════════════════════════════════
// SKU COSTS  (Settings)
// ═══════════════════════════════════════════════════════════════════
router.get(
  '/:client_slug/sku-costs',
  async (req, res) => {
    const { client } = req.semya;
    const { data, error } = await supabaseAdmin
      .from('sku_costs')
      .select('id, sku, cost_price, effective_from, created_at')
      .eq('client_id', client.id)
      .order('sku')
      .order('effective_from', { ascending: false });
    if (error) return res.status(500).json({ error: 'Failed to fetch SKU costs.' });
    return res.json({ costs: data || [] });
  }
);

router.post(
  '/:client_slug/sku-costs',
  async (req, res) => {
    if (!req.semya.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
    const { client } = req.semya;
    const { sku, cost_price, effective_from } = req.body || {};

    if (!sku || cost_price == null || !effective_from) {
      return res.status(400).json({ error: 'sku, cost_price, and effective_from are all required.' });
    }
    const price = Number(cost_price);
    if (isNaN(price) || price < 0) return res.status(400).json({ error: 'cost_price must be a non-negative number.' });

    const { data, error } = await supabaseAdmin
      .from('sku_costs')
      .upsert({ client_id: client.id, sku, cost_price: price, effective_from }, { onConflict: 'client_id,sku,effective_from' })
      .select('id, sku, cost_price, effective_from')
      .single();

    if (error) return res.status(500).json({ error: 'Failed to save SKU cost: ' + error.message });
    return res.json({ ok: true, cost: data });
  }
);

router.delete(
  '/:client_slug/sku-costs/:id',
  async (req, res) => {
    if (!req.semya.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
    const { client } = req.semya;
    const { error } = await supabaseAdmin
      .from('sku_costs')
      .delete()
      .eq('id', req.params.id)
      .eq('client_id', client.id);
    if (error) return res.status(500).json({ error: 'Failed to delete SKU cost.' });
    return res.json({ ok: true });
  }
);


// ═══════════════════════════════════════════════════════════════════
// PLATFORM COST ASSUMPTIONS  (Settings)
// ═══════════════════════════════════════════════════════════════════
router.get(
  '/:client_slug/platform-assumptions',
  async (req, res) => {
    const { client } = req.semya;
    const { data, error } = await supabaseAdmin
      .from('platform_cost_assumptions')
      .select('platform, commission_percent, shipping_cost_flat')
      .eq('client_id', client.id);
    if (error) return res.status(500).json({ error: 'Failed to fetch platform assumptions.' });

    const byPlatform = {};
    for (const p of PLATFORMS) byPlatform[p] = { commission_percent: 0, shipping_cost_flat: 0 };
    for (const row of (data || [])) byPlatform[row.platform] = row;

    return res.json({ assumptions: byPlatform });
  }
);

router.patch(
  '/:client_slug/platform-assumptions',
  async (req, res) => {
    if (!req.semya.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
    const { client } = req.semya;
    const { platform, commission_percent, shipping_cost_flat } = req.body || {};

    if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: 'Unknown platform.' });

    const { error } = await supabaseAdmin
      .from('platform_cost_assumptions')
      .upsert({
        client_id: client.id, platform,
        commission_percent: Number(commission_percent) || 0,
        shipping_cost_flat: Number(shipping_cost_flat) || 0,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'client_id,platform' });

    if (error) return res.status(500).json({ error: 'Failed to save assumption.' });
    return res.json({ ok: true });
  }
);

export default router;
