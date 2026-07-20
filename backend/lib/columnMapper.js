// lib/columnMapper.js
// ─────────────────────────────────────────────────────────────────
// COLUMN NORMALISATION ENGINE
//
// Problem: every platform exports different column names for the
// same concept. Amazon calls it "ASIN", Flipkart calls it "SKU ID",
// Blinkit has no SKU column at all (uses "Product Name").
//
// Solution: a two-layer dictionary.
//   Layer 1 — REVENUE_MAP / CAMPAIGN_MAP
//     Maps every known raw column variant → standard target field.
//   Layer 2 — normaliseRow()
//     Applies the map, collects unmapped columns into raw_extras.
//
// Adding a new platform / new column variant is a one-line change
// in the map — no logic changes needed.
// ─────────────────────────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════
// REVENUE MAP
// key   = raw column header (lowercased + trimmed for matching)
// value = standard target field name
// ═══════════════════════════════════════════════════════════════════
export const REVENUE_MAP = {

  // ── SKU / Product identifier ──────────────────────────────────
  'asin':                       'standard_sku',
  'asin/isbn':                  'standard_sku',
  'sku':                        'standard_sku',
  'sku id':                     'standard_sku',
  'sku id':                     'standard_sku',
  'sku_id':                     'standard_sku',
  'seller sku':                 'standard_sku',
  'merchant sku':               'standard_sku',
  'product sku':                'standard_sku',
  'item sku':                   'standard_sku',
  'item id':                    'standard_sku',
  'listing id':                 'standard_sku',
  'product id':                 'standard_sku',
  'product name':               'standard_sku',   // Blinkit fallback
  'product title':              'standard_sku',

  // ── Revenue / Sales amount ────────────────────────────────────
  'item price':                 'standard_revenue',
  'item-price':                 'standard_revenue',
  'net revenue':                'standard_revenue',
  'net sale value':             'standard_revenue',
  'sale amount':                'standard_revenue',
  'sales amount':               'standard_revenue',
  'total revenue':              'standard_revenue',
  'total sales':                'standard_revenue',
  'gross revenue':              'standard_revenue',
  'revenue':                    'standard_revenue',
  'selling price':              'standard_revenue',
  'effective selling price':    'standard_revenue',
  'net paid':                   'standard_revenue',
  'amount':                     'standard_revenue',
  'order revenue':              'standard_revenue',
  'product amount':             'standard_revenue',
  'ordered product sales':      'standard_revenue',
  'total order revenue':        'standard_revenue',

  // ── Units / Quantity ──────────────────────────────────────────
  'quantity':                   'standard_units',
  'quantity-purchased':         'standard_units',
  'units':                      'standard_units',
  'units sold':                 'standard_units',
  'units ordered':              'standard_units',
  'qty':                        'standard_units',
  'qty sold':                   'standard_units',
  'no. of units':               'standard_units',
  'number of units':            'standard_units',
  'item quantity':              'standard_units',
  'order quantity':             'standard_units',
  'fulfilled quantity':         'standard_units',
  'shipped quantity':           'standard_units',
  'dispatched quantity':        'standard_units',

  // ── Order date ────────────────────────────────────────────────
  'date':                       'order_date',
  'order date':                 'order_date',
  'purchase date':              'order_date',
  'purchase-date':              'order_date',
  'transaction date':           'order_date',
  'shipment date':              'order_date',
  'dispatch date':              'order_date',
  'delivery date':              'order_date',
  'fulfilment date':            'order_date',
  'fulfillment date':           'order_date',
  'created date':               'order_date',
  'created at':                 'order_date',
  'placed date':                'order_date',
  'invoice date':               'order_date',

  // ── City ──────────────────────────────────────────────────────
  'city':                       'standard_city',
  'ship city':                  'standard_city',
  'ship-city':                  'standard_city',
  'buyer city':                 'standard_city',
  'shipping city':              'standard_city',
  'delivery city':              'standard_city',
  'customer city':              'standard_city',
  'bill to city':               'standard_city',

  // ── State ─────────────────────────────────────────────────────
  'state':                      'standard_state',
  'ship state':                 'standard_state',
  'ship-state':                 'standard_state',
  'buyer state':                'standard_state',
  'shipping state':             'standard_state',
  'delivery state':             'standard_state',
  'customer state':             'standard_state',
  'ship state/province region': 'standard_state',
  'bill to state':              'standard_state',

  // ── Order status ──────────────────────────────────────────────
  'order status':               'standard_status',
  'item status':                'standard_status',
  'fulfillment status':         'standard_status',
  'delivery status':            'standard_status',
  'shipment status':            'standard_status',
  'status':                     'standard_status',
};


// ═══════════════════════════════════════════════════════════════════
// CAMPAIGN MAP
// ═══════════════════════════════════════════════════════════════════
export const CAMPAIGN_MAP = {

  // ── Campaign name ─────────────────────────────────────────────
  'campaign name':              'campaign_name',
  'campaign':                   'campaign_name',
  'ad campaign name':           'campaign_name',
  'campaign title':             'campaign_name',
  'ad name':                    'campaign_name',
  'ad set name':                'campaign_name',
  'adgroup name':               'campaign_name',
  'ad group name':              'campaign_name',

  // ── Campaign date ─────────────────────────────────────────────
  'date':                       'campaign_date',
  'report date':                'campaign_date',
  'campaign date':              'campaign_date',
  'start date':                 'campaign_date',
  'day':                        'campaign_date',

  // ── Ad spend ──────────────────────────────────────────────────
  'spend':                      'standard_spend',
  'ad spend':                   'standard_spend',
  'amount spent':               'standard_spend',
  'cost':                       'standard_spend',
  'total cost':                 'standard_spend',
  'total spend':                'standard_spend',
  'attributed spend':           'standard_spend',
  'ad cost':                    'standard_spend',
  'billing amount':             'standard_spend',
  'total attributed spend':     'standard_spend',

  // ── Campaign revenue ─────────────────────────────────────────
  'revenue':                    'standard_revenue',
  'sales':                      'standard_revenue',
  'attributed sales':           'standard_revenue',
  'total attributed sales':     'standard_revenue',
  '14 day total sales':         'standard_revenue',
  '7 day total sales':          'standard_revenue',
  'purchase value':             'standard_revenue',
  'purchase roas':              'standard_revenue',   // Meta uses this key
  'campaign revenue':           'standard_revenue',
  'conversion value':           'standard_revenue',
  'website purchases value':    'standard_revenue',

  // ── Impressions ───────────────────────────────────────────────
  'impressions':                'standard_impressions',
  'total impressions':          'standard_impressions',
  'ad impressions':             'standard_impressions',

  // ── Clicks ────────────────────────────────────────────────────
  'clicks':                     'standard_clicks',
  'total clicks':               'standard_clicks',
  'link clicks':                'standard_clicks',
  'ad clicks':                  'standard_clicks',

  // ── Orders ────────────────────────────────────────────────────
  'orders':                     'standard_orders',
  'total orders':               'standard_orders',
  '14 day total orders':        'standard_orders',
  '7 day total orders':         'standard_orders',
  'purchases':                  'standard_orders',
  'website purchases':          'standard_orders',
  'conversions':                'standard_orders',
  'attributed conversions':     'standard_orders',
};


// ═══════════════════════════════════════════════════════════════════
// NORMALISE ROW
//
// Takes one raw data row object (keys = column headers as-received)
// and a map (REVENUE_MAP or CAMPAIGN_MAP).
//
// Returns:
//   standardFields — { standard_sku, standard_revenue, ... }
//   rawExtras      — { any columns that had no match in the map }
//
// Usage:
//   const { standardFields, rawExtras } = normaliseRow(rawRow, REVENUE_MAP);
// ═══════════════════════════════════════════════════════════════════
export function normaliseRow(rawRow, map) {
  const standardFields = {};
  const rawExtras = {};

  for (const [rawKey, rawValue] of Object.entries(rawRow)) {
    // Normalise the column header: lowercase, collapse whitespace, trim
    // Normalise: lowercase, trim, collapse whitespace, also try hyphen variant
    const normKey = rawKey.toLowerCase().trim().replace(/\s+/g, ' ').replace(/-/g, ' ');

    if (map[normKey]) {
      const target = map[normKey];
      // Don't overwrite if already set by a higher-priority column
      if (standardFields[target] === undefined) {
        standardFields[target] = coerceValue(target, rawValue);
      }
    } else {
      // Unmapped column — store in raw_extras for AI insight generator
      rawExtras[rawKey] = rawValue;
    }
  }

  return { standardFields, rawExtras };
}


// ═══════════════════════════════════════════════════════════════════
// NORMALISE BATCH
//
// Processes an array of raw rows and returns two arrays ready for
// bulk-insert into revenue_data or campaign_data.
//
// Returns:
//   { rows: Array<normalised_record>, skipped: number }
// ═══════════════════════════════════════════════════════════════════
export function normaliseBatch(rawRows, map, { clientId, platform, uploadId } = {}) {
  const rows = [];
  let skipped = 0;

  for (const rawRow of rawRows) {
    const { standardFields, rawExtras } = normaliseRow(rawRow, map);

    // Skip rows with no identifiable revenue or SKU
    const isRevenueBatch = map === REVENUE_MAP;
    if (isRevenueBatch) {
      if (!standardFields.standard_revenue && !standardFields.standard_units) {
        skipped++;
        continue;
      }
    } else {
      if (!standardFields.standard_spend && !standardFields.standard_revenue) {
        skipped++;
        continue;
      }
    }

    rows.push({
      client_id:  clientId,
      platform:   platform,
      upload_id:  uploadId,
      ...standardFields,
      raw_extras: rawExtras,
    });
  }

  return { rows, skipped };
}


// ═══════════════════════════════════════════════════════════════════
// VALUE COERCION
// ═══════════════════════════════════════════════════════════════════
function coerceValue(targetField, raw) {
  if (raw === null || raw === undefined || raw === '') return null;

  const numericFields = [
    'standard_revenue', 'standard_units', 'standard_spend',
    'standard_impressions', 'standard_clicks', 'standard_orders',
  ];
  const dateFields = ['order_date', 'campaign_date'];

  if (numericFields.includes(targetField)) {
    // Strip currency symbols and commas before parsing
    const cleaned = String(raw).replace(/[₹$,\s]/g, '');
    const num = Number(cleaned);
    return isNaN(num) ? null : num;
  }

  if (dateFields.includes(targetField)) {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
  }

  return String(raw).trim();
}
