// services/syncScheduler.js — SIMPLIFIED: uses only env vars, no Supabase lookup
import { syncShopifyOrders  } from './syncOrders.js';
import { syncShopifyRefunds } from './syncRefunds.js';
import { supabaseAdmin }      from '../lib/supabase.js';

const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
let lastOrderSync  = null;
let lastRefundSync = null;

async function logSync(syncType, status, rowsSynced = 0, errorMsg = null) {
  try {
    const { error } = await supabaseAdmin.from('sync_log').insert({
      client_id:  CLIENT_ID,
      sync_type:  syncType,
      synced_at:  new Date().toISOString(),
      status,
      rows_synced: rowsSynced,
      error_msg:   errorMsg,
    });
    if (error) console.warn('[sync-log] insert error:', error.message);
  } catch (e) {
    console.warn('[sync-log] exception:', e.message);
  }
}

export async function runOrderSync() {
  const token = process.env.SHOPIFY_API_TOKEN;
  const shop  = process.env.SHOPIFY_STORE;

  if (!token || !shop) {
    console.error('[scheduler] SHOPIFY_API_TOKEN or SHOPIFY_STORE not set — skipping order sync');
    return;
  }

  console.log(`[scheduler] starting order sync for ${shop}...`);
  const since = lastOrderSync
    ? new Date(lastOrderSync - 5 * 60 * 1000).toISOString()
    : null;
  try {
    const { synced } = await syncShopifyOrders(since);
    lastOrderSync = Date.now();
    await logSync('orders', 'success', synced);
    console.log(`[scheduler] ✅ order sync complete: ${synced} rows`);
  } catch (e) {
    console.error('[scheduler] ❌ order sync failed:', e.message);
    await logSync('orders', 'error', 0, e.message);
  }
}

export async function runRefundSync() {
  const token = process.env.SHOPIFY_API_TOKEN;
  const shop  = process.env.SHOPIFY_STORE;

  if (!token || !shop) {
    console.error('[scheduler] SHOPIFY_API_TOKEN or SHOPIFY_STORE not set — skipping refund sync');
    return;
  }

  console.log(`[scheduler] starting refund sync for ${shop}...`);
  const since = lastRefundSync
    ? new Date(lastRefundSync - 5 * 60 * 1000).toISOString()
    : null;
  try {
    const { synced } = await syncShopifyRefunds(since);
    lastRefundSync = Date.now();
    await logSync('refunds', 'success', synced);
    console.log(`[scheduler] ✅ refund sync complete: ${synced} rows`);
  } catch (e) {
    console.error('[scheduler] ❌ refund sync failed:', e.message);
    await logSync('refunds', 'error', 0, e.message);
  }
}

export function startScheduler() {
  const token = process.env.SHOPIFY_API_TOKEN;
  const shop  = process.env.SHOPIFY_STORE;

  if (!token || !shop) {
    console.log('[scheduler] ⚠️  SHOPIFY_API_TOKEN or SHOPIFY_STORE missing — auto-sync disabled.');
    console.log('[scheduler]    Set both env vars in Render to enable sync.');
    return;
  }

  console.log(`[scheduler] ✅ Shopify sync enabled for ${shop} — runs every 6 hours`);
  // Delay boot sync by 3 minutes so server is fully ready to serve
  // dashboard requests before Supabase connections are consumed by the
  // bulk sync (15k+ orders floods the connection pool and causes 503s
  // on /health itself if fired immediately on startup).
  console.log('[scheduler] boot sync delayed 3 min — server accepting requests now');
  setTimeout(() => runOrderSync().then(() => runRefundSync()), 3 * 60 * 1000);

  const SIX_HOURS = 6 * 60 * 60 * 1000;
  setInterval(runOrderSync,  SIX_HOURS);
  setInterval(runRefundSync, SIX_HOURS + 60_000);
}
