// services/syncRefunds.js
// ─────────────────────────────────────────────────────────────────
// Pulls refunds from Shopify into refunds_data table.
// Refunds are stored with their OWN date (refund_date), not the
// original order date — this is what solves the late-return problem.
// ─────────────────────────────────────────────────────────────────
import { shopifyPaginate } from './shopifyClient.js';
import { supabaseAdmin }   from '../lib/supabase.js';

const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;

function mapRefundRows(refund, order) {
  const refundDate = refund.created_at?.split('T')[0] || null;
  const orderDate  = order.created_at?.split('T')[0]  || null;
  const orderId    = order.name;  // NEAT-XXXXX

  const totalAmount = (refund.transactions || [])
    .reduce((s, t) => s + parseFloat(t.amount || 0), 0);
  const originalTotal = parseFloat(order.total_price || 0);
  const refundType = totalAmount >= originalTotal * 0.99 ? 'full'
                   : totalAmount > 0 ? 'partial'
                   : 'cancellation';

  const lineItems = refund.refund_line_items || [];
  if (!lineItems.length) {
    return [{
      client_id: CLIENT_ID, platform: 'website',
      refund_id: String(refund.id), order_id: orderId,
      refund_line_item_id: String(refund.id) + '_adj',
      refund_date: refundDate, order_date: orderDate,
      refund_amount: totalAmount, currency: 'INR',
      sku: null, product_name: 'Adjustment',
      quantity_returned: 0, refund_type: refundType,
      refund_note: refund.note || null, restock: false,
    }];
  }

  return lineItems.map(rli => ({
    client_id: CLIENT_ID, platform: 'website',
    refund_id: String(refund.id), order_id: orderId,
    refund_line_item_id: String(rli.id),
    refund_date: refundDate, order_date: orderDate,
    refund_amount: parseFloat(rli.line_item?.price || 0) * (rli.quantity || 0),
    currency: 'INR',
    sku:             rli.line_item?.sku   || null,
    product_name:    rli.line_item?.name  || null,
    quantity_returned: rli.quantity || 0,
    refund_reason:   rli.restock_type || 'return',
    refund_note:     refund.note || null,
    restock:         rli.restock_type === 'return',
    refund_type:     refundType,
  }));
}

export async function syncShopifyRefunds(updatedAtMin = null) {
  if (!CLIENT_ID) throw new Error('SHOPIFY_CLIENT_ID env var not set');

  const params = {
    status: 'any',
    fields: 'id,name,created_at,total_price,financial_status,refunds,line_items',
  };
  if (updatedAtMin) params.updated_at_min = updatedAtMin;

  let synced = 0;

  for await (const batch of shopifyPaginate('/orders.json', params, 'orders')) {
    const rows = [];
    for (const order of batch) {
      if (!order.refunds?.length || order.test) continue;
      for (const refund of order.refunds) {
        rows.push(...mapRefundRows(refund, order));
      }
    }
    if (!rows.length) continue;

    const { error } = await supabaseAdmin
      .from('refunds_data')
      .upsert(rows, { onConflict: 'client_id,refund_id,refund_line_item_id' });

    if (error) console.error('[sync-refunds] upsert error:', error.message);
    else synced += rows.length;
  }

  console.log(`[sync-refunds] done: ${synced} refund rows synced`);
  return { synced };
}
