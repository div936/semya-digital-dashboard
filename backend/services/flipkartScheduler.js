// services/flipkartScheduler.js
// ─────────────────────────────────────────────────────────────────
// Scheduler for Flipkart API sync. Runs every 6 hours (same cadence
// as Shopify). Called from app.js alongside startScheduler().
//
// Sync order:
//   1. Orders (all statuses via /v3/shipments/filter)
//   2. Returns (via /v2/returns)
//
// Env vars required (set in Render alongside SHOPIFY_* vars):
//   FLIPKART_APP_ID       — from Seller Dashboard > Manage Profile > Developer Access
//   FLIPKART_APP_SECRET   — same location
//   FLIPKART_CLIENT_ID    — the UUID of the client row in Supabase (same as SHOPIFY_CLIENT_ID for Neat Everyday)
// ─────────────────────────────────────────────────────────────────

import { syncFlipkartOrders  } from './syncFlipkartOrders.js';
import { syncFlipkartReturns } from './syncFlipkartReturns.js';
import { supabaseAdmin }       from '../lib/supabase.js';

const CLIENT_ID = process.env.FLIPKART_CLIENT_ID;

let lastOrderSync  = null;
let lastReturnSync = null;

async function logSync(syncType, status, rowsSynced = 0, errorMsg = null) {
  try {
    await supabaseAdmin.from('sync_log').insert({
      client_id:   CLIENT_ID,
      sync_type:   syncType,
      synced_at:   new Date().toISOString(),
      status,
      rows_synced: rowsSynced,
      error_msg:   errorMsg,
    });
  } catch (e) {
    console.warn('[fk-sync-log] exception:', e.message);
  }
}

export async function runFlipkartOrderSync() {
  if (!process.env.FLIPKART_APP_ID || !process.env.FLIPKART_APP_SECRET) {
    console.error('[fk-scheduler] FLIPKART_APP_ID / FLIPKART_APP_SECRET not set — skipping');
    return;
  }
  console.log('[fk-scheduler] starting order sync…');
  // 5-minute overlap buffer to catch any orders that arrived
  // during the previous sync window (same logic as Shopify scheduler)
  const since = lastOrderSync
    ? new Date(lastOrderSync - 5 * 60 * 1000).toISOString()
    : null;
  try {
    const { synced } = await syncFlipkartOrders(since);
    lastOrderSync = Date.now();
    await logSync('flipkart_orders', 'success', synced);
    console.log(`[fk-scheduler] ✅ order sync done: ${synced} rows`);
  } catch (e) {
    console.error('[fk-scheduler] ❌ order sync failed:', e.message);
    await logSync('flipkart_orders', 'error', 0, e.message);
  }
}

export async function runFlipkartReturnSync() {
  if (!process.env.FLIPKART_APP_ID || !process.env.FLIPKART_APP_SECRET) return;
  console.log('[fk-scheduler] starting return sync…');
  const since = lastReturnSync
    ? new Date(lastReturnSync - 5 * 60 * 1000).toISOString()
    : null;
  try {
    const { synced } = await syncFlipkartReturns(since);
    lastReturnSync = Date.now();
    await logSync('flipkart_returns', 'success', synced);
    console.log(`[fk-scheduler] ✅ return sync done: ${synced} rows`);
  } catch (e) {
    console.error('[fk-scheduler] ❌ return sync failed:', e.message);
    await logSync('flipkart_returns', 'error', 0, e.message);
  }
}

export function startFlipkartScheduler() {
  if (!process.env.FLIPKART_APP_ID || !process.env.FLIPKART_APP_SECRET) {
    console.log('[fk-scheduler] ⚠️  FLIPKART_APP_ID / FLIPKART_APP_SECRET missing — auto-sync disabled.');
    return;
  }
  console.log('[fk-scheduler] ✅ Flipkart sync enabled — runs every 6 hours');

  // Immediate first run on boot
  runFlipkartOrderSync().then(() => runFlipkartReturnSync());

  const SIX_HOURS = 6 * 60 * 60 * 1000;
  setInterval(runFlipkartOrderSync,  SIX_HOURS);
  setInterval(runFlipkartReturnSync, SIX_HOURS + 90_000); // 90s stagger from orders
}
