// routes/flipkartSyncRouter.js
// ─────────────────────────────────────────────────────────────────
// Admin endpoints for Flipkart sync — manual trigger + status.
// Mounted at: app.use('/flipkart', flipkartSyncRouter)
// Mirrors shopifySyncRouter.js exactly.
// ─────────────────────────────────────────────────────────────────
import { Router }    from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { runFlipkartOrderSync, runFlipkartReturnSync } from '../services/flipkartScheduler.js';

const router = Router();

// POST /flipkart/sync — admin only, triggers a full background sync
router.post('/sync', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorised' });

  res.json({ ok: true, message: 'Flipkart sync started in background' });

  runFlipkartOrderSync()
    .then(() => runFlipkartReturnSync())
    .catch(e => console.error('[fk-manual-sync]', e.message));
});

// GET /flipkart/sync-status — last 10 Flipkart sync log entries
router.get('/sync-status', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('sync_log')
    .select('sync_type, synced_at, status, rows_synced, error_msg')
    .in('sync_type', ['flipkart_orders', 'flipkart_returns'])
    .order('synced_at', { ascending: false })
    .limit(10);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ log: data || [] });
});

export default router;
