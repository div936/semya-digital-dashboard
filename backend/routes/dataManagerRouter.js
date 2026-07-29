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
    .select('id, detected_platform, detected_data_type, status, row_count, skipped_rows, rows_updated, rows_duplicate_in_file, error_message, created_at, original_name')
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
    rows_updated: u.rows_updated || 0,
    rows_duplicate_in_file: u.rows_duplicate_in_file || 0,
    error_message: u.error_message,
    created_at: u.created_at,
    original_filename: u.original_name,
  }));

  return res.json({ uploads });
});

// ─── GET /clients/:client_slug/data/summary ──────────────────────
router.get('/:client_slug/data/summary', rbacMiddleware, adminOnly, async (req, res) => {
  const { client } = req.semya;

  const [{ data: rev, error: e1 }, { data: camp, error: e2 }, { data: uploads, error: e3 }] = await Promise.all([
    supabaseAdmin.from('revenue_data').select('platform').eq('client_id', client.id),
    supabaseAdmin.from('campaign_data').select('platform').eq('client_id', client.id),
    supabaseAdmin.from('uploads').select('detected_platform').eq('client_id', client.id),
  ]);

  if (e1 || e2 || e3) return res.status(500).json({ error: 'Failed to fetch data summary.' });

  const summary = {};
  (rev  || []).forEach(r => { if (!summary[r.platform]) summary[r.platform] = { revenue: 0, campaign: 0 }; summary[r.platform].revenue++; });
  (camp || []).forEach(c => { if (!summary[c.platform]) summary[c.platform] = { revenue: 0, campaign: 0 }; summary[c.platform].campaign++; });
  // Also surface platforms that have Upload History records but zero
  // current data rows (e.g. the data was already cleared but old
  // upload entries are still lingering) — otherwise there's no way to
  // reach those stale records from this screen at all.
  (uploads || []).forEach(u => { if (u.detected_platform && !summary[u.detected_platform]) summary[u.detected_platform] = { revenue: 0, campaign: 0 }; });

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

  // Also clear the matching Upload History records — this is an
  // all-or-nothing wipe for this platform (unlike a date-range
  // delete, which can remove only part of an upload's rows), so
  // every upload event for it is now stale and should disappear
  // along with the data, not linger showing row counts that no
  // longer exist anywhere.
  let uploadsQuery = supabaseAdmin.from('uploads').delete().eq('client_id', client.id);
  if (platform !== 'all') uploadsQuery = uploadsQuery.eq('detected_platform', platform.toLowerCase());
  if (dataType !== 'all') uploadsQuery = uploadsQuery.eq('detected_data_type', dataType);
  const { error: uploadsErr } = await uploadsQuery;
  if (uploadsErr) errors.push('uploads: ' + uploadsErr.message);

  if (errors.length) return res.status(500).json({ error: errors.join('; ') });
  return res.json({ ok: true, rowsDeleted: totalDeleted, platform });
});

export default router;
