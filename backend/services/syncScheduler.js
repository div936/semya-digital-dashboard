// services/syncScheduler.js
// ─────────────────────────────────────────────────────────────────
// Cron scheduler — runs Shopify order + refund sync every 6 hours.
// Call startScheduler() once from app.js after all routes are set up.
// ─────────────────────────────────────────────────────────────────
import { syncShopifyOrders  } from './syncOrders.js';
import { syncShopifyRefunds } from './syncRefunds.js';
import { supabaseAdmin }      from '../lib/supabase.js';

const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;

// Track last successful sync so incremental runs only pull changes
let lastOrderSync  = null;
let lastRefundSync = null;

async function logSync(syncType, status, rowsSynced = 0, errorMsg = null) {
  await supabaseAdmin.from('sync_log').insert({
    client_id: CLIENT_ID, sync_type: syncType,
    synced_at: new Date().toISOString(),
    status, rows_synced: rowsSynced, error_msg: errorMsg,
  }).catch(e => console.warn('[sync-log] failed to write log:', e.message));
}

export async function runOrderSync() {
  console.log('[scheduler] starting order sync...');
  // 5-minute overlap on the timestamp to catch any edge cases
  const since = lastOrderSync
    ? new Date(lastOrderSync - 5 * 60 * 1000).toISOString()
    : null;
  try {
    const { synced } = await syncShopifyOrders(since);
    lastOrderSync = Date.now();
    await logSync('orders', 'success', synced);
  } catch (e) {
    console.error('[scheduler] order sync failed:', e.message);
    await logSync('orders', 'error', 0, e.message);
  }
}

export async function runRefundSync() {
  console.log('[scheduler] starting refund sync...');
  const since = lastRefundSync
    ? new Date(lastRefundSync - 5 * 60 * 1000).toISOString()
    : null;
  try {
    const { synced } = await syncShopifyRefunds(since);
    lastRefundSync = Date.now();
    await logSync('refunds', 'success', synced);
  } catch (e) {
    console.error('[scheduler] refund sync failed:', e.message);
    await logSync('refunds', 'error', 0, e.message);
  }
}

export function startScheduler() {
  // Only start if Shopify env vars are configured
  if (!process.env.SHOPIFY_STORE || !process.env.SHOPIFY_API_TOKEN || !process.env.SHOPIFY_CLIENT_ID) {
    console.log('[scheduler] Shopify env vars not set — auto-sync disabled. Set SHOPIFY_STORE, SHOPIFY_API_TOKEN, SHOPIFY_CLIENT_ID to enable.');
    return;
  }

  // Run once immediately on server start (full historical sync first time,
  // incremental on subsequent restarts since lastOrderSync is in memory)
  runOrderSync().then(() => runRefundSync());

  // Then every 6 hours using setInterval (avoids the node-cron dependency)
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  setInterval(runOrderSync,  SIX_HOURS);
  setInterval(runRefundSync, SIX_HOURS + 60 * 1000); // offset by 1 min so they don't overlap

  console.log('[scheduler] Shopify sync registered — running every 6 hours');
}
