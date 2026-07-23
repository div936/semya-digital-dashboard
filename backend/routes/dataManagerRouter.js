// routes/dataManagerRouter.js
// ─────────────────────────────────────────────────────────────────
// Admin-only data management endpoints:
//   GET    /clients/:slug/uploads              → list all upload batches
//   DELETE /clients/:slug/uploads/:uploadId    → delete one upload batch + its rows
//   DELETE /clients/:slug/data/range           → delete rows in a date range (optional platform)
//   DELETE /clients/:slug/data/platform        → delete ALL rows for a platform
//   GET    /clients/:slug/data/summary         → row counts per platform for confirmation UI
// ─────────────────────────────────────────────────────────────────
import { Router } from 'express';
import { rbacMiddleware } from '../middleware/rbac.js';
import { supabaseAdmin }  from '../lib/supabase.js';

const router = Router({ mergeParams: true });
router.use('/:client_slug', rbacMiddleware);

// Admin gate — applies to every route in this file
function adminOnly(req, res, next) {
  if (!req.semya?.isAdmin) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  return next();
}

// ─────────────────────────────────────────────────────────────────
// GET /clients/:slug/uploads
// Returns all upload batches for this client, newest first
// ─────────────────────────────────────────────────────────────────
router.get('/:client_slug/uploads', adminOnly, async (req, res) => {
  const { client } = req.semya;

  const { data, error } = await supabaseAdmin
    .from('uploads')
    .select('id, platform, data_type, status, row_count, skipped_rows, error_message, created_at, original_filename')
    .eq('client_id', client.id)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) return res.status(500).json({ error: 'Failed to fetch upload history.' });
  return res.json({ uploads: data });
});

// ─────────────────────────────────────────────────────────────────
// GET /clients/:slug/data/summary
// Row counts per platform so the UI can show "you are about to
// delete N rows" before the user confirms
// ─────────────────────────────────────────────────────────────────
router.get('/:client_slug/data/summary', adminOnly, async (req, res) => {
  const { client } = req.semya;

  const [{ data: rev }, { data: camp }] = await Promise.all([
    supabaseAdmin
      .from('revenue_data')
      .select('platform, id')
      .eq('client_id', client.id),
    supabaseAdmin
      .from('campaign_data')
      .select('platform, id')
      .eq('client_id', client.id),
  ]);

  const summary = {};
  (rev || []).forEach(r => {
    if (!summary[r.platform]) summary[r.platform] = { revenue: 0, campaign: 0 };
    summary[r.platform].revenue++;
  });
  (camp || []).forEach(c => {
    if (!summary[c.platform]) summary[c.platform] = { revenue: 0, campaign: 0 };
    summary[c.platform].campaign++;
  });

  return res.json({ summary });
});

// ─────────────────────────────────────────────────────────────────
// DELETE /clients/:slug/uploads/:uploadId
// Deletes one upload batch and all rows that belong to it
// ─────────────────────────────────────────────────────────────────
router.delete('/:client_slug/uploads/:uploadId', adminOnly, async (req, res) => {
  const { client } = req.semya;
  const { uploadId } = req.params;

  // Verify the upload belongs to this client
  const { data: upload, error: fetchErr } = await supabaseAdmin
    .from('uploads')
    .select('id, platform, data_type, row_count')
    .eq('id', uploadId)
    .eq('client_id', client.id)
    .single();

  if (fetchErr || !upload) {
    return res.status(404).json({ error: 'Upload not found.' });
  }

  const table = upload.data_type === 'revenue' ? 'revenue_data' : 'campaign_data';

  // Delete data rows first, then the upload record
  const { error: rowErr } = await supabaseAdmin
    .from(table)
    .delete()
    .eq('upload_id', uploadId)
    .eq('client_id', client.id);

  if (rowErr) return res.status(500).json({ error: 'Failed to delete data rows: ' + rowErr.message });

  const { error: upErr } = await supabaseAdmin
    .from('uploads')
    .delete()
    .eq('id', uploadId)
    .eq('client_id', client.id);

  if (upErr) return res.status(500).json({ error: 'Failed to delete upload record: ' + upErr.message });

  return res.json({ ok: true, deletedUploadId: uploadId, rowsDeleted: upload.row_count });
});

// ─────────────────────────────────────────────────────────────────
// DELETE /clients/:slug/data/range
// Body: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', platform?: string, dataType?: 'revenue'|'campaign'|'all' }
// Deletes rows within a date range, optionally filtered by platform
// ─────────────────────────────────────────────────────────────────
router.delete('/:client_slug/data/range', adminOnly, async (req, res) => {
  const { client } = req.semya;
  const { from, to, platform, dataType = 'all' } = req.body;

  if (!from || !to) {
    return res.status(400).json({ error: 'from and to dates are required.' });
  }

  let totalDeleted = 0;
  const errors = [];

  async function deleteFromTable(table, dateField) {
    let q = supabaseAdmin.from(table).delete().eq('client_id', client.id);
    q = q.gte(dateField, from).lte(dateField, to);
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

// ─────────────────────────────────────────────────────────────────
// DELETE /clients/:slug/data/platform
// Body: { platform: string, dataType?: 'revenue'|'campaign'|'all' }
// Deletes ALL data for a specific platform (or all platforms if platform='all')
// ─────────────────────────────────────────────────────────────────
router.delete('/:client_slug/data/platform', adminOnly, async (req, res) => {
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
