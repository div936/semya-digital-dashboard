// routes/reconciliationRouter.js
// ─────────────────────────────────────────────────────────────────
// A MIGRATION-PARITY TOOL, not a permanent feature — built to help
// verify the new dashboard's data and logic match the old one closely
// enough to retire the old one. Admin-only throughout; lives entirely
// under Settings → Data Migration on the frontend, nowhere else.
//
// BACKGROUND-JOB PATTERN: every check that needs the old dashboard's
// full ledger runs as a background job instead of one blocking
// request-response. THE REASON THIS MATTERS: the old dashboard's
// /data endpoint returns its ENTIRE order history in a single
// response with no pagination at all — for a real, mature dataset
// that can genuinely take longer than any reasonable HTTP timeout,
// including ones we don't fully control (a hosting platform's own
// gateway timeout ceiling, which raising our own app-level timeout
// can't get around). A "POST /start → poll /jobs/:id" pattern
// sidesteps every timeout that matters: the initial POST returns in
// milliseconds regardless of how long the actual work takes, since
// the work happens after the response is already sent.
//
//   POST /clients/:client_slug/reconciliation/missing-rows/start
//     Body: { date? }  — omit for all-history, include for one date.
//   POST /clients/:client_slug/reconciliation/logic-differences/start
//   GET  /clients/:client_slug/reconciliation/jobs/:jobId
//     Poll this until status is 'done' or 'error'.
//
//   POST /clients/:client_slug/reconciliation/import
//     Body: { rows: [...] }  — an admin-reviewed subset of rows from
//     a completed job's result. Imports them using the exact same
//     de-dup mechanism (row_hash) that protects normal file uploads
//     from double-counting. Fast enough to stay a normal request —
//     the slow part was ever fetching the old dashboard, not this.
//
// THE OLD DASHBOARD'S API IS PUBLIC — no auth on any route, confirmed
// from its own source and from the live site loading with no login
// wall. That's what makes a direct server-to-server pull possible at
// all; if that ever changes, these routes need credentials added.
// ─────────────────────────────────────────────────────────────────
import { Router } from 'express';
import crypto from 'crypto';
import { rbacMiddleware } from '../middleware/rbac.js';
import { supabaseAdmin }  from '../lib/supabase.js';
import { todayIST } from '../lib/dateUtils.js';
import { computeRevenueDedupKey } from '../ingestion/fileIngestion.js';

const router = Router({ mergeParams: true });

const OLD_DASHBOARD_BASE = 'https://neat-everyday-performance-kd2j.onrender.com';

// ── In-memory job store ─────────────────────────────────────────
// Deliberately not persisted anywhere — this is an on-demand admin
// tool, not something that needs to survive a server restart. Each
// job is small (a status string + eventual result/error) and short-
// lived; old entries are swept out after an hour so this can't slowly
// leak memory across a long-running server process.
const jobs = new Map(); // jobId -> { status: 'running'|'done'|'error', result?, error?, startedAt }

function startJob(workFn) {
  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: 'running', startedAt: Date.now() });
  workFn()
    .then(result => jobs.set(jobId, { status: 'done', result, startedAt: jobs.get(jobId)?.startedAt }))
    .catch(err => jobs.set(jobId, { status: 'error', error: err.message, startedAt: jobs.get(jobId)?.startedAt }));
  return jobId;
}

setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of jobs.entries()) {
    if (job.startedAt < cutoff) jobs.delete(id);
  }
}, 10 * 60 * 1000).unref();

// ── Old-ledger cache ────────────────────────────────────────────
// The three checks (missing-rows for a date, missing-rows for all
// history, logic-differences) all need the SAME full pull from the
// old dashboard. Running more than one of them back to back
// shouldn't mean re-fetching that entire payload each time — cached
// for 5 minutes, long enough to cover "check all history, then check
// logic differences right after" without serving badly stale data on
// an admin tool that's used occasionally, not continuously.
let _oldLedgerCache = null;
let _oldLedgerCacheAt = 0;
const OLD_LEDGER_CACHE_MS = 5 * 60 * 1000;

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
  if (_oldLedgerCache && (Date.now() - _oldLedgerCacheAt) < OLD_LEDGER_CACHE_MS) {
    return _oldLedgerCache;
  }
  // 3 minutes is generous on purpose — this now runs inside a
  // background job (see startJob above), not inside the lifetime of
  // an HTTP request, so there's no risk of a client or gateway
  // timeout cutting it off early. The old dashboard cold-starting
  // (Render free tier, same as this app) plus a genuinely large
  // payload can legitimately take a while; better to actually wait
  // for it once than fail and have to retry.
  const res = await fetch(`${OLD_DASHBOARD_BASE}/data`, { signal: AbortSignal.timeout(3 * 60 * 1000) });
  if (!res.ok) throw new Error(`Old dashboard responded ${res.status}`);
  const data = await res.json();
  _oldLedgerCache = data;
  _oldLedgerCacheAt = Date.now();
  return data;
}

// ═══════════════════════════════════════════════════════════════════
// Missing-orders check — the actual work, run inside a background job.
// date === null means "all history"; otherwise scoped to one date.
// ═══════════════════════════════════════════════════════════════════
async function runMissingRowsCheck(clientId, date) {
  let newQuery = supabaseAdmin.from('revenue_data').select('standard_order_id, standard_sku').eq('client_id', clientId);
  if (date) newQuery = newQuery.eq('order_date', date);
  const { data: newRows, error: newErr } = await newQuery;
  if (newErr) throw new Error('Failed to load this system\'s rows: ' + newErr.message);

  const newKeys = new Set((newRows || []).filter(r => r.standard_order_id && r.standard_sku).map(r => r.standard_order_id + '||' + r.standard_sku));

  const allOldRows = await fetchOldLedger();
  const oldRows = date ? allOldRows.filter(r => r.date === date) : allOldRows;
  const { missing, unmatched, missingRevenue } = diffAgainstKeys(oldRows, newKeys);

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

  return {
    date: date || null,
    oldTotalRowsForDate: oldRows.length,
    newTotalRowsForDate: newRows?.length || 0,
    missingCount: missing.length,
    missingRevenueTotal: round2(missingRevenue),
    byDate: date ? undefined : byDate, // only meaningful for the all-history view
    missingRows: missing.map(annotateRow),
    unmatchedRows: unmatched,
  };
}

// POST /:client_slug/reconciliation/missing-rows/start
// Body: { date? }  — omit for all-history.
router.post('/:client_slug/reconciliation/missing-rows/start', rbacMiddleware, (req, res) => {
  if (!req.semya.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  const { client } = req.semya;
  const date = req.body?.date || null;
  const jobId = startJob(() => runMissingRowsCheck(client.id, date));
  return res.json({ jobId });
});

// ═══════════════════════════════════════════════════════════════════
// Logic-differences check — the actual work, run inside a background job.
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
async function runLogicDifferencesCheck(clientId) {
  const { data: newRows, error: newErr } = await supabaseAdmin
    .from('revenue_data').select('standard_order_id, standard_sku, standard_revenue, order_date')
    .eq('client_id', clientId);
  if (newErr) throw new Error('Failed to load this system\'s rows: ' + newErr.message);

  const oldRows = await fetchOldLedger();

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
  return { differenceCount: differences.length, differences };
}

// POST /:client_slug/reconciliation/logic-differences/start
router.post('/:client_slug/reconciliation/logic-differences/start', rbacMiddleware, (req, res) => {
  if (!req.semya.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  const { client } = req.semya;
  const jobId = startJob(() => runLogicDifferencesCheck(client.id));
  return res.json({ jobId });
});

// GET /:client_slug/reconciliation/jobs/:jobId — poll until done/error
router.get('/:client_slug/reconciliation/jobs/:jobId', rbacMiddleware, (req, res) => {
  if (!req.semya.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown job — it may have expired (jobs are kept for 1 hour) or the server restarted since it was started.' });
  if (job.status === 'error') {
    const isTimeout = /timeout|aborted/i.test(job.error || '');
    const msg = isTimeout
      ? 'Old dashboard did not respond in time (it may be cold-starting on Render\'s free tier — try again in a moment).'
      : 'Failed to reach old dashboard: ' + job.error;
    return res.json({ status: 'error', error: msg });
  }
  return res.json({ status: job.status, result: job.result });
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
//
// HARD LIMIT of 300 rows per request, enforced here rather than left
// to whoever calls this: a real dataset can easily have thousands of
// missing rows (9,000+ seen in practice), and processing them one
// database write at a time in a single HTTP request WILL time out —
// the browser, Render's own request timeout, or both — long before
// it finishes, no matter how patient anyone is. The frontend chunks
// large imports into multiple requests against this same endpoint;
// this limit is what makes that the only viable way to call it,
// rather than a suggestion that's easy to accidentally bypass.
// ═══════════════════════════════════════════════════════════════════
const IMPORT_BATCH_LIMIT = 300;
const IMPORT_CONCURRENCY = 10; // parallel upserts within one request — mirrors bulkInsert()'s own pattern in fileIngestion.js

router.post('/:client_slug/reconciliation/import', rbacMiddleware, async (req, res) => {
  if (!req.semya.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  const { client } = req.semya;
  const { rows } = req.body || {};
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows must be a non-empty array.' });
  if (rows.length > IMPORT_BATCH_LIMIT) {
    return res.status(400).json({ error: `Send at most ${IMPORT_BATCH_LIMIT} rows per request — got ${rows.length}. The frontend should split a large import into multiple requests of this size.` });
  }

  // BUG FIX — real duplication was confirmed in production: normal
  // Amazon/Acutas file uploads frequently have NO usable
  // standard_order_id at all (they de-dup on order_item_id, or fall
  // to the composite tier when even that's missing) — but every
  // imported row DOES have an order_id, since that's the only ID the
  // old dashboard's API provides. Two rows for the exact same real
  // sale therefore hash completely differently under row_hash and
  // never collide, no matter how correct the upsert itself is. Row-ID
  // matching simply isn't a reliable join key for this specific case.
  //
  // Fix: before importing, check for an already-existing row by a
  // CONTENT fingerprint instead — same SKU, same date, same revenue,
  // same units — which doesn't depend on either side having a usable
  // order ID. Fetched once per request for every (sku, date) pair in
  // this batch, not per-row, to avoid hundreds of round trips.
  const skus  = [...new Set(rows.map(r => r.sku).filter(Boolean))];
  const dates = [...new Set(rows.map(r => r.date).filter(Boolean))];
  const { data: existingRows, error: existingErr } = await supabaseAdmin
    .from('revenue_data')
    .select('standard_sku, order_date, standard_revenue, standard_units')
    .eq('client_id', client.id)
    .in('standard_sku', skus)
    .in('order_date', dates);
  if (existingErr) return res.status(500).json({ error: 'Failed to check for existing rows before import: ' + existingErr.message });

  const existingFingerprints = new Set(
    (existingRows || []).map(r => fingerprint(r.standard_sku, r.order_date, r.standard_revenue, r.standard_units))
  );

  // Note: with ignoreDuplicates:true, Supabase silently no-ops on an
  // existing row_hash rather than erroring — so "imported" below means
  // "processed without error," which includes rows that turned out to
  // already exist (e.g. from a prior import run or a file upload that
  // landed after this list was generated). That's the correct,
  // safe behavior — it just means this count isn't a precise "brand
  // new rows added" figure, only a "no failures" one.
  let imported = 0, failed = 0, skippedAsExisting = 0;
  const failures = [];

  const processOne = async (oldRow) => {
    try {
      // Content-fingerprint match against something already here —
      // even though it has no comparable order_id, this is almost
      // certainly the same real sale under a different upload path.
      // Skip it rather than let row_hash's blind spot duplicate it.
      const fp = fingerprint(oldRow.sku, oldRow.date, Number(oldRow.revenue) || 0, Number(oldRow.qty) || 0);
      if (existingFingerprints.has(fp)) { skippedAsExisting++; return; }

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
  };

  // Concurrent batches rather than one row at a time — this is what
  // actually makes a 300-row request finish in a few seconds instead
  // of 300x a single round-trip's latency.
  for (let i = 0; i < rows.length; i += IMPORT_CONCURRENCY) {
    const batch = rows.slice(i, i + IMPORT_CONCURRENCY);
    await Promise.all(batch.map(processOne));
  }

  return res.json({ ok: true, requested: rows.length, imported, skippedAsExisting, failed, failures: failures.slice(0, 20) });
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

// Content fingerprint for detecting "this is probably the same real
// sale" independent of order ID — see the long comment on the import
// route for why order ID alone can't be trusted as a join key here.
// Revenue is fixed to 2 decimals so ₹597 and ₹597.00 fingerprint
// identically regardless of which side sent which representation.
function fingerprint(sku, date, revenue, units) {
  return [sku || '', date || '', Number(revenue || 0).toFixed(2), Number(units || 0)].join('||');
}

export default router;
