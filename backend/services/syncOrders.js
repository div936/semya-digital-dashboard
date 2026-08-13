// services/syncOrders.js
// ─────────────────────────────────────────────────────────────────
// OPTION B — Shopify API sync (replaces CSV uploads for Website)
//
// When SHOPIFY_API_TOKEN is set, this runs automatically every 6
// hours via syncScheduler.js and pulls orders directly from the
// Shopify Admin API — the same source Shopify Analytics uses,
// giving an EXACT match with the numbers shown in Shopify Admin.
//
// Key differences from CSV upload (Option A):
//   - One row per ORDER (not per line item) — no inflation possible
//   - Real-time data — no export lag
//   - Exact match with Shopify Analytics Total Sales figure
//   - Handles refunds automatically via the refunds API
//   - No manual SQL corrections needed
//
// Revenue formula (matches Shopify "Total Sales"):
//   Total Sales = Gross Sales - Discounts - Reversals + Shipping + Taxes
//   Which equals: order.total_price (already computed by Shopify)
//   Minus: any refunds already processed on this order
// ─────────────────────────────────────────────────────────────────
import { shopifyPaginate } from './shopifyClient.js';
import { supabaseAdmin }   from '../lib/supabase.js';

const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;

// ── Parse GoKwik note_attributes for UTM data ─────────────────────
function parseNoteAttrs(attrs) {
  const out = {};
  if (!Array.isArray(attrs)) return out;
  for (const { name, value } of attrs) out[name] = value;
  return out;
}

function extractUtm(order) {
  const attrs    = parseNoteAttrs(order.note_attributes);
  let source     = attrs['utm_source']   || null;
  let campaign   = attrs['utm_campaign'] || null;
  let medium     = attrs['utm_medium']   || null;
  let content    = attrs['utm_content']  || null;
  let term       = attrs['utm_term']     || null;

  // Fallback: parse full_url
  if (!source && attrs['full_url']) {
    try {
      const u  = new URL(attrs['full_url']);
      source   = source   || u.searchParams.get('utm_source');
      campaign = campaign || u.searchParams.get('utm_campaign');
      medium   = medium   || u.searchParams.get('utm_medium');
      content  = content  || u.searchParams.get('utm_content');
      term     = term     || u.searchParams.get('utm_term');
    } catch (_) {}
  }

  // Fallback: Tags
  if (!source) {
    const match = (order.tags || '').match(/source-(\w+)/i);
    if (match) source = match[1].toLowerCase();
  }

  if (source) {
    source = source.toLowerCase();
    if (source === 'ig') source = 'facebook';
  }

  return {
    utm_source:   source,
    utm_campaign: campaign,
    utm_medium:   medium,
    utm_content:  content,
    utm_term:     term,
    gokwik_cid:   attrs['gokwik_cid'] || null,
  };
}

// ── Map one Shopify API order → one revenue_data row ─────────────
// ONE ROW PER ORDER — no multi-line-item inflation possible.
// Revenue = order.total_price (Shopify's "Total Sales" per order)
// minus any refunds already processed = exact Shopify Analytics match.
function mapOrder(order) {
  const tags        = order.tags || '';
  const utmFields   = extractUtm(order);
  const finStatus   = (order.financial_status || '').toLowerCase();
  const fulStatus   = (order.fulfillment_status || '').toLowerCase();

  // Platform attribution
  const platform = utmFields.utm_source === 'google' ? 'google' : 'meta';

  // Units — sum ALL paid line items (price > 0) across the order
  const paidItems  = (order.line_items || []).filter(li => parseFloat(li.price) > 0);
  const totalUnits = paidItems.reduce((s, li) => s + li.quantity, 0);
  const primarySku  = paidItems[0]?.sku  || null;
  const primaryName = paidItems[0]?.name || null;

  // Revenue = Shopify total_price minus any already-processed refunds
  // This matches Shopify's "Total Sales" calculation exactly
  const totalRefunded = (order.refunds || []).reduce((s, r) =>
    s + (r.transactions || []).reduce((ts, t) => ts + parseFloat(t.amount || 0), 0), 0
  );
  const netRevenue = Math.max(0, parseFloat(order.total_price || 0) - totalRefunded);

  // Standard status mapping
  let standard_status;
  if (finStatus === 'voided' || finStatus === 'refunded') standard_status = 'Cancelled';
  else if (finStatus === 'paid' && fulStatus === 'fulfilled') standard_status = 'Delivered';
  else if (finStatus === 'paid') standard_status = 'Paid';
  else standard_status = 'Pending';

  const riskLevel = (order.risk_level || '').trim() || null;

  // row_hash uses order name (unique per store) — safe upsert key
  const row_hash = `api:order_id:${order.name}`;

  return {
    client_id:            CLIENT_ID,
    platform,
    order_date:           order.created_at?.split('T')[0] || null,
    standard_order_id:    order.name,
    standard_revenue:     standard_status === 'Cancelled' ? 0 : netRevenue,
    standard_units:       standard_status === 'Cancelled' ? 0 : totalUnits,
    standard_sku:         primarySku,
    standard_product_name: primaryName,
    standard_city:        order.shipping_address?.city || order.billing_address?.city || null,
    standard_state:       order.shipping_address?.province || order.billing_address?.province || null,
    standard_status,
    financial_status:     finStatus,
    risk_level:           riskLevel,
    tags,
    is_duplicate_flag:    tags.includes('DUPLICATE_ORDER'),
    ...utmFields,
    row_hash,
    dedup_method:         'api_order_id',
    raw_extras:           {},
  };
}

export async function syncShopifyOrders(updatedAtMin = null) {
  if (!CLIENT_ID) throw new Error('SHOPIFY_CLIENT_ID env var not set');

  const params = {
    status: 'any',  // matches Shopify Admin "All Orders" exactly
    fields: [
      'id', 'name', 'created_at', 'financial_status', 'fulfillment_status',
      'total_price', 'refunds', 'line_items', 'note_attributes', 'tags',
      'risk_level', 'shipping_address', 'billing_address', 'test',
    ].join(','),
  };
  if (updatedAtMin) params.updated_at_min = updatedAtMin;

  let synced  = 0;
  let skipped = 0;

  for await (const batch of shopifyPaginate('/orders.json', params, 'orders')) {
    const rows = [];
    for (const order of batch) {
      if (order.test === true) { skipped++; continue; }
      rows.push(mapOrder(order));
    }
    if (!rows.length) continue;

    const { error } = await supabaseAdmin
      .from('revenue_data')
      .upsert(rows, { onConflict: 'client_id,row_hash' });

    if (error) console.error('[sync-orders] upsert error:', error.message);
    else synced += rows.length;
  }

  console.log(`[sync-orders] ✓ ${synced} orders synced, ${skipped} test orders skipped`);
  return { synced, skipped };
}
