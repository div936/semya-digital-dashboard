// services/syncOrders.js
// ─────────────────────────────────────────────────────────────────
// Pulls all Shopify orders into revenue_data via upsert.
// Matches Shopify Admin "All Orders" exactly by using status=any.
// ─────────────────────────────────────────────────────────────────
import { shopifyPaginate } from './shopifyClient.js';
import { upsertProductCatalogue } from '../lib/productCatalogue.js';
import { supabaseAdmin }   from '../lib/supabase.js';

const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID; // UUID of the client row in Supabase

// Parse note_attributes array → flat object
function parseNoteAttrs(attrs) {
  const out = {};
  if (!Array.isArray(attrs)) return out;
  for (const { name, value } of attrs) out[name] = value;
  return out;
}

// Extract UTM — primary: GoKwik note_attributes, fallback: full_url, then Tags
function extractUtm(order) {
  const attrs   = parseNoteAttrs(order.note_attributes);
  let source    = attrs['utm_source']   || null;
  let campaign  = attrs['utm_campaign'] || null;
  let medium    = attrs['utm_medium']   || null;
  let content   = attrs['utm_content']  || null;
  let term      = attrs['utm_term']     || null;

  // Fallback: parse full_url
  if (!source && attrs['full_url']) {
    try {
      const u = new URL(attrs['full_url']);
      source   = source   || u.searchParams.get('utm_source');
      campaign = campaign || u.searchParams.get('utm_campaign');
      medium   = medium   || u.searchParams.get('utm_medium');
      content  = content  || u.searchParams.get('utm_content');
      term     = term     || u.searchParams.get('utm_term');
    } catch (_) {}
  }

  // Fallback: Tags field
  if (!source) {
    const match = (order.tags || '').match(/source-(\w+)/i);
    if (match) source = match[1].toLowerCase();
  }

  // Normalise
  if (source) {
    source = source.toLowerCase();
    if (source === 'ig') source = 'facebook';
  }

  return { utm_source: source, utm_campaign: campaign, utm_medium: medium,
           utm_content: content, utm_term: term,
           gokwik_cid: attrs['gokwik_cid'] || null };
}

function mapOrder(order) {
  const tags      = order.tags || '';
  const utmFields = extractUtm(order);
  const finStatus = (order.financial_status || '').toLowerCase();

  // Paid line items only (price > 0) for unit count
  const paidItems  = (order.line_items || []).filter(li => parseFloat(li.price) > 0);
  const totalUnits = paidItems.reduce((s, li) => s + li.quantity, 0);
  const primarySku  = paidItems.find(li => li.sku)?.sku || null;
  const primaryName = paidItems.find(li => li.name)?.name || null;
  // Fulfillment channel: 'manual' = Merchant, 'amazon_marketplace_web' = FBA, etc.
  const fulfillmentChannel = (() => {
    const fuls = order.fulfillments || [];
    if (fuls.length === 0) return order.fulfillment_status === null ? 'meta' : 'manual';
    const svc = (fuls[0]?.service || '').toLowerCase();
    if (svc.includes('amazon') || svc.includes('fba')) return 'Amazon: FBA';
    if (svc === 'manual' || svc === '') return 'Merchant';
    return svc || 'manual';
  })();

  // Net revenue = total minus any already-processed refunds
  const totalRefunded = (order.refunds || []).reduce((s, r) =>
    s + (r.transactions || []).reduce((ts, t) => ts + parseFloat(t.amount || 0), 0), 0);
  const netRevenue = Math.max(0, parseFloat(order.total_price || 0) - totalRefunded);

  // Map financial_status → standard_status (same logic as fileIngestion.js)
  // FIX: 'cancelled' financial_status was falling through to 'Pending' — now
  // correctly maps to 'Cancelled' so it's excluded from revenue totals and
  // included in cancellation pattern detection.
  let standard_status;
  if (['voided', 'refunded', 'cancelled'].includes(finStatus)) standard_status = 'Cancelled';
  else if (finStatus === 'paid' && order.fulfillment_status === 'fulfilled') standard_status = 'Delivered';
  else if (finStatus === 'paid') standard_status = 'Delivered';
  else standard_status = 'Pending';

  // Risk level — Shopify API returns it as order.risk_level (string) on some versions
  const riskLevel = (order.risk_level || '').trim() || null;

  return {
    client_id:          CLIENT_ID,
    platform:           utmFields.utm_source === 'google' ? 'google' : 'meta',  // google if UTM=google, otherwise meta
    order_date:         order.created_at?.split('T')[0] || null,
    standard_order_id:  order.name,            // NEAT-16463
    standard_revenue:   netRevenue,
    standard_units:     totalUnits,
    standard_sku:       primarySku,
    standard_product_name: primaryName,
    standard_city:      order.shipping_address?.city || order.billing_address?.city || null,
    standard_state:     order.shipping_address?.province || order.billing_address?.province || null,
    standard_status,
    financial_status:   finStatus,
    standard_fulfillment_channel: fulfillmentChannel,
    risk_level:         riskLevel,
    tags,
    is_duplicate_flag:  tags.includes('DUPLICATE_ORDER'),
    ...utmFields,
    // row_hash — reuse order_id+sku tier (same as fileIngestion.js tier 2)
    row_hash:           `order_id_sku:${order.name}|${primarySku || ''}`,
    dedup_method:       'order_id_sku',
    // Populate raw_extras with buyer identity fields using the SAME key names
    // that extractIdentity() looks for (IDENTITY_KEYS in columnMapper.js).
    // This makes API-synced orders work with Cancellation Pattern Watch,
    // which was previously blind to all Shopify API data because raw_extras
    // was always an empty object {} for API-pulled orders.
    raw_extras: {
      'Shipping Phone':  order.shipping_address?.phone || order.phone || null,
      'Billing Phone':   order.billing_address?.phone  || order.phone || null,
      'Shipping Name':   order.shipping_address?.name  || null,
      'Billing Name':    order.billing_address?.name   || null,
      'Shipping Zip':    order.shipping_address?.zip   || null,
      'Billing Zip':     order.billing_address?.zip    || null,
      'Shipping Street': order.shipping_address?.address1 || null,
      'Email':           order.email || null,
      'Cancelled at':    order.cancelled_at || null,
      'Cancel Reason':   order.cancel_reason || null,
    },
  };
}

export async function syncShopifyOrders(updatedAtMin = null) {
  if (!CLIENT_ID) throw new Error('SHOPIFY_CLIENT_ID env var not set');

  const params = {
    status: 'any',   // matches Shopify Admin "All Orders" — critical
    fields: [
      'id','name','created_at','financial_status','fulfillment_status',
      'total_price','refunds','line_items','note_attributes','tags',
      'risk_level','shipping_address','billing_address','test','fulfillments',
      'phone','email','cancelled_at','cancel_reason',
    ].join(','),
  };
  if (updatedAtMin) params.updated_at_min = updatedAtMin;

  let synced = 0;
  let skipped = 0;

  for await (const batch of shopifyPaginate('/orders.json', params, 'orders')) {
    const rows = [];
    for (const order of batch) {
      // Note: test orders are included intentionally for development stores
      rows.push(mapOrder(order));
    }
    if (!rows.length) continue;

    const { error } = await supabaseAdmin
      .from('revenue_data')
      .upsert(rows, { onConflict: 'client_id,row_hash' });

    if (error) {
      console.error('[sync-orders] upsert error:', error.message);
    } else {
      synced += rows.length;
      // Update product catalogue with SKUs from this batch (fire-and-forget)
      upsertProductCatalogue(rows.map(r => ({
        client_id:            r.client_id,
        platform:             r.platform,
        standard_sku:         r.standard_sku,
        standard_product_name: r.standard_product_name,
        order_date:           r.order_date,
      })), CLIENT_ID).catch(err =>
        console.warn('[sync-orders] product catalogue update failed (non-fatal):', err.message)
      );
    }
  }

  console.log(`[sync-orders] done: ${synced} synced, ${skipped} test orders skipped`);
  return { synced, skipped };
}
