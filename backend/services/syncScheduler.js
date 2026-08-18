// services/syncScheduler.js
// ─────────────────────────────────────────────────────────────────
// FIXED: Reads Shopify token from Supabase (set by OAuth flow)
// instead of requiring SHOPIFY_API_TOKEN env var.
// ─────────────────────────────────────────────────────────────────
import { syncShopifyOrders  } from './syncOrders.js';
import { syncShopifyRefunds } from './syncRefunds.js';
import { supabaseAdmin }      from '../lib/supabase.js';

const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;

let lastOrderSync  = null;
let lastRefundSync = null;

async function logSync(syncType, status, rowsSynced = 0, errorMsg = null) {
  await supabaseAdmin.from('sync_log').insert({
    client_id: CLIENT_ID, sync_type: syncType,
    synced_at: new Date().toISOString(),
    status, rows_synced: rowsSynced, error_msg: errorMsg,
  }).catch(e => console.warn('[sync-log] failed to write log:', e.message));
}

// Fetch token from Supabase shopify_tokens table (set during OAuth)
async function getShopifyToken() {
  const shop = process.env.SHOPIFY_STORE;
  if (!shop) return null;

  // First try env var (manual override)
  if (process.env.SHOPIFY_API_TOKEN) return process.env.SHOPIFY_API_TOKEN;

  // Otherwise read from Supabase (set by OAuth flow)
  const { data, error } = await supabaseAdmin
    .from('shopify_tokens')
    .select('access_token')
    .eq('shop', shop)
    .maybeSingle();

  if (error) {
    console.error('[scheduler] failed to read token from Supabase:', error.message);
    return null;
  }
  return data?.access_token || null;
}

export async function runOrderSync() {
  console.log('[scheduler] starting order sync...');

  // Inject token into env for shopifyClient.js to pick up
  const token = await getShopifyToken();
  if (!token) {
    console.error('[scheduler] no Shopify token found — skipping order sync');
    await logSync('orders', 'error', 0, 'No Shopify access token found in env or Supabase');
    return;
  }
  process.env.SHOPIFY_API_TOKEN = token;

  const since = lastOrderSync
    ? new Date(lastOrderSync - 5 * 60 * 1000).toISOString()
    : null;
  try {
    const { synced } = await syncShopifyOrders(since);
    lastOrderSync = Date.now();
    await logSync('orders', 'success', synced);
    console.log(`[scheduler] order sync complete: ${synced} rows`);
  } catch (e) {
    console.error('[scheduler] order sync failed:', e.message);
    await logSync('orders', 'error', 0, e.message);
  }
}

export async function runRefundSync() {
  console.log('[scheduler] starting refund sync...');

  const token = await getShopifyToken();
  if (!token) {
    console.error('[scheduler] no Shopify token found — skipping refund sync');
    await logSync('refunds', 'error', 0, 'No Shopify access token found in env or Supabase');
    return;
  }
  process.env.SHOPIFY_API_TOKEN = token;

  const since = lastRefundSync
    ? new Date(lastRefundSync - 5 * 60 * 1000).toISOString()
    : null;
  try {
    const { synced } = await syncShopifyRefunds(since);
    lastRefundSync = Date.now();
    await logSync('refunds', 'success', synced);
    console.log(`[scheduler] refund sync complete: ${synced} rows`);
  } catch (e) {
    console.error('[scheduler] refund sync failed:', e.message);
    await logSync('refunds', 'error', 0, e.message);
  }
}

export function startScheduler() {
  if (!process.env.SHOPIFY_STORE || !CLIENT_ID) {
    console.log('[scheduler] SHOPIFY_STORE or SHOPIFY_CLIENT_ID not set — auto-sync disabled.');
    return;
  }

  console.log('[scheduler] Shopify sync registered — running every 6 hours');
  console.log('[scheduler] Token source: Supabase shopify_tokens table (OAuth) or SHOPIFY_API_TOKEN env var');

  // Run immediately on boot
  runOrderSync().then(() => runRefundSync());

  // Then every 6 hours
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  setInterval(runOrderSync,  SIX_HOURS);
  setInterval(runRefundSync, SIX_HOURS + 60 * 1000);
}
