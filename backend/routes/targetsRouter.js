// routes/targetsRouter.js
// ─────────────────────────────────────────────────────────────────
// GET  /clients/:client_slug/targets?date=YYYY-MM-DD
//   Returns the target + achieved revenue for each platform for date.
//
// PUT  /clients/:client_slug/targets   (admin only)
//   Body: { date: 'YYYY-MM-DD', targets: { amazon: { target: 600000 }, ... } }
//   Upserts one row per platform into daily_targets.
//
// Mount in app.js:
//   import targetsRouter from './routes/targetsRouter.js';
//   app.use('/clients', targetsRouter);
// ─────────────────────────────────────────────────────────────────
import { Router } from 'express';
import { rbacMiddleware } from '../middleware/rbac.js';
import { supabaseAdmin }  from '../lib/supabase.js';

const router = Router({ mergeParams: true });

// ─── GET /clients/:client_slug/targets ───────────────────────────
router.get('/:client_slug/targets', rbacMiddleware, async (req, res) => {
  const { client } = req.semya;
  const date = req.query.date || new Date().toISOString().split('T')[0];

  // 1. Load saved targets for this date
  const { data: targetRows, error: tErr } = await supabaseAdmin
    .from('daily_targets')
    .select('platform, revenue_target, units_target')
    .eq('client_id', client.id)
    .eq('target_date', date);

  if (tErr) return res.status(500).json({ error: 'Failed to load targets.' });

  // 2. Load actual revenue for the same date from revenue_data
  const { data: revenueRows, error: rErr } = await supabaseAdmin
    .from('revenue_data')
    .select('platform, standard_revenue, standard_units')
    .eq('client_id', client.id)
    .eq('order_date', date);

  if (rErr) return res.status(500).json({ error: 'Failed to load actuals.' });

  // 3. Aggregate actuals by platform
  const actuals = {};
  for (const row of (revenueRows || [])) {
    const p = row.platform;
    if (!actuals[p]) actuals[p] = { revenue: 0, units: 0 };
    actuals[p].revenue += Number(row.standard_revenue) || 0;
    actuals[p].units   += Number(row.standard_units)   || 0;
  }

  // 4. Build response shape: { targets: { amazon: { target, achieved } } }
  const targets = {};
  for (const row of (targetRows || [])) {
    targets[row.platform] = {
      target:   Number(row.revenue_target),
      achieved: actuals[row.platform]?.revenue || 0,
      units:    actuals[row.platform]?.units   || 0,
    };
  }

  // Fill in platforms that have actuals but no saved target
  for (const [plat, vals] of Object.entries(actuals)) {
    if (!targets[plat]) {
      targets[plat] = { target: 0, achieved: vals.revenue, units: vals.units };
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
