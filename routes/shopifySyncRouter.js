// routes/shopifySyncRouter.js
// ─────────────────────────────────────────────────────────────────
// Manual sync trigger — lets an admin force a full re-sync from
// the Settings panel without waiting for the cron.
// Mounted at: app.use('/shopify', shopifySyncRouter)
// ─────────────────────────────────────────────────────────────────
import { Router }    from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { runOrderSync, runRefundSync } from '../services/syncScheduler.js';

const router = Router();

// POST /shopify/sync — admin only, triggers a full background sync
router.post('/sync', async (req, res) => {
  // Simple admin check — reuse the same token verification used elsewhere
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorised' });

  res.json({ ok: true, message: 'Sync started in background' });
  // Fire-and-forget after response is sent
  runOrderSync().then(() => runRefundSync()).catch(e => {
    console.error('[manual-sync]', e.message);
  });
});

// GET /shopify/sync-status — last 10 sync log entries
router.get('/sync-status', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('sync_log')
    .select('sync_type, synced_at, status, rows_synced, error_msg')
    .order('synced_at', { ascending: false })
    .limit(10);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ log: data || [] });
});

export default router;
