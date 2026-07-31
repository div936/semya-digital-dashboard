// ═══════════════════════════════════════════════════════════════════
// BACKFILL: standard_order_id for existing revenue_data rows
//
// standard_order_id was only added as a real, mapped field recently.
// Before that, order-ID-like columns (Order ID, Order Number, Name,
// amazon-order-id, etc.) were never recognised — but since normaliseRow
// stores every UNMAPPED column into raw_extras under its original
// header text, the actual order ID is still sitting there for every
// row ingested before this fix, untouched. This script reads it back
// out and populates standard_order_id directly, in place — no
// re-upload needed.
//
// Two ways to run it:
//   1. CLI (needs Render shell / local access):
//        node backend/scripts/backfillOrderIds.js
//   2. HTTP (works on Render's free tier, no shell needed) — see
//      routes/adminBackfillRouter.js, mounted at:
//        POST /clients/:client_slug/admin/backfill-order-ids
//
// Safe to re-run: only ever writes to standard_order_id, and only for
// rows where it's currently NULL — running it twice just re-scans
// everything and updates nothing the second time.
//
// Uses a stable id-based cursor (not offset pagination filtered on
// IS NULL) deliberately — updating rows to non-NULL WHILE paginating
// on "WHERE standard_order_id IS NULL" would shift which rows land on
// which page mid-scan, risking rows being skipped or re-counted. A
// single ordered pass over every row's primary key avoids that.
//
// IMPORTANT: this function never calls process.exit() — it's called
// from an HTTP route as well as the CLI wrapper at the bottom of this
// file, and exiting the process inside a web request would crash the
// entire server, not just this one operation. It throws on error
// instead, which each caller handles appropriately.
// ═══════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '../lib/supabase.js';
import { extractOrderId } from '../lib/columnMapper.js';

const BATCH_SIZE = 1000;
const CHUNK_SIZE = 500;

export async function backfillOrderIds({ log = () => {} } = {}) {
  let totalScanned = 0;
  let totalUpdated = 0;
  let totalAlreadySet = 0;
  let totalNoOrderIdFound = 0;
  let lastId = null; // cursor — null means "start from the beginning"

  log('[backfill] Starting standard_order_id backfill for revenue_data...');

  while (true) {
    let query = supabaseAdmin
      .from('revenue_data')
      .select('id, standard_order_id, raw_extras')
      .order('id', { ascending: true })
      .limit(BATCH_SIZE);

    if (lastId) query = query.gt('id', lastId);

    const { data: rows, error } = await query;
    if (error) {
      throw new Error(`[backfill] Fetch error: ${error.message}`);
    }
    if (!rows || rows.length === 0) break; // reached the end of the table

    totalScanned += rows.length;
    lastId = rows[rows.length - 1].id; // advance cursor regardless of what we update

    const updates = [];
    let skippedAlreadySet = 0;
    for (const row of rows) {
      if (row.standard_order_id) {
        totalAlreadySet++;
        skippedAlreadySet++;
        continue; // already populated (new upload, or a prior backfill run) — leave it alone
      }
      const orderId = extractOrderId(row.raw_extras);
      if (orderId) {
        updates.push({ id: row.id, standard_order_id: orderId });
      } else {
        totalNoOrderIdFound++;
      }
    }

    for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
      const chunk = updates.slice(i, i + CHUNK_SIZE);
      const { error: upErr } = await supabaseAdmin
        .from('revenue_data')
        .upsert(chunk, { onConflict: 'id' });
      if (upErr) {
        throw new Error(`[backfill] Upsert error: ${upErr.message}`);
      }
      totalUpdated += chunk.length;
    }

    const noIdInBatch = rows.length - updates.length - skippedAlreadySet;
    log(`[backfill] Scanned ${totalScanned} rows so far — this batch: ${updates.length} updated, ${skippedAlreadySet} already set, ${noIdInBatch} had no order-ID column.`);
  }

  const summary = {
    totalScanned,
    totalUpdated,
    totalAlreadySet,
    totalNoOrderIdFound,
  };

  log('[backfill] Done — full table scanned once.');
  log(`  Total rows scanned:                 ${totalScanned}`);
  log(`  Rows updated with a recovered order ID: ${totalUpdated}`);
  log(`  Rows already had an order ID set:   ${totalAlreadySet}`);
  log(`  Rows with no order-ID column at all in the source file (left NULL — expected for some platforms): ${totalNoOrderIdFound}`);
  log('Rows left NULL are not an error — /platform-sales already counts each of those as its own order, same behaviour as before this backfill.');

  return summary;
}

// ─── CLI entry point ───────────────────────────────────────────────
// Only runs when this file is executed directly (node backfillOrderIds.js),
// not when imported by the HTTP route.
if (import.meta.url === `file://${process.argv[1]}`) {
  backfillOrderIds({ log: console.log })
    .then(() => process.exit(0))
    .catch(err => {
      console.error('[backfill] Fatal error:', err.message);
      process.exit(1);
    });
}
