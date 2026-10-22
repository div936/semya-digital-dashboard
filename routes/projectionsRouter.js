// routes/projectionsRouter.js
// ─────────────────────────────────────────────────────────────────
// Projections Insights v2
//
// NEW endpoints:
//   GET   /clients/:client_slug/projections/overview
//     KPI totals + weekly cumulative series + linear/growth-rate projection
//     Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD
//
//   GET   /clients/:client_slug/projections/sku-breakeven
//     Per-SKU break-even analysis for one platform
//     Query: ?platform=amazon&from=&to=
//
//   GET   /clients/:client_slug/projections/platform-pl
//     Per-platform P&L breakdown (revenue → COGS → fees → ad-spend → net)
//     Query: ?from=&to=
//
//   GET   /clients/:client_slug/projections/overhead-config
//   POST  /clients/:client_slug/projections/overhead-config
//     Total salary + fixed overhead for revenue-weighted allocation
//
//   PATCH /clients/:client_slug/projections/sku-overhead
//     Manual overhead-per-unit override for one SKU
//
//   POST  /clients/:client_slug/projections/costs/bulk
//     Excel / CSV bulk upload of SKU cost prices (multer, max 5 MB)
//
//   GET   /clients/:client_slug/projections/costs/template
//     Download pre-filled Excel template (live SKUs from revenue_data)
//
// LEGACY endpoints kept for backward compat:
//   GET   /clients/:client_slug/projections           → same as overview
//   GET/POST /clients/:client_slug/sku-costs
//   DELETE   /clients/:client_slug/sku-costs/:id
//   GET/PATCH /clients/:client_slug/platform-assumptions  (now dynamic)
//
// SQL required (run once in Supabase SQL editor):
//
//   CREATE TABLE IF NOT EXISTS client_overhead_config (
//     id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
//     client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
//     total_salary NUMERIC NOT NULL DEFAULT 0,
//     total_fixed_overhead NUMERIC NOT NULL DEFAULT 0,
//     updated_at TIMESTAMPTZ DEFAULT now(),
//     UNIQUE (client_id)
//   );
//
//   CREATE TABLE IF NOT EXISTS sku_overhead_overrides (
//     id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
//     client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
//     sku TEXT NOT NULL,
//     overhead_per_unit NUMERIC NOT NULL DEFAULT 0,
//     is_manual_override BOOLEAN NOT NULL DEFAULT true,
//     updated_at TIMESTAMPTZ DEFAULT now(),
//     UNIQUE (client_id, sku)
//   );
// ─────────────────────────────────────────────────────────────────
import { Router }      from 'express';
import { rbacMiddleware, requireTab } from '../middleware/rbac.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { computeProfitSeries, projectProfit } from '../lib/projections.js';
import multer from 'multer';
import * as xlsx from 'xlsx';

const router = Router({ mergeParams: true });
router.use('/:client_slug', rbacMiddleware);

// ─── Multer (memory, max 5 MB) ────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 },
});

// ─── Discover active platforms from revenue_data (no hardcoding) ──
async function getActivePlatforms(clientId) {
  const { data } = await supabaseAdmin
    .from('revenue_data')
    .select('platform')
    .eq('client_id', clientId)
    .not('platform', 'is', null)
    .limit(10000);
  const seen = new Set();
  for (const r of (data || [])) if (r.platform) seen.add(String(r.platform).toLowerCase());
  return [...seen].sort();
}

// ─── Date-range filter helper ─────────────────────────────────────
function addDateFilter(q, col, from, to) {
  if (from) q = q.gte(col, from);
  if (to)   q = q.lte(col, to);
  return q;
}

// ─── Overhead config helpers ──────────────────────────────────────
async function getOverheadConfig(clientId) {
  try {
    const { data } = await supabaseAdmin
      .from('client_overhead_config')
      .select('total_salary, total_fixed_overhead')
      .eq('client_id', clientId)
      .maybeSingle();
    return data || { total_salary: 0, total_fixed_overhead: 0 };
  } catch { return { total_salary: 0, total_fixed_overhead: 0 }; }
}

async function getSkuOverheadOverrides(clientId) {
  try {
    const { data } = await supabaseAdmin
      .from('sku_overhead_overrides')
      .select('sku, overhead_per_unit, is_manual_override')
      .eq('client_id', clientId);
    const map = {};
    for (const r of (data || [])) map[r.sku] = r;
    return map;
  } catch { return {}; }
}

// CANCEL_RE is shared across endpoints
const CANCEL_RE = /cancel|return|refund|reject|void/i;

// ─── Most-recent cost price per SKU ──────────────────────────────
function buildCostMap(costRows) {
  const map = {};
  for (const c of (costRows || [])) {
    if (!map[c.sku] || c.effective_from > map[c.sku].effective_from) map[c.sku] = c;
  }
  return map;
}


// ═══════════════════════════════════════════════════════════════════
// OVERVIEW  (was the original GET /projections)
// GET /clients/:client_slug/projections/overview
// GET /clients/:client_slug/projections          ← legacy alias
// ═══════════════════════════════════════════════════════════════════
async function handleOverview(req, res) {
  const { client } = req.semya;
  const { from, to } = req.query;
  const periodsAhead = 8;
  const bucket = 'week'; // always weekly for the overview chart

  const [
    { data: revRows,        error: e1 },
    { data: campRows,       error: e2 },
    { data: costRows,       error: e3 },
    { data: assumptionRows, error: e4 },
  ] = await Promise.all([
    addDateFilter(
      supabaseAdmin.from('revenue_data')
        .select('platform, standard_sku, standard_units, standard_revenue, standard_status, order_date, raw_extras')
        .eq('client_id', client.id)
        .limit(20000),
      'order_date', from, to),
    addDateFilter(
      supabaseAdmin.from('campaign_data')
        .select('platform, standard_spend, campaign_date')
        .eq('client_id', client.id)
        .limit(10000),
      'campaign_date', from, to),
    supabaseAdmin.from('sku_costs').select('sku, cost_price, effective_from').eq('client_id', client.id),
    supabaseAdmin.from('platform_cost_assumptions')
      .select('platform, commission_percent, shipping_cost_flat')
      .eq('client_id', client.id),
  ]);

  // Revenue data is essential; cost/assumption tables are optional (may not be configured yet)
  if (e1) return res.status(500).json({ error: 'Failed to fetch revenue data.' });
  if (e2) console.warn('[projections/overview] campaign_data query failed:', e2.message);
  if (e3) console.warn('[projections/overview] sku_costs query failed:', e3.message);
  if (e4) console.warn('[projections/overview] platform_cost_assumptions query failed:', e4.message);

  const platforms = await getActivePlatforms(client.id);

  const assumptions = {};
  for (const p of platforms) assumptions[p] = { commission_percent: 0, shipping_cost_flat: 0 };
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
    platforms,
  });
}

router.get('/:client_slug/projections/overview', requireTab('projections_insights'), handleOverview);
router.get('/:client_slug/projections',           requireTab('projections_insights'), handleOverview); // legacy


// ═══════════════════════════════════════════════════════════════════
// SKU BREAK-EVEN
// GET /clients/:client_slug/projections/sku-breakeven
// Query: ?platform=amazon&from=&to=
// ═══════════════════════════════════════════════════════════════════
router.get('/:client_slug/projections/sku-breakeven', requireTab('projections_insights'), async (req, res) => {
  const { client } = req.semya;
  const { platform, from, to } = req.query;

  let revQ = addDateFilter(
    supabaseAdmin.from('revenue_data')
      .select('platform, standard_sku, standard_units, standard_revenue, standard_status, order_date')
      .eq('client_id', client.id)
      .not('standard_sku', 'is', null)
      .limit(50000),
    'order_date', from, to
  );
  if (platform) revQ = revQ.eq('platform', platform);

  const [
    { data: revRows,        error: e1 },
    { data: costRows,       error: e2 },
    { data: assumptionRows, error: e3 },
  ] = await Promise.all([
    revQ,
    supabaseAdmin.from('sku_costs').select('sku, cost_price, effective_from').eq('client_id', client.id),
    supabaseAdmin.from('platform_cost_assumptions')
      .select('platform, commission_percent, shipping_cost_flat')
      .eq('client_id', client.id),
  ]);
  if (e1 || e2 || e3) return res.status(500).json({ error: 'Failed to fetch break-even data.' });

  const [overheadConfig, overheadOverrides] = await Promise.all([
    getOverheadConfig(client.id),
    getSkuOverheadOverrides(client.id),
  ]);

  const totalFixedCost = (overheadConfig.total_salary || 0) + (overheadConfig.total_fixed_overhead || 0);
  const costMap = buildCostMap(costRows);

  const assumptions = {};
  for (const a of (assumptionRows || [])) assumptions[a.platform] = a;
  const platformAssump = platform && assumptions[platform]
    ? assumptions[platform]
    : { commission_percent: 0, shipping_cost_flat: 0 };

  // Aggregate by SKU (non-cancelled orders only)
  const skuMap = {};
  let totalRevenue = 0;

  for (const row of (revRows || [])) {
    const isCancelled = row.standard_status && CANCEL_RE.test(row.standard_status);
    if (isCancelled) continue;
    const sku = row.standard_sku;
    if (!sku) continue;
    const rev   = Number(row.standard_revenue) || 0;
    const units = Number(row.standard_units)   || 0;
    if (!skuMap[sku]) skuMap[sku] = { revenue: 0, units: 0, orderCount: 0 };
    skuMap[sku].revenue    += rev;
    skuMap[sku].units      += units;
    skuMap[sku].orderCount += 1;
    totalRevenue            += rev;
  }

  const rows = Object.entries(skuMap).map(([sku, agg]) => {
    const { revenue, units, orderCount } = agg;
    const avgPrice        = units > 0 ? revenue / units : 0;
    const costRecord      = costMap[sku];
    const cogsPerUnit     = costRecord ? Number(costRecord.cost_price) : null;
    const commissionPct   = platformAssump.commission_percent || 0;
    const commissionPerUnit  = avgPrice * (commissionPct / 100);
    // Shipping: flat per order → per-unit average
    const shippingPerUnit = orderCount > 0 && units > 0
      ? (platformAssump.shipping_cost_flat || 0) * orderCount / units
      : (platformAssump.shipping_cost_flat || 0);

    // Overhead: manual override wins, else revenue-weighted auto
    const ovrd = overheadOverrides[sku];
    let overheadPerUnit = 0;
    let overheadMode    = 'auto';
    if (ovrd && ovrd.is_manual_override) {
      overheadPerUnit = Number(ovrd.overhead_per_unit) || 0;
      overheadMode    = 'manual';
    } else if (totalFixedCost > 0 && totalRevenue > 0 && units > 0) {
      const skuRevenueShare = revenue / totalRevenue;
      overheadPerUnit       = (skuRevenueShare * totalFixedCost) / units;
    }

    const hasCogs            = cogsPerUnit !== null;
    const contributionMargin = hasCogs
      ? avgPrice - cogsPerUnit - commissionPerUnit - shippingPerUnit - overheadPerUnit
      : null;

    // Overhead total allocated to this SKU (for break-even denominator)
    const overheadAllocated = overheadMode === 'manual'
      ? overheadPerUnit * units
      : totalRevenue > 0 ? (revenue / totalRevenue) * totalFixedCost : 0;

    const breakEvenUnits = (contributionMargin !== null && contributionMargin > 0)
      ? Math.ceil(overheadAllocated / contributionMargin)
      : null;

    return {
      sku,
      avgPrice:           +avgPrice.toFixed(2),
      cogsPerUnit:        hasCogs ? +cogsPerUnit.toFixed(2) : null,
      commissionPct:      +commissionPct.toFixed(2),
      commissionPerUnit:  +commissionPerUnit.toFixed(2),
      shippingPerUnit:    +shippingPerUnit.toFixed(2),
      overheadPerUnit:    +overheadPerUnit.toFixed(2),
      overheadMode,
      contributionMargin: contributionMargin !== null ? +contributionMargin.toFixed(2) : null,
      breakEvenUnits,
      unitsSold:          units,
      revenue:            +revenue.toFixed(2),
      orderCount,
      breakEvenReached:   breakEvenUnits !== null && units >= breakEvenUnits,
      gapToBreakEven:     breakEvenUnits !== null ? Math.max(0, breakEvenUnits - units) : null,
      noCogs:             !hasCogs,
    };
  });

  rows.sort((a, b) => b.revenue - a.revenue);

  return res.json({
    platform: platform || null,
    totalRevenue:  +totalRevenue.toFixed(2),
    totalFixedCost,
    overheadConfig,
    rows,
    costConfigured: Object.keys(costMap).length > 0,
  });
});


// ═══════════════════════════════════════════════════════════════════
// PLATFORM P&L
// GET /clients/:client_slug/projections/platform-pl
// ═══════════════════════════════════════════════════════════════════
router.get('/:client_slug/projections/platform-pl', requireTab('projections_insights'), async (req, res) => {
  const { client } = req.semya;
  const { from, to } = req.query;

  const [
    { data: revRows,        error: e1 },
    { data: campRows,       error: e2 },
    { data: costRows,       error: e3 },
    { data: assumptionRows, error: e4 },
  ] = await Promise.all([
    addDateFilter(
      supabaseAdmin.from('revenue_data')
        .select('platform, standard_sku, standard_units, standard_revenue, standard_status, order_date')
        .eq('client_id', client.id)
        .limit(50000),
      'order_date', from, to),
    addDateFilter(
      supabaseAdmin.from('campaign_data')
        .select('platform, standard_spend, campaign_date')
        .eq('client_id', client.id)
        .limit(20000),
      'campaign_date', from, to),
    supabaseAdmin.from('sku_costs').select('sku, cost_price, effective_from').eq('client_id', client.id),
    supabaseAdmin.from('platform_cost_assumptions')
      .select('platform, commission_percent, shipping_cost_flat')
      .eq('client_id', client.id),
  ]);
  // Revenue data is essential; cost/assumption tables are optional
  if (e1) return res.status(500).json({ error: 'Failed to fetch revenue data.' });
  if (e2) console.warn('[projections/platform-pl] campaign_data query failed:', e2.message);
  if (e3) console.warn('[projections/platform-pl] sku_costs query failed:', e3.message);
  if (e4) console.warn('[projections/platform-pl] platform_cost_assumptions query failed:', e4.message);

  const costMap = buildCostMap(costRows);
  const assumptions = {};
  for (const a of (assumptionRows || [])) assumptions[a.platform] = a;

  const platMap = {};

  for (const row of (revRows || [])) {
    const p = row.platform;
    if (!p) continue;
    if (!platMap[p]) platMap[p] = { revenue: 0, cogs: 0, commissionFees: 0, shippingFees: 0, orderCount: 0, returnLoss: 0, adSpend: 0 };
    const pm      = platMap[p];
    const rev     = Number(row.standard_revenue) || 0;
    const units   = Number(row.standard_units)   || 0;
    const isCancelled = row.standard_status && CANCEL_RE.test(row.standard_status);
    const assump  = assumptions[p] || { commission_percent: 0, shipping_cost_flat: 0 };
    const costRec = costMap[row.standard_sku];
    const cogs    = costRec ? Number(costRec.cost_price) * units : 0;

    pm.cogs       += cogs;
    pm.orderCount += 1;

    if (isCancelled) {
      pm.returnLoss += cogs + (assump.shipping_cost_flat || 0);
    } else {
      pm.revenue        += rev;
      pm.commissionFees += rev * ((assump.commission_percent || 0) / 100);
      pm.shippingFees   += assump.shipping_cost_flat || 0;
    }
  }

  for (const row of (campRows || [])) {
    const p = row.platform;
    if (!p) continue;
    if (!platMap[p]) platMap[p] = { revenue: 0, cogs: 0, commissionFees: 0, shippingFees: 0, orderCount: 0, returnLoss: 0, adSpend: 0 };
    platMap[p].adSpend += Number(row.standard_spend) || 0;
  }

  const rows = Object.entries(platMap).map(([platform, m]) => {
    const totalFees  = m.commissionFees + m.shippingFees;
    const netContrib = m.revenue - m.cogs - totalFees - m.adSpend;
    const marginPct  = m.revenue > 0 ? (netContrib / m.revenue) * 100 : 0;
    return {
      platform,
      revenue:         +m.revenue.toFixed(2),
      cogs:            +m.cogs.toFixed(2),
      commissionFees:  +m.commissionFees.toFixed(2),
      shippingFees:    +m.shippingFees.toFixed(2),
      totalFees:       +totalFees.toFixed(2),
      adSpend:         +m.adSpend.toFixed(2),
      returnLoss:      +m.returnLoss.toFixed(2),
      netContribution: +netContrib.toFixed(2),
      marginPct:       +marginPct.toFixed(1),
      orderCount:      m.orderCount,
    };
  }).sort((a, b) => b.revenue - a.revenue);

  return res.json({ rows, hasCostData: Object.keys(costMap).length > 0 });
});


// ═══════════════════════════════════════════════════════════════════
// OVERHEAD CONFIG
// GET  /clients/:client_slug/projections/overhead-config
// POST /clients/:client_slug/projections/overhead-config
// ═══════════════════════════════════════════════════════════════════
router.get('/:client_slug/projections/overhead-config', async (req, res) => {
  const config = await getOverheadConfig(req.semya.client.id);
  return res.json({ config });
});

router.post('/:client_slug/projections/overhead-config', async (req, res) => {
  if (!req.semya.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  const { client } = req.semya;
  const { total_salary, total_fixed_overhead } = req.body || {};
  try {
    const { error } = await supabaseAdmin
      .from('client_overhead_config')
      .upsert({
        client_id:            client.id,
        total_salary:         Number(total_salary)         || 0,
        total_fixed_overhead: Number(total_fixed_overhead) || 0,
        updated_at:           new Date().toISOString(),
      }, { onConflict: 'client_id' });
    if (error) throw error;
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to save overhead config: ' + e.message });
  }
});


// ═══════════════════════════════════════════════════════════════════
// SKU OVERHEAD MANUAL OVERRIDE
// PATCH /clients/:client_slug/projections/sku-overhead
// ═══════════════════════════════════════════════════════════════════
router.patch('/:client_slug/projections/sku-overhead', async (req, res) => {
  if (!req.semya.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  const { client } = req.semya;
  const { sku, overhead_per_unit, is_manual_override } = req.body || {};
  if (!sku) return res.status(400).json({ error: 'sku is required.' });
  try {
    const { error } = await supabaseAdmin
      .from('sku_overhead_overrides')
      .upsert({
        client_id:          client.id,
        sku,
        overhead_per_unit:  Number(overhead_per_unit) || 0,
        is_manual_override: Boolean(is_manual_override),
        updated_at:         new Date().toISOString(),
      }, { onConflict: 'client_id,sku' });
    if (error) throw error;
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to save SKU overhead: ' + e.message });
  }
});


// ═══════════════════════════════════════════════════════════════════
// BULK COST UPLOAD  (Excel or CSV)
// POST /clients/:client_slug/projections/costs/bulk
// ═══════════════════════════════════════════════════════════════════
router.post('/:client_slug/projections/costs/bulk', upload.single('file'), async (req, res) => {
  if (!req.semya.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  const { client } = req.semya;
  if (!req.file)   return res.status(400).json({ error: 'No file uploaded.' });

  const fname = (req.file.originalname || '').toLowerCase();
  if (!/\.(csv|xlsx?|xls)$/i.test(fname)) {
    return res.status(400).json({ error: 'Only .csv, .xlsx, or .xls files are accepted.' });
  }

  let records = [];
  try {
    // xlsx.read handles both xlsx AND csv transparently
    const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    records  = xlsx.utils.sheet_to_json(ws, { defval: '' });
  } catch (e) {
    return res.status(400).json({ error: 'Could not parse file: ' + e.message });
  }

  const norm = (k) => String(k || '').toLowerCase().replace(/[\s_%\s]+/g, '_');

  // ── Auto-detect Inventory_SKU format ────────────────────────────
  // Signals: has "% PRICESettlement" (or similar) AND "Deal Price Amazon"
  // In this format:  Cost_Price_INR = Deal Price Amazon × (1 − % PRICESettlement)
  // Revenue comes from live Supabase data; this upload only saves per-unit COGS.
  const headerKeys = records.length ? Object.keys(records[0]).map(k => norm(k)) : [];
  const isInventorySkuFormat =
    headerKeys.some(k => k.includes('pricesettlement') || k.includes('settlement')) &&
    headerKeys.some(k => k.includes('deal_price') || k.includes('amazon'));

  const upsertRows = [];
  const errors     = [];
  const today      = new Date().toISOString().slice(0, 10);

  for (let i = 0; i < records.length; i++) {
    const rec  = records[i];
    const keys = Object.keys(rec);
    const find = (...names) => {
      for (const n of names) {
        const k = keys.find(k => norm(k) === norm(n));
        if (k !== undefined && rec[k] !== '' && rec[k] !== null && rec[k] !== undefined) return rec[k];
      }
      return null;
    };

    const sku = String(find('sku', 'product_sku', 'product', 'item') ?? '').trim();
    if (!sku) { errors.push({ row: i + 2, reason: 'Missing SKU' }); continue; }

    let costPrice;

    if (isInventorySkuFormat) {
      // ── Inventory_SKU.xlsx path ──────────────────────────────
      // cost = selling price × (1 − settlement %)
      // settlement % may be stored as 0.10 (fraction) or 10 (percent) — normalise
      const sellingPrice  = parseFloat(String(find('deal_price_amazon', 'deal price amazon', 'deal_price', 'price') ?? '0').replace(/[₹,\s]/g, ''));
      const settlementRaw = parseFloat(String(find('%_pricesettlement', '% pricesettlement', 'settlement_%', 'pricesettlement', 'settlement') ?? '0').replace(/[%,\s]/g, ''));

      if (!sellingPrice || sellingPrice <= 0) {
        errors.push({ row: i + 2, reason: `No selling price for SKU ${sku}` });
        continue;
      }
      // Normalise: if value > 1, treat as percentage (e.g. 16 → 0.16)
      const settlementPct = settlementRaw > 1 ? settlementRaw / 100 : settlementRaw;
      // COGS per unit = selling price × (1 − margin %)
      costPrice = sellingPrice * (1 - settlementPct);

    } else {
      // ── Standard template path (SKU, Cost_Price_INR, Effective_From) ─
      const costRaw = find('cost_price', 'cost_price_inr', 'cost', 'cogs', 'cost_per_unit', 'unit_cost');
      if (costRaw === null || costRaw === '') {
        errors.push({ row: i + 2, reason: 'Missing cost price' });
        continue;
      }
      costPrice = Number(String(costRaw).replace(/[₹,\s]/g, ''));
    }

    if (isNaN(costPrice) || costPrice < 0) {
      errors.push({ row: i + 2, reason: `Invalid computed cost for SKU ${sku}` });
      continue;
    }

    // Effective date: from file if standard format, else today
    let dateStr = today;
    if (!isInventorySkuFormat) {
      const effectiveRaw = find('effective_from', 'effective_date', 'date', 'from_date') ?? today;
      dateStr = String(effectiveRaw).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        errors.push({ row: i + 2, reason: `Invalid date: ${effectiveRaw}` });
        continue;
      }
    }

    upsertRows.push({ client_id: client.id, sku, cost_price: Math.round(costPrice * 100) / 100, effective_from: dateStr });
  }

  if (!upsertRows.length) {
    return res.status(400).json({ error: 'No valid rows found in upload.', parseErrors: errors });
  }

  // Batch upsert in chunks of 500
  for (let i = 0; i < upsertRows.length; i += 500) {
    const { error } = await supabaseAdmin
      .from('sku_costs')
      .upsert(upsertRows.slice(i, i + 500), { onConflict: 'client_id,sku,effective_from' });
    if (error) return res.status(500).json({ error: 'DB upsert failed: ' + error.message });
  }

  const formatType = isInventorySkuFormat ? 'Inventory SKU (COGS derived from settlement %)' : 'Standard';
  return res.json({ ok: true, imported: upsertRows.length, skipped: errors.length, errors, formatType });
});


// ═══════════════════════════════════════════════════════════════════
// EXCEL TEMPLATE DOWNLOAD  (pre-filled with live SKUs)
// GET /clients/:client_slug/projections/costs/template
// ═══════════════════════════════════════════════════════════════════
router.get('/:client_slug/projections/costs/template', async (req, res) => {
  const { client } = req.semya;
  const { data: skuRows } = await supabaseAdmin
    .from('revenue_data')
    .select('standard_sku')
    .eq('client_id', client.id)
    .not('standard_sku', 'is', null)
    .limit(5000);

  const skus = [...new Set((skuRows || []).map(r => r.standard_sku).filter(Boolean))].sort();
  const today = new Date().toISOString().slice(0, 10);

  const templateRows = skus.length
    ? skus.map(sku => ({ SKU: sku, Cost_Price_INR: '', Effective_From: today }))
    : [{ SKU: 'EXAMPLE-SKU-001', Cost_Price_INR: 150, Effective_From: today }];

  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.json_to_sheet(templateRows);
  ws['!cols'] = [{ wch: 35 }, { wch: 20 }, { wch: 18 }];
  xlsx.utils.book_append_sheet(wb, ws, 'SKU Costs');

  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="sku-costs-template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return res.send(buf);
});


// ═══════════════════════════════════════════════════════════════════
// LEGACY — SKU COSTS CRUD
// ═══════════════════════════════════════════════════════════════════
router.get('/:client_slug/sku-costs', async (req, res) => {
  const { client } = req.semya;
  const { data, error } = await supabaseAdmin
    .from('sku_costs')
    .select('id, sku, cost_price, effective_from, created_at')
    .eq('client_id', client.id)
    .order('sku')
    .order('effective_from', { ascending: false });
  if (error) return res.status(500).json({ error: 'Failed to fetch SKU costs.' });
  return res.json({ costs: data || [] });
});

router.post('/:client_slug/sku-costs', async (req, res) => {
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
});

router.delete('/:client_slug/sku-costs/:id', async (req, res) => {
  if (!req.semya.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  const { client } = req.semya;
  const { error } = await supabaseAdmin
    .from('sku_costs')
    .delete()
    .eq('id', req.params.id)
    .eq('client_id', client.id);
  if (error) return res.status(500).json({ error: 'Failed to delete SKU cost.' });
  return res.json({ ok: true });
});


// ═══════════════════════════════════════════════════════════════════
// PLATFORM COST ASSUMPTIONS  (now dynamic — no hardcoded list)
// ═══════════════════════════════════════════════════════════════════
router.get('/:client_slug/platform-assumptions', async (req, res) => {
  const { client } = req.semya;
  const [{ data, error }, platforms] = await Promise.all([
    supabaseAdmin.from('platform_cost_assumptions')
      .select('platform, commission_percent, shipping_cost_flat')
      .eq('client_id', client.id),
    getActivePlatforms(client.id),
  ]);
  if (error) return res.status(500).json({ error: 'Failed to fetch platform assumptions.' });

  const byPlatform = {};
  for (const p of platforms) byPlatform[p] = { commission_percent: 0, shipping_cost_flat: 0 };
  for (const row of (data || [])) byPlatform[row.platform] = row;

  return res.json({ assumptions: byPlatform, platforms });
});

router.patch('/:client_slug/platform-assumptions', async (req, res) => {
  if (!req.semya.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  const { client } = req.semya;
  const { platform, commission_percent, shipping_cost_flat } = req.body || {};
  if (!platform) return res.status(400).json({ error: 'platform is required.' });
  const { error } = await supabaseAdmin
    .from('platform_cost_assumptions')
    .upsert({
      client_id:          client.id,
      platform,
      commission_percent: Number(commission_percent) || 0,
      shipping_cost_flat: Number(shipping_cost_flat) || 0,
      updated_at:         new Date().toISOString(),
    }, { onConflict: 'client_id,platform' });
  if (error) return res.status(500).json({ error: 'Failed to save assumption.' });
  return res.json({ ok: true });
});


export default router;
