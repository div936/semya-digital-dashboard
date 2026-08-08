// routes/targetsRouter.js
// ─────────────────────────────────────────────────────────────────
// GET  /clients/:client_slug/targets?date=YYYY-MM-DD
//   Returns the target + achieved revenue for each platform for date.
//
//   TARGET CARRY-FORWARD: a target set for one date applies to every
//   SUBSEQUENT date too, until a newer target is set — it does NOT
//   only apply to the exact date it was saved under. Ported from the
//   old dashboard, whose `platform_targets` table has a UNIQUE
//   constraint on `platform` alone (no date column at all): a target
//   is a single ongoing setting per platform, not a per-day one.
//   This system's schema keeps target_date (a real improvement — it
//   preserves a history of when targets changed, which the old
//   system's single-row-per-platform design couldn't do at all), but
//   the lookup below picks the MOST RECENT row with target_date <=
//   the requested date, not an exact match — so the practical
//   behavior matches what admins actually expect: set it once, it
//   holds until you change it again.
//
// PUT  /clients/:client_slug/targets   (admin only)
//   Body: { date: 'YYYY-MM-DD', targets: { amazon: { target: 600000 }, ... } }
//   Upserts one row per platform into daily_targets, dated from
//   whichever date is passed — that date becomes the point going
//   forward (and only forward — see the carry-forward note above)
//   where this new target takes effect.
//
// Mount in app.js:
//   import targetsRouter from './routes/targetsRouter.js';
//   app.use('/clients', targetsRouter);
// ─────────────────────────────────────────────────────────────────
import { Router } from 'express';
import { rbacMiddleware, requireTab } from '../middleware/rbac.js';
import { supabaseAdmin }  from '../lib/supabase.js';
import { todayIST } from '../lib/dateUtils.js';

const router = Router({ mergeParams: true });

// ─── GET /clients/:client_slug/targets ───────────────────────────
router.get('/:client_slug/targets', rbacMiddleware, requireTab('daily_targets'), async (req, res) => {
  const { client } = req.semya;
  const date = req.query.date || todayIST();

  // 1. Load the most recent target row on or before this date, per
  // platform — NOT an exact date match. Ordered newest-first so the
  // first row encountered for each platform in the loop below is
  // automatically the one that applies. A platform with no target
  // ever set (for any date up to and including this one) simply
  // won't appear here, same as before.
  const { data: targetRows, error: tErr } = await supabaseAdmin
    .from('daily_targets')
    .select('platform, revenue_target, units_target, spend_target, target_date')
    .eq('client_id', client.id)
    .lte('target_date', date)
    .order('target_date', { ascending: false });

  if (tErr) return res.status(500).json({ error: 'Failed to load targets.' });

  // 2. Load actual revenue for the same date from revenue_data
  const { data: revenueRows, error: rErr } = await supabaseAdmin
    .from('revenue_data')
    .select('platform, standard_revenue, standard_units, standard_status')
    .eq('client_id', client.id)
    .eq('order_date', date);

  if (rErr) return res.status(500).json({ error: 'Failed to load actuals.' });

  // 2b. Load actual ad spend for the same date from campaign_data, so
  // Daily Targets can show revenue vs spend vs plan side by side
  // instead of revenue alone.
  const { data: spendRows, error: sErr } = await supabaseAdmin
    .from('campaign_data')
    .select('platform, standard_spend')
    .eq('client_id', client.id)
    .eq('campaign_date', date);

  if (sErr) return res.status(500).json({ error: 'Failed to load spend actuals.' });

  // 3. Aggregate actuals by platform
  //
  // "Achieved" excludes cancelled orders — ported directly from the old
  // dashboard's /api/targets/summary endpoint, which has this exact
  // exclusion with a comment marking it as a deliberate bug fix:
  // "BUG FIX: Exclude Cancelled orders (status = 'Cancelled')". This
  // system had no such exclusion at all, so a cancelled order still
  // inflated "Today's Revenue" and everything derived from it — the
  // same class of overstatement as the revenue-dedup and Meta-discount
  // issues already fixed. Only "cancelled"/"canceled" are excluded
  // here, not "returned" or other statuses — matching the specific set
  // the old system's TARGETS endpoint uses (its marketing-summary
  // endpoint uses a wider exclusion list for a different report; this
  // one mirrors the narrower, Daily-Targets-specific version).
  const CANCELLED_STATUSES = new Set([
    'cancelled', 'canceled',                    // all cancelled orders
    'shipped - returned to seller',             // amazon returned
    'shipped - returning to seller',            // amazon in-transit return
    'return requested',                         // flipkart
    'refunded', 'voided',                       // shopify/meta (should already be mapped
                                                // to Cancelled on ingest, but belt+braces)
  ]);
  const actuals = {};
  for (const row of (revenueRows || [])) {
    if (row.standard_status && CANCELLED_STATUSES.has(String(row.standard_status).toLowerCase())) continue;
    const p = row.platform;
    if (!actuals[p]) actuals[p] = { revenue: 0, units: 0, spend: 0 };
    actuals[p].revenue += Number(row.standard_revenue) || 0;
    actuals[p].units   += Number(row.standard_units)   || 0;
  }
  for (const row of (spendRows || [])) {
    const p = row.platform;
    if (!actuals[p]) actuals[p] = { revenue: 0, units: 0, spend: 0 };
    actuals[p].spend += Number(row.standard_spend) || 0;
  }

  // 4. Build response shape: { targets: { amazon: { target, achieved, spendTarget, spendActual, roas } } }
  // targetRows is ordered newest target_date first — only keep the
  // FIRST row seen per platform (skip if already set), so the most
  // recent target wins. Simply overwriting on every row would do the
  // opposite: the last iteration (oldest date) would win instead.
  const targets = {};
  for (const row of (targetRows || [])) {
    if (targets[row.platform]) continue; // already have this platform's most recent target
    const a = actuals[row.platform] || { revenue: 0, units: 0, spend: 0 };
    const spendTarget = Number(row.spend_target) || 0;
    targets[row.platform] = {
      target:      Number(row.revenue_target),
      achieved:    a.revenue,
      units:       a.units,
      spendTarget,
      spendActual: a.spend,
      roas:        a.spend > 0 ? +(a.revenue / a.spend).toFixed(2) : null,
    };
  }

  // Fill in platforms that have actuals but no saved target
  for (const [plat, vals] of Object.entries(actuals)) {
    if (!targets[plat]) {
      targets[plat] = {
        target: 0, achieved: vals.revenue, units: vals.units,
        spendTarget: 0, spendActual: vals.spend,
        roas: vals.spend > 0 ? +(vals.revenue / vals.spend).toFixed(2) : null,
      };
    }
  }

  return res.json({ date, targets });
});


// ─── PUT /clients/:client_slug/targets (admin only) ───────────────
router.put('/:client_slug/targets', rbacMiddleware, async (req, res) => {
  if (!req.semya.isAdmin) {
    return res.status(403).json({ error: 'Admin access required to set targets.' });
  }

  const { client, user } = req.semya;
  const { date, targets } = req.body;

  if (!date || typeof targets !== 'object') {
    return res.status(400).json({ error: 'date (YYYY-MM-DD) and targets object are required.' });
  }

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be in YYYY-MM-DD format.' });
  }

  // Build upsert rows
  const rows = Object.entries(targets)
    .filter(([, val]) => val && typeof val.target === 'number')
    .map(([platform, val]) => ({
      client_id:      client.id,
      target_date:    date,
      platform,
      revenue_target: val.target,
      units_target:   val.units_target || null,
      spend_target:   typeof val.spendTarget === 'number' ? val.spendTarget : null,
      updated_by:     user.id,
      updated_at:     new Date().toISOString(),
    }));

  if (!rows.length) {
    return res.status(400).json({ error: 'No valid platform targets provided.' });
  }

  const { error } = await supabaseAdmin
    .from('daily_targets')
    .upsert(rows, { onConflict: 'client_id,target_date,platform' });

  if (error) {
    console.error('[targets] Upsert failed:', error.message);
    return res.status(500).json({ error: 'Failed to save targets.' });
  }

  return res.json({ ok: true, date, platforms: rows.map(r => r.platform) });
});


export default router;
