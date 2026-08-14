// routes/dataManagerRouter.js
// ─────────────────────────────────────────────────────────────────
// Admin-only data management endpoints.
// Mounted in app.js as: app.use('/clients', dataManagerRouter)
//
//   GET    /clients/:slug/uploads              → list all upload batches
//   DELETE /clients/:slug/uploads/:uploadId    → delete one upload + its rows
//   DELETE /clients/:slug/data/range           → delete rows in a date range
//   DELETE /clients/:slug/data/platform        → delete ALL rows for a platform
//   GET    /clients/:slug/data/summary         → row counts per platform
// ─────────────────────────────────────────────────────────────────
import { Router } from 'express';
import { rbacMiddleware } from '../middleware/rbac.js';
import { supabaseAdmin }  from '../lib/supabase.js';

const router = Router({ mergeParams: true });

// Admin gate middleware
function adminOnly(req, res, next) {
  if (!req.semya?.isAdmin) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  return next();
}

// ─── GET /clients/:client_slug/uploads ───────────────────────────
router.get('/:client_slug/uploads', rbacMiddleware, adminOnly, async (req, res) => {
  const { client } = req.semya;
  const { data, error } = await supabaseAdmin
    .from('uploads')
    .select('id, detected_platform, detected_data_type, status, row_count, skipped_rows, error_message, created_at, original_name')
    .eq('client_id', client.id)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) return res.status(500).json({ error: 'Failed to fetch upload history.' });

  // Map DB column names to the field names the frontend expects
  const uploads = (data || []).map(u => ({
    id: u.id,
    platform: u.detected_platform,
    data_type: u.detected_data_type,
    status: u.status,
    row_count: u.row_count,
    skipped_rows: u.skipped_rows,
    error_message: u.error_message,
    created_at: u.created_at,
    original_filename: u.original_name,
  }));

  return res.json({ uploads });
});

// ─── GET /clients/:client_slug/data/summary ──────────────────────
// Row counts per platform, for the "Clear by Platform" admin panel.
//
// IMPORTANT: this used to be a single unpaginated .select('platform')
// per table. Supabase/PostgREST caps any query at 1000 rows by
// default — with revenue_data alone regularly holding 1000+ rows for
// an active client, only whichever platforms happened to fall within
// the first 1000 rows (in whatever order the DB returned them) ever
// showed up here. Any platform whose rows all landed past that cutoff
// silently vanished from the list entirely — not deleted, not
// missing data, just invisible in this one screen. Paginating through
// every row (same fix already applied to platform-sales/campaign-
// insights/etc.) makes the count — and which platforms appear at
// all — actually reflect everything in the database.
async function countPlatforms(table, clientId) {
  const counts = {};
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select('platform')
      .eq('client_id', clientId)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const row of data) counts[row.platform] = (counts[row.platform] || 0) + 1;
    if (data.length < pageSize) break; // last page
    from += pageSize;
  }
  return counts;
}

router.get('/:client_slug/data/summary', rbacMiddleware, adminOnly, async (req, res) => {
  const { client } = req.semya;

  let revCounts, campCounts;
  try {
    [revCounts, campCounts] = await Promise.all([
      countPlatforms('revenue_data',  client.id),
      countPlatforms('campaign_data', client.id),
    ]);
  } catch (e) {
    return res.status(500).json({ error: 'Failed to fetch data summary: ' + e.message });
  }

  const summary = {};
  for (const [platform, count] of Object.entries(revCounts))  { (summary[platform] ||= { revenue: 0, campaign: 0 }).revenue  = count; }
  for (const [platform, count] of Object.entries(campCounts)) { (summary[platform] ||= { revenue: 0, campaign: 0 }).campaign = count; }

  return res.json({ summary });
});

// ─── DELETE /clients/:client_slug/uploads/:uploadId ──────────────
router.delete('/:client_slug/uploads/:uploadId', rbacMiddleware, adminOnly, async (req, res) => {
  const { client } = req.semya;
  const { uploadId } = req.params;

  const { data: upload, error: fetchErr } = await supabaseAdmin
    .from('uploads')
    .select('id, detected_platform, detected_data_type, row_count')
    .eq('id', uploadId)
    .eq('client_id', client.id)
    .single();

  if (fetchErr || !upload) return res.status(404).json({ error: 'Upload not found.' });

  const table = upload.detected_data_type === 'revenue' ? 'revenue_data' : 'campaign_data';

  const { error: rowErr } = await supabaseAdmin
    .from(table).delete().eq('upload_id', uploadId).eq('client_id', client.id);
  if (rowErr) return res.status(500).json({ error: 'Failed to delete data rows: ' + rowErr.message });

  const { error: upErr } = await supabaseAdmin
    .from('uploads').delete().eq('id', uploadId).eq('client_id', client.id);
  if (upErr) return res.status(500).json({ error: 'Failed to delete upload record: ' + upErr.message });

  return res.json({ ok: true, deletedUploadId: uploadId, rowsDeleted: upload.row_count });
});

// ─── DELETE /clients/:client_slug/data/range ─────────────────────
router.delete('/:client_slug/data/range', rbacMiddleware, adminOnly, async (req, res) => {
  const { client } = req.semya;
  const { from, to, platform, dataType = 'all' } = req.body;

  if (!from || !to) return res.status(400).json({ error: 'from and to dates are required.' });

  let totalDeleted = 0;
  const errors = [];

  async function deleteFromTable(table, dateField) {
    let q = supabaseAdmin.from(table).delete().eq('client_id', client.id).gte(dateField, from).lte(dateField, to);
    if (platform) q = q.eq('platform', platform.toLowerCase());
    const { error, count } = await q;
    if (error) errors.push(table + ': ' + error.message);
    else totalDeleted += count || 0;
  }

  if (dataType === 'all' || dataType === 'revenue')  await deleteFromTable('revenue_data',  'order_date');
  if (dataType === 'all' || dataType === 'campaign') await deleteFromTable('campaign_data', 'campaign_date');

  if (errors.length) return res.status(500).json({ error: errors.join('; ') });
  return res.json({ ok: true, rowsDeleted: totalDeleted, from, to, platform: platform || 'all' });
});

// ─── DELETE /clients/:client_slug/data/platform ──────────────────
router.delete('/:client_slug/data/platform', rbacMiddleware, adminOnly, async (req, res) => {
  const { client } = req.semya;
  const { platform, dataType = 'all' } = req.body;

  if (!platform) return res.status(400).json({ error: 'platform is required.' });

  let totalDeleted = 0;
  const errors = [];

  async function deleteFromTable(table) {
    let q = supabaseAdmin.from(table).delete().eq('client_id', client.id);
    if (platform !== 'all') q = q.eq('platform', platform.toLowerCase());
    const { error, count } = await q;
    if (error) errors.push(table + ': ' + error.message);
    else totalDeleted += count || 0;
  }

  if (dataType === 'all' || dataType === 'revenue')  await deleteFromTable('revenue_data');
  if (dataType === 'all' || dataType === 'campaign') await deleteFromTable('campaign_data');

  if (errors.length) return res.status(500).json({ error: errors.join('; ') });
  return res.json({ ok: true, rowsDeleted: totalDeleted, platform });
});

export default router;
