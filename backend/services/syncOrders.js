// services/syncOrders.js
// ─────────────────────────────────────────────────────────────────
// Pulls all Shopify orders into revenue_data via upsert.
// Matches Shopify Admin "All Orders" exactly by using status=any.
// ─────────────────────────────────────────────────────────────────
import { shopifyPaginate } from './shopifyClient.js';
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
  const primarySku = paidItems[0]?.sku || null;
  const primaryName = paidItems[0]?.name || null;

  // Net revenue = total minus any already-processed refunds
  const totalRefunded = (order.refunds || []).reduce((s, r) =>
    s + (r.transactions || []).reduce((ts, t) => ts + parseFloat(t.amount || 0), 0), 0);
  const netRevenue = Math.max(0, parseFloat(order.total_price || 0) - totalRefunded);

  // Map financial_status → standard_status (same logic as fileIngestion.js)
  let standard_status;
  if (finStatus === 'voided' || finStatus === 'refunded') standard_status = 'Cancelled';
  else if (finStatus === 'paid' && order.fulfillment_status === 'fulfilled') standard_status = 'Delivered';
  else if (finStatus === 'paid') standard_status = 'Paid';
  else standard_status = 'Pending';

  // Risk level — Shopify API returns it as order.risk_level (string) on some versions
  const riskLevel = (order.risk_level || '').trim() || null;

  return {
    client_id:          CLIENT_ID,
    platform:           'website',  // All Shopify orders → Website tab in dashboard
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
    risk_level:         riskLevel,
    tags,
    is_duplicate_flag:  tags.includes('DUPLICATE_ORDER'),
    ...utmFields,
    // row_hash — reuse order_id+sku tier (same as fileIngestion.js tier 2)
    row_hash:           `order_id_sku:${order.name}|${primarySku || ''}`,
    dedup_method:       'order_id_sku',
    raw_extras:         {},  // API sync rows have no raw_extras
  };
}

export async function syncShopifyOrders(updatedAtMin = null) {
  if (!CLIENT_ID) throw new Error('SHOPIFY_CLIENT_ID env var not set');

  const params = {
    status: 'any',   // matches Shopify Admin "All Orders" — critical
    fields: [
      'id','name','created_at','financial_status','fulfillment_status',
      'total_price','refunds','line_items','note_attributes','tags',
      'risk_level','shipping_address','billing_address','test',
    ].join(','),
  };
  if (updatedAtMin) params.updated_at_min = updatedAtMin;

  let synced = 0;
  let skipped = 0;

  for await (const batch of shopifyPaginate('/orders.json', params, 'orders')) {
    const rows = [];
    for (const order of batch) {
      if (order.test === true) { skipped++; continue; }  // skip test orders
      rows.push(mapOrder(order));
    }
    if (!rows.length) continue;

    const { error } = await supabaseAdmin
      .from('revenue_data')
      .upsert(rows, { onConflict: 'client_id,row_hash' });

    if (error) console.error('[sync-orders] upsert error:', error.message);
    else synced += rows.length;
  }

  console.log(`[sync-orders] done: ${synced} synced, ${skipped} test orders skipped`);
  return { synced, skipped };
}
