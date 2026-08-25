// services/syncFlipkartReturns.js
// ─────────────────────────────────────────────────────────────────
// Pulls Flipkart returns into refunds_data — the same table used
// by the Shopify refund sync — so the AI Insights return tracking
// card covers Flipkart returns too without any frontend changes.
//
// Flipkart's GET /v2/returns endpoint returns:
//   returnId, orderItemId, orderId, sku, reason, type (COURIER_RETURN
//   or CUSTOMER_RETURN), status, returnDate, quantity, sellingPrice
//
// We write one refunds_data row per return item, using the same
// schema as syncRefunds.js.
// ─────────────────────────────────────────────────────────────────

import { flipkartPaginateReturns } from './flipkartClient.js';
import { supabaseAdmin }           from '../lib/supabase.js';

const CLIENT_ID = process.env.FLIPKART_CLIENT_ID;

function mapReturnRow(ret) {
  // Flipkart return types: COURIER_RETURN, CUSTOMER_RETURN
  const refundType = ret.type === 'COURIER_RETURN' ? 'courier_return' : 'customer_return';
  const amount     = (ret.sellingPrice || 0) * (ret.quantity || 1);

  return {
    client_id:            CLIENT_ID,
    platform:             'flipkart',
    refund_id:            String(ret.returnId),
    order_id:             ret.orderId    || null,
    refund_line_item_id:  String(ret.returnId) + '_' + (ret.orderItemId || '0'),
    refund_date:          ret.returnDate ? ret.returnDate.split('T')[0] : null,
    order_date:           null,   // not returned by FK returns API; could be enriched later
    refund_amount:        amount,
    currency:             'INR',
    sku:                  ret.sku          || null,
    product_name:         ret.productTitle || null,
    quantity_returned:    ret.quantity     || 1,
    refund_reason:        ret.reason       || null,
    refund_note:          ret.remarks      || null,
    restock:              true,            // Flipkart always restocks on return
    refund_type:          refundType,
  };
}

export async function syncFlipkartReturns(modifiedSince = null) {
  if (!CLIENT_ID) throw new Error('FLIPKART_CLIENT_ID env var not set');

  const params = {};
  if (modifiedSince) {
    params.modifiedAfter = new Date(modifiedSince).toISOString().split('T')[0];
  }

  let totalSynced = 0;

  for await (const batch of flipkartPaginateReturns(params)) {
    if (!batch.length) continue;

    const rows = batch.map(mapReturnRow);

    const { error } = await supabaseAdmin
      .from('refunds_data')
      .upsert(rows, { onConflict: 'client_id,refund_id,refund_line_item_id' });

    if (error) {
      console.error('[sync-fk-returns] upsert error:', error.message);
    } else {
      totalSynced += rows.length;
    }
  }

  console.log(`[sync-fk-returns] done: ${totalSynced} return rows synced`);
  return { synced: totalSynced };
}
