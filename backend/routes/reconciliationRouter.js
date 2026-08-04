// routes/reconciliationRouter.js
// ─────────────────────────────────────────────────────────────────
// A MIGRATION-PARITY TOOL, not a permanent feature — built to help
// verify the new dashboard's data and logic match the old one closely
// enough to retire the old one. Admin-only throughout; lives entirely
// under Settings → Data Migration on the frontend, nowhere else.
//
//   GET  /clients/:client_slug/reconciliation/missing-rows?date=X
//     Row-level diff for one specific date.
//
//   GET  /clients/:client_slug/reconciliation/missing-rows/all
//     Same diff across the old dashboard's ENTIRE order history in
//     one pass, grouped by date.
//
//   GET  /clients/:client_slug/reconciliation/logic-differences
//     A DIFFERENT check: dates where the same orders exist in both
//     systems (no rows missing) but the computed revenue disagrees —
//     signals a calculation bug, not a data gap.
//
//   POST /clients/:client_slug/reconciliation/import
//     Body: { rows: [...] }  — an admin-reviewed subset of rows
//     returned by one of the GETs above. Imports them using the exact
//     same de-dup mechanism (row_hash) that protects normal file
//     uploads from double-counting.
//
// THE OLD DASHBOARD'S API IS PUBLIC — no auth on any route, confirmed
// from its own source and from the live site loading with no login
// wall. That's what makes a direct server-to-server pull possible at
// all; if that ever changes, these routes need credentials added.
// ─────────────────────────────────────────────────────────────────
import { Router } from 'express';
import { rbacMiddleware } from '../middleware/rbac.js';
import { supabaseAdmin }  from '../lib/supabase.js';
import { todayIST } from '../lib/dateUtils.js';
import { computeRevenueDedupKey } from '../ingestion/fileIngestion.js';

const router = Router({ mergeParams: true });

const OLD_DASHBOARD_BASE = 'https://neat-everyday-performance-kd2j.onrender.com';

// ═══════════════════════════════════════════════════════════════════
// PLATFORM MAPPING — ported directly from the old dashboard's own
// achieved-revenue query logic (get_targets_summary in its main.py):
// Amazon-family rows are tagged 'amazon' or 'merchant' in the
// `platform` column, with source_tag distinguishing which real
// business the sale belongs to — literally the string "Amazon" for
// Neat's own account, "Acutas" for the other one (that's the old
// system's own naming, not a typo: their source_tag value for the
// Neat/main account is "Amazon"). Website/Shopify rows are always
// platform='Website', with source_tag carrying Meta vs Google —
// defaulting to Meta when untagged, matching the old system's own
// stated default for that file type.
// ═══════════════════════════════════════════════════════════════════
function mapOldRowToPlatform(row) {
  const platform = (row.platform || '').toLowerCase();
  const tag = row.source_tag || '';

  if (platform === 'amazon' || platform === 'merchant') {
    if (tag === 'Amazon') return { platform: 'amazon', confident: true };
    if (tag === 'Acutas') return { platform: 'acutas', confident: true };
    return { platform: 'amazon', confident: false }; // untagged — default to Neat, flagged uncertain
  }
  if (platform === 'flipkart') return { platform: 'flipkart', confident: true };
  if (platform === 'blinkit')  return { platform: 'blinkit',  confident: true };
  if (platform === 'website') {
    if (tag === 'Google') return { platform: 'google', confident: true };
    return { platform: 'meta', confident: tag === 'Meta' }; // untagged defaults to Meta, same as the old system itself
  }
  return { platform, confident: false };
}

async function fetchOldLedger() {
  const res = await fetch(`${OLD_DASHBOARD_BASE}/data`, { signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error(`Old dashboard responded ${res.status}`);
  return res.json();
}

function oldDashboardErrorMessage(e) {
  return e.name === 'TimeoutError'
    ? 'Old dashboard did not respond in time (it may be cold-starting on Render\'s free tier — try again in a moment).'
    : 'Failed to reach old dashboard: ' + e.message;
}

// ═══════════════════════════════════════════════════════════════════
// GET /:client_slug/reconciliation/missing-rows?date=X — one date
// ═══════════════════════════════════════════════════════════════════
router.get('/:client_slug/reconciliation/missing-rows', rbacMiddleware, async (req, res) => {
  if (!req.semya.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  const { client } = req.semya;
  const date = req.query.date || todayIST();

  const { data: newRows, error: newErr } = await supabaseAdmin
    .from('revenue_data').select('standard_order_id, standard_sku')
    .eq('client_id', client.id).eq('order_date', date);
  if (newErr) return res.status(500).json({ error: 'Failed to load this system\'s rows: ' + newErr.message });

  const newKeys = new Set((newRows || []).filter(r => r.standard_order_id && r.standard_sku).map(r => r.standard_order_id + '||' + r.standard_sku));

  let oldRows;
  try { oldRows = await fetchOldLedger(); }
  catch (e) { return res.status(502).json({ error: oldDashboardErrorMessage(e) }); }

  const forDate = oldRows.filter(r => r.date === date);
  const { missing, unmatched, missingRevenue } = diffAgainstKeys(forDate, newKeys);

  return res.json({
    date,
    oldTotalRowsForDate: forDate.length,
    newTotalRowsForDate: newRows?.length || 0,
    missingCount: missing.length,
    missingRevenueTotal: round2(missingRevenue),
    missingRows: missing.map(annotateRow),
    unmatchedRows: unmatched,
  });
});

// ═══════════════════════════════════════════════════════════════════
// GET /:client_slug/reconciliation/missing-rows/all — every date
// ═══════════════════════════════════════════════════════════════════
router.get('/:client_slug/reconciliation/missing-rows/all', rbacMiddleware, async (req, res) => {
  if (!req.semya.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  const { client } = req.semya;

  const { data: newRows, error: newErr } = await supabaseAdmin
    .from('revenue_data').select('standard_order_id, standard_sku')
    .eq('client_id', client.id);
  if (newErr) return res.status(500).json({ error: 'Failed to load this system\'s rows: ' + newErr.message });

  const newKeys = new Set((newRows || []).filter(r => r.standard_order_id && r.standard_sku).map(r => r.standard_order_id + '||' + r.standard_sku));

  let oldRows;
  try { oldRows = await fetchOldLedger(); }
  catch (e) { return res.status(502).json({ error: oldDashboardErrorMessage(e) }); }

  const { missing, unmatched, missingRevenue } = diffAgainstKeys(oldRows, newKeys);

  // Group missing rows by date for a scannable summary — the full
  // list (potentially thousands of rows across a mature ledger) is
  // still returned too, for the detail view / selecting rows to import.
  const byDateMap = new Map();
  for (const row of missing) {
    const d = row.date;
    if (!byDateMap.has(d)) byDateMap.set(d, { date: d, count: 0, revenue: 0 });
    const bucket = byDateMap.get(d);
    bucket.count++;
    bucket.revenue += Number(row.revenue) || 0;
  }
  const byDate = Array.from(byDateMap.values())
    .map(b => ({ ...b, revenue: round2(b.revenue) }))
    .sort((a, b) => b.date.localeCompare(a.date));

  return res.json({
    oldTotalRows: oldRows.length,
    newTotalRows: newRows?.length || 0,
    missingCount: missing.length,
    missingRevenueTotal: round2(missingRevenue),
    byDate,
    missingRows: missing.map(annotateRow),
    unmatchedRows: unmatched,
  });
});

// ═══════════════════════════════════════════════════════════════════
// GET /:client_slug/reconciliation/logic-differences
//
// A different question from "what's missing": for dates where BOTH
// systems have the exact same set of orders (verified by matching
// (order_id, sku) keys with zero missing on either side for that
// date), does the computed revenue still disagree? If so, that's a
// calculation bug somewhere — not a data gap — the same category of
// issue as the Google Ads rollup-row and Meta discount-allocation
// bugs found earlier. Small differences (under ₹5 for the whole day)
// are treated as rounding noise, not flagged.
// ═══════════════════════════════════════════════════════════════════
router.get('/:client_slug/reconciliation/logic-differences', rbacMiddleware, async (req, res) => {
  if (!req.semya.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  const { client } = req.semya;

  const { data: newRows, error: newErr } = await supabaseAdmin
    .from('revenue_data').select('standard_order_id, standard_sku, standard_revenue, order_date')
    .eq('client_id', client.id);
  if (newErr) return res.status(500).json({ error: 'Failed to load this system\'s rows: ' + newErr.message });

  let oldRows;
  try { oldRows = await fetchOldLedger(); }
  catch (e) { return res.status(502).json({ error: oldDashboardErrorMessage(e) }); }

  const newByDate = new Map();
  for (const row of (newRows || [])) {
    if (!row.order_date) continue;
    if (!newByDate.has(row.order_date)) newByDate.set(row.order_date, []);
    newByDate.get(row.order_date).push(row);
  }
  const oldByDate = new Map();
  for (const row of oldRows) {
    if (!row.date) continue;
    if (!oldByDate.has(row.date)) oldByDate.set(row.date, []);
    oldByDate.get(row.date).push(row);
  }

  const differences = [];
  for (const [date, oldDateRows] of oldByDate.entries()) {
    const newDateRows = newByDate.get(date) || [];
    const newKeys = new Set(newDateRows.filter(r => r.standard_order_id && r.standard_sku).map(r => r.standard_order_id + '||' + r.standard_sku));
    const oldKeyed = oldDateRows.filter(r => r.order_id && r.sku);

    // Only a meaningful comparison when every old-side row for this
    // date also exists on the new side — otherwise a revenue
    // difference could just be explained by the missing rows
    // themselves, not a genuine calculation bug.
    const allPresent = oldKeyed.length > 0 && oldKeyed.every(r => newKeys.has(r.order_id + '||' + r.sku));
    if (!allPresent) continue;

    const oldRevenue = oldDateRows.reduce((s, r) => s + (Number(r.revenue) || 0), 0);
    const newRevenue = newDateRows.reduce((s, r) => s + (Number(r.standard_revenue) || 0), 0);
    const diff = round2(newRevenue - oldRevenue);

    if (Math.abs(diff) >= 5) {
      differences.push({
        date,
        oldRevenue: round2(oldRevenue),
        newRevenue: round2(newRevenue),
        diff,
        rowCount: oldDateRows.length,
      });
    }
  }

  differences.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  return res.json({ differenceCount: differences.length, differences });
});

// ═══════════════════════════════════════════════════════════════════
// POST /:client_slug/reconciliation/import
// Body: { rows: [ <row objects as returned by the GETs above> ] }
//
// Imports an admin-reviewed subset of missing rows. Each row is
// converted into the same shape a normal file upload would produce,
// hashed with the EXACT SAME computeRevenueDedupKey() used by
// fileIngestion.js, and upserted on (client_id, row_hash) — so an
// imported row that later ALSO arrives through a real file upload
// can never become a duplicate; whichever lands second just updates
// the same row instead of creating a new one.
// ═══════════════════════════════════════════════════════════════════
router.post('/:client_slug/reconciliation/import', rbacMiddleware, async (req, res) => {
  if (!req.semya.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  const { client } = req.semya;
  const { rows } = req.body || {};
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows must be a non-empty array.' });

  // Note: with ignoreDuplicates:true, Supabase silently no-ops on an
  // existing row_hash rather than erroring — so "imported" below means
  // "processed without error," which includes rows that turned out to
  // already exist (e.g. from a prior import run or a file upload that
  // landed after this list was generated). That's the correct,
  // safe behavior — it just means this count isn't a precise "brand
  // new rows added" figure, only a "no failures" one.
  let imported = 0, failed = 0;
  const failures = [];

  for (const oldRow of rows) {
    try {
      const { platform } = mapOldRowToPlatform(oldRow);
      const normalised = {
        client_id:               client.id,
        platform,
        order_date:              oldRow.date,
        standard_sku:            oldRow.sku || null,
        standard_revenue:        Number(oldRow.revenue) || 0,
        standard_units:          Number(oldRow.qty) || 0,
        standard_state:          oldRow.state || null,
        standard_status:         oldRow.status || null,
        standard_order_id:       oldRow.order_id || null,
        standard_product_name:   oldRow.product || null,
        raw_extras:              { imported_from: 'old_dashboard', category: oldRow.category || null },
      };
      const { hash: row_hash, method: dedup_method } = computeRevenueDedupKey(normalised);
      const { error } = await supabaseAdmin
        .from('revenue_data')
        .upsert({ ...normalised, row_hash, dedup_method }, { onConflict: 'client_id,row_hash', ignoreDuplicates: true });

      if (error) { failed++; failures.push({ order_id: oldRow.order_id, sku: oldRow.sku, error: error.message }); }
      else imported++;
    } catch (e) {
      failed++;
      failures.push({ order_id: oldRow.order_id, sku: oldRow.sku, error: e.message });
    }
  }

  return res.json({ ok: true, requested: rows.length, imported, failed, failures: failures.slice(0, 20) });
});

// ═══════════════════════════════════════════════════════════════════
// Shared helpers
// ═══════════════════════════════════════════════════════════════════
function diffAgainstKeys(oldRows, newKeySet) {
  const missing = [];
  const unmatched = [];
  let missingRevenue = 0;
  for (const row of oldRows) {
    if (!row.order_id || !row.sku) { unmatched.push(row); continue; }
    const key = row.order_id + '||' + row.sku;
    if (!newKeySet.has(key)) {
      missing.push(row);
      missingRevenue += Number(row.revenue) || 0;
    }
  }
  return { missing, unmatched, missingRevenue };
}

function annotateRow(row) {
  const { platform, confident } = mapOldRowToPlatform(row);
  return { ...row, mappedPlatform: platform, platformConfident: confident };
}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

export default router;
