// services/syncFlipkartOrders.js
// ─────────────────────────────────────────────────────────────────
// Pulls Flipkart shipments (all statuses) into revenue_data via
// upsert. Mirrors syncOrders.js exactly so the same dedup logic,
// column names, and Supabase upsert path applies.
//
// Key differences from Shopify:
//   • Flipkart API uses /v3/shipments/filter POST (not GET /orders)
//   • Revenue = priceComponents.sellingPrice (matches what the
//     CSV importer reads from "Selling Price Per Item")
//   • No UTM data from Flipkart (marketplace controls traffic)
//   • Cancellation reason exposed directly on the order item
//   • City/state come from the shipment details endpoint (separate call)
//   • Flipkart statuses map to our standard_status as follows:
//       DELIVERED           → 'Delivered'
//       CANCELLED           → 'Cancelled'
//       RETURN_REQUESTED    → 'Returned'
//       RETURNED            → 'Returned'
//       APPROVED / PACKED /
//       READY_TO_DISPATCH /
//       SHIPPED             → 'Pending'
// ─────────────────────────────────────────────────────────────────

import { flipkartPaginateShipments, flipkartGet } from './flipkartClient.js';
import { upsertProductCatalogue }                 from '../lib/productCatalogue.js';
import { supabaseAdmin }                          from '../lib/supabase.js';
import { normaliseStateName }                     from '../lib/columnMapper.js';

const CLIENT_ID = process.env.FLIPKART_CLIENT_ID; // same UUID pattern as SHOPIFY_CLIENT_ID

// ── Status mapper ────────────────────────────────────────────────
function mapStatus(fkStatus) {
  switch ((fkStatus || '').toUpperCase()) {
    case 'DELIVERED':         return 'Delivered';
    case 'CANCELLED':         return 'Cancelled';
    case 'RETURN_REQUESTED':
    case 'RETURNED':          return 'Returned';
    default:                  return 'Pending';
  }
}

// ── Cancellation sub-reason mapper ───────────────────────────────
// Flipkart exposes who cancelled (buyer / seller / marketplace) and a
// sub-reason. Normalise to a human-readable string for raw_extras so
// the AI Cancellation Pattern Watch card can surface these.
function cancellationNote(item) {
  if (!item.cancellationReason) return null;
  const sub = item.cancellationSubReason ? ` (${item.cancellationSubReason})` : '';
  return `${item.cancellationReason}${sub}`;
}

// ── Map one Flipkart order item → revenue_data row ───────────────
// Flipkart structures: one shipment → many orderItems.
// We store one revenue_data row per orderItem (same as CSV import).
function mapOrderItem(item, shipment, deliveryAddr) {
  const status      = mapStatus(item.status);
  const price       = item.priceComponents?.sellingPrice || 0;
  const qty         = item.quantity || 1;
  const netRevenue  = status === 'Cancelled' ? 0 : price * qty;

  // row_hash — same tier-1 logic as fileIngestion.js:
  //   order_item_id is the most-reliable dedup key for Flipkart
  const rowHash = `order_item_id:${item.orderItemId}`;

  return {
    client_id:             CLIENT_ID,
    platform:              'flipkart',
    order_date:            item.orderDate ? item.orderDate.split('T')[0] : null,
    standard_order_id:     item.orderId,
    standard_order_item_id: item.orderItemId,
    standard_revenue:      netRevenue,
    standard_units:        qty,
    standard_sku:          item.sku || null,
    standard_product_name: null,   // not returned by shipments API; enriched by productCatalogue
    standard_city:         deliveryAddr?.city  || null,
    standard_state:        deliveryAddr?.stateName
                           ? normaliseStateName(deliveryAddr.stateName)
                           : null,
    standard_status:       status,
    financial_status:      (item.status || '').toLowerCase(),
    cancelled_date:        item.cancellationDate ? item.cancellationDate.split('T')[0] : null,
    row_hash:              rowHash,
    dedup_method:          'order_item_id',
    raw_extras: {
      'Shipping Name':   deliveryAddr
        ? `${deliveryAddr.firstName || ''} ${deliveryAddr.lastName || ''}`.trim()
        : null,
      'Shipping Zip':    deliveryAddr?.pincode   || null,
      'Shipping Street': deliveryAddr?.addressLine1 || null,
      'Cancel Reason':   cancellationNote(item),
      'Shipment ID':     shipment.shipmentId,
      'FSN':             item.fsn || null,
    },
  };
}

// ── Fetch delivery addresses for a batch of shipmentIds ──────────
// GET /v3/shipments/{shipmentIds} returns full address info.
// We batch 25 at a time (recommended max per the FK docs).
async function fetchDeliveryAddresses(shipmentIds) {
  const addressMap = new Map(); // shipmentId → deliveryAddress
  const BATCH = 25;
  for (let i = 0; i < shipmentIds.length; i += BATCH) {
    const batch = shipmentIds.slice(i, i + BATCH);
    try {
      const data = await flipkartGet(`/v3/shipments/${batch.join(',')}`);
      const shipments = Array.isArray(data) ? data : (data.shipments || []);
      for (const s of shipments) {
        if (s.shipmentId) addressMap.set(s.shipmentId, s.deliveryAddress || null);
      }
    } catch (e) {
      console.warn('[sync-fk-orders] address fetch failed for batch:', e.message);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return addressMap;
}

// ── Main sync ────────────────────────────────────────────────────
export async function syncFlipkartOrders(updatedSince = null) {
  if (!CLIENT_ID) throw new Error('FLIPKART_CLIENT_ID env var not set');

  // Build date filter — if updatedSince provided, only fetch orders
  // placed/updated after that date. For a full backfill, leave null.
  const orderDateFilter = updatedSince
    ? { from: new Date(updatedSince).toISOString(), to: new Date().toISOString() }
    : undefined;

  const filterBodies = [
    // Pull all post-dispatch states (delivered, returned, etc.)
    { type: 'postDispatch', states: ['DELIVERED'], ...(orderDateFilter && { orderDate: orderDateFilter }) },
    { type: 'postDispatch', states: ['PICKUP_COMPLETE'], ...(orderDateFilter && { orderDate: orderDateFilter }) },
    // Pull cancelled orders
    { type: 'cancelled', cancellationType: 'buyerCancellation',       ...(orderDateFilter && { orderDate: orderDateFilter }) },
    { type: 'cancelled', cancellationType: 'sellerCancellation',      ...(orderDateFilter && { orderDate: orderDateFilter }) },
    { type: 'cancelled', cancellationType: 'marketplaceCancellation', ...(orderDateFilter && { orderDate: orderDateFilter }) },
    // Pull pre-dispatch (pending/approved) — useful for real-time view
    { type: 'preDispatch', states: ['APPROVED', 'PACKING_IN_PROGRESS', 'PACKED', 'READY_TO_DISPATCH'], ...(orderDateFilter && { orderDate: orderDateFilter }) },
  ];

  let totalSynced = 0;

  for (const filter of filterBodies) {
    try {
      for await (const shipmentBatch of flipkartPaginateShipments(filter)) {
        if (!shipmentBatch.length) continue;

        // Fetch delivery addresses for this batch of shipments
        const shipmentIds  = shipmentBatch.map(s => s.shipmentId);
        const addressMap   = await fetchDeliveryAddresses(shipmentIds);

        // Flatten: one shipment → many orderItems → many rows
        const rows = [];
        for (const shipment of shipmentBatch) {
          const deliveryAddr = addressMap.get(shipment.shipmentId) || null;
          for (const item of shipment.orderItems || []) {
            rows.push(mapOrderItem(item, shipment, deliveryAddr));
          }
        }
        if (!rows.length) continue;

        const { error } = await supabaseAdmin
          .from('revenue_data')
          .upsert(rows, { onConflict: 'client_id,row_hash' });

        if (error) {
          console.error('[sync-fk-orders] upsert error:', error.message);
        } else {
          totalSynced += rows.length;
          // Update product catalogue (fire-and-forget)
          upsertProductCatalogue(
            rows.map(r => ({
              client_id:             r.client_id,
              platform:              r.platform,
              standard_sku:         r.standard_sku,
              standard_product_name: r.standard_product_name,
              order_date:            r.order_date,
            })),
            CLIENT_ID
          ).catch(err =>
            console.warn('[sync-fk-orders] catalogue update failed (non-fatal):', err.message)
          );
        }
      }
    } catch (e) {
      // Don't let one filter type failure abort the rest
      console.error(`[sync-fk-orders] filter ${JSON.stringify(filter)} failed:`, e.message);
    }
  }

  console.log(`[sync-fk-orders] done: ${totalSynced} rows synced`);
  return { synced: totalSynced };
}
