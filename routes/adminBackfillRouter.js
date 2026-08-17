// routes/adminBackfillRouter.js
// ─────────────────────────────────────────────────────────────────
// Admin-only, one-time maintenance endpoints.
//
// POST /:client_slug/admin/backfill-order-ids
//   Re-derives standard_order_id from raw_extras for rows where it
//   was never populated (original behaviour, safe to re-run).
//
// POST /:client_slug/admin/backfill-shopify-status
//   Fixes standard_status for all Shopify-shaped revenue rows
//   (platform = 'meta' or 'google') that were ingested before the
//   COD-fulfilled fix shipped.
//
//   Old logic:  paid + fulfilled → Delivered  |  else → Pending
//   New logic:  fulfilled (any)  → Delivered  |  paid  → Paid  |  else → Pending
//
//   A COD order (financial_status='pending', fulfillment_status='fulfilled')
//   was previously mapped to 'Pending'. These are DELIVERED orders —
//   GoKwik marks them fulfilled when the delivery partner confirms.
//   This backfill corrects all such rows so the Orders Fulfilled KPI
//   shows the right number without requiring a file re-upload.
//
//   Safe to re-run — rows already correct are not touched.
// ─────────────────────────────────────────────────────────────────
import { Router }       from 'express';
import { rbacMiddleware } from '../middleware/rbac.js';
import { supabaseAdmin }  from '../lib/supabase.js';
import { backfillOrderIds } from '../scripts/backfillOrderIds.js';

const router = Router({ mergeParams: true });

// ── existing backfill-order-ids route ────────────────────────────
router.post(
  '/:client_slug/admin/backfill-order-ids',
  rbacMiddleware,
  async (req, res) => {
    if (!req.semya.isAdmin) {
      return res.status(403).json({ error: 'Admin access required.' });
    }

    const logLines = [];
    const log = (line) => logLines.push(line);

    try {
      const summary = await backfillOrderIds({ log });
      return res.json({
        ok: true,
        summary,
        log: logLines,
        message: `Backfill complete. ${summary.totalUpdated} of ${summary.totalScanned} scanned rows were updated with a recovered order ID.`,
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: err.message,
        log: logLines,
      });
    }
  }
);

// ── NEW: backfill-shopify-status ──────────────────────────────────
// Corrects standard_status for meta/google rows using the raw
// Financial Status and Fulfillment Status stored in raw_extras.
// Processes rows in pages of 1 000 to avoid Render request timeouts.
router.post(
  '/:client_slug/admin/backfill-shopify-status',
  rbacMiddleware,
  async (req, res) => {
    if (!req.semya.isAdmin) {
      return res.status(403).json({ error: 'Admin access required.' });
    }

    const { client } = req.semya;
    const PAGE = 1000;
    let offset = 0;
    let scanned = 0, updated = 0, skipped = 0;
    const log = [];

    try {
      // We need to rebuild the order-level status map the same way
      // ingestion does: forward-fill Financial Status and Cancelled at
      // from the first row of each order, then apply status rules.
      //
      // Step 1 — collect all meta/google revenue rows for this client.
      // Pull only the columns we need to keep memory low.
      log.push('Fetching all meta/google revenue rows…');
      let allRows = [];
      while (true) {
        const { data, error } = await supabaseAdmin
          .from('revenue_data')
          .select('id, standard_order_id, standard_status, financial_status, raw_extras')
          .eq('client_id', client.id)
          .in('platform', ['meta', 'google'])
          .range(offset, offset + PAGE - 1);
        if (error) throw new Error('Fetch error: ' + error.message);
        if (!data || data.length === 0) break;
        allRows = allRows.concat(data);
        if (data.length < PAGE) break;
        offset += PAGE;
      }
      log.push(`Fetched ${allRows.length} rows total.`);

      // Step 2 — build order-level status map (same forward-fill as ingestion).
      const orderStatusMap = new Map();
      for (const row of allRows) {
        const oid = row.standard_order_id;
        if (!oid) continue;
        const fin = String(row.raw_extras?.['Financial Status'] || '').trim();
        const ca  = String(row.raw_extras?.['Cancelled at']    || '').trim();
        if (!orderStatusMap.has(oid)) orderStatusMap.set(oid, { finStatus: '', cancelledAt: '' });
        const entry = orderStatusMap.get(oid);
        if (!entry.finStatus   && fin)                            entry.finStatus   = fin;
        if (!entry.cancelledAt && ca && ca !== 'nan' && ca !== 'none') entry.cancelledAt = ca;
      }
      log.push(`Built status map for ${orderStatusMap.size} distinct orders.`);

      // Step 3 — compute correct status for each row and collect updates.
      const updates = []; // { id, newStatus }
      for (const row of allRows) {
        scanned++;
        const oid = row.standard_order_id;
        if (!oid) { skipped++; continue; }

        const entry = orderStatusMap.get(oid) || {};
        const fin = (entry.finStatus || '').toLowerCase();
        const ca  = entry.cancelledAt || '';
        const ful = String(row.raw_extras?.['Fulfillment Status'] || '').toLowerCase();

        let correctStatus;
        if (fin === 'voided' || fin === 'refunded' || ca) {
          correctStatus = 'Cancelled';
        } else if (ful === 'fulfilled') {
          // THE FIX: COD-delivered orders have fin='pending', ful='fulfilled'.
          // Old code required fin='paid' — they fell through to 'Pending'.
          correctStatus = 'Delivered';
        } else if (fin === 'paid') {
          correctStatus = 'Paid';
        } else {
          correctStatus = 'Pending';
        }

        if (row.standard_status !== correctStatus) {
          updates.push({ id: row.id, newStatus: correctStatus,
                         was: row.standard_status });
        }
      }
      log.push(`${updates.length} rows need updating (${scanned - updates.length} already correct, ${skipped} skipped — no order ID).`);

      // Step 4 — apply updates in batches using upsert on id.
      const BATCH = 200;
      for (let i = 0; i < updates.length; i += BATCH) {
        const chunk = updates.slice(i, i + BATCH);
        const { error } = await supabaseAdmin
          .from('revenue_data')
          .upsert(
            chunk.map(u => ({ id: u.id, standard_status: u.newStatus })),
            { onConflict: 'id', ignoreDuplicates: false }
          );
        if (error) throw new Error(`Upsert error at offset ${i}: ${error.message}`);
        updated += chunk.length;
      }

      // Step 5 — breakdown of what changed, for the log.
      const byChange = {};
      for (const u of updates) {
        const key = (u.was || 'null') + ' → ' + u.newStatus;
        byChange[key] = (byChange[key] || 0) + 1;
      }

      log.push('Done.');
      return res.json({
        ok: true,
        scanned,
        updated,
        skipped,
        breakdown: byChange,
        log,
        message: `Backfill complete. ${updated} of ${scanned} rows corrected.`,
      });

    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message, log });
    }
  }
);

export default router;
