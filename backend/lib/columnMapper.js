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
  'lineitem sku':               'standard_sku',   // Shopify order export

  // Product name/title, captured as its own field regardless of whether
  // a real SKU also exists. Needed for category inference (see
  // inferCategory() below) — a short SKU code alone rarely contains
  // enough signal to guess a product category from.
  'product name':               'standard_product_name',
  'product title':               'standard_product_name',
  'lineitem name':              'standard_product_name',   // Shopify order export (Meta/Instagram Shop) — was missing entirely, root cause of Meta rows showing no product name

  // Note: SKU fallback (using the product name/title as standard_sku
  // when no real SKU column exists) is now handled in normaliseRow()
  // directly from standard_product_name above — see below.

  // ── Revenue / Sales amount ────────────────────────────────────
  'item price':                 'standard_revenue',
  'item-price':                 'standard_revenue',
  'lineitem price':             'standard_revenue',   // Shopify order export
  'selling price per item':     'standard_revenue',   // Flipkart order export
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
  'lineitem quantity':          'standard_units',   // Shopify order export
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
  'ordered on':                 'order_date',   // Flipkart order export
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
  'shipping province':          'standard_state',   // Shopify order export
  'delivery state':             'standard_state',
  'customer state':             'standard_state',
  'ship state/province region': 'standard_state',
  'bill to state':              'standard_state',

  // ── Order status ──────────────────────────────────────────────
  'order status':               'standard_status',
  'order state':                'standard_status',   // Flipkart order export
  'financial status':           'standard_status',   // Shopify order export — paid/pending/refunded/voided
  'item status':                'standard_status',
  'fulfillment status':         'standard_status',
  'delivery status':            'standard_status',
  'shipment status':            'standard_status',
  'status':                     'standard_status',

  // ── Fulfillment channel (Amazon: FBA vs Merchant-fulfilled) ────
  // NOTE: deliberately NOT mapped to standard_status or any platform
  // grouping field. It's a separate dimension — an order can be
  // Amazon-platform + Merchant-fulfilled, or Amazon-platform +
  // FBA-fulfilled. Surfaced in Campaign Insights, not the top-level
  // platform split.
  'fulfillment channel':        'standard_fulfillment_channel',
  'fulfilment channel':         'standard_fulfillment_channel',
  'fulfillment-channel':        'standard_fulfillment_channel',
  'fulfilled-by':               'standard_fulfillment_channel',
};

// ═══════════════════════════════════════════════════════════════════
// CATEGORY INFERENCE
// Ported directly from the old dashboard's CATEGORY_KEYWORDS /
// infer_category() (main.py) so both dashboards classify products into
// the same categories from the same source data. Matching is
// case-insensitive substring search against the product name first,
// falling back to the SKU if the name is blank or unmatched — same
// order and same keyword lists as the original, kept in sync
// deliberately. Extend both together if a new product line is added.
// ═══════════════════════════════════════════════════════════════════
export const CATEGORY_KEYWORDS = [
  ['Castor & Senna Capsules', ['castromix', 'castor & senna', 'castor and senna']],
  ['Castor Oil',              ['castor oil', 'erand oil', 'arandi']],
  ['Coconut Oil',             ['coconut oil']],
  ['Mustard Oil',             ['mustard oil']],
  ['Almond Oil',              ['almond oil', 'badam oil']],
  ['Black Sesame Oil',        ['black sesame', 'til oil']],
  ['Sesame Oil',              ['sesame oil']],
  ['Olive Oil',               ['olive oil']],
  ['Walnut Oil',              ['walnut oil', 'akhrot']],
  ['Pistachio Oil',           ['pistachio oil']],
  ['Wheat Germ Oil',          ['wheat germ']],
  ['Garlic Oil',              ['garlic oil']],
  ['Neem Seed Oil',           ['neem seed oil', 'neem oil']],
  ['Kalonji / Black Seed Oil',['kalonji', 'black seed oil', 'nigella']],
  ['Fenugreek Oil',           ['fenugreek', 'methi']],
  ['Flaxseed Oil',            ['flaxseed', 'flax seed']],
  ['Evening Primrose Oil',    ['evening primrose', 'primrose oil']],
  ['Omega 3-6-9',             ['omega 3-6-9', 'omega-3-6-9', 'omega 3 6 9', 'vegan omega']],
  ['Aloe Vera Gel',           ['aloe vera']],
  ['Rose Water',              ['rose water', 'gulab jal', 'pushkar rose']],
  ['Immunity Booster',        ['immunity booster', 'immunity combo', 'immunty']],
  ['Brahmi Capsules',         ['brahmi']],
  ['Ashwagandha Capsules',    ['ashwagandha']],
  ['Triphala Capsules',       ['triphala']],
  ['Turmeric Capsules',       ['turmeric & a2', 'turmeric oil']],
  ['Hair Care',               ['hair & scalp', 'hairfall rescue', 'hair growth oil', 'kesh amrit',
                                'anti-dandruff', 'overnight hair', 'hair strength']],
  ['Combo / Gift Set',        ['combo', 'bliss box', 'glow aura', 'poshak shakti',
                                'wellness power', 'skin & detox', 'hormonal balance',
                                'gut health', 'active life', 'diy lip']],
];

export const SKU_CATEGORY_KEYWORDS = [
  ['Castor & Senna Capsules', ['cm-b', 'cm-j', 'cm-mb']],
  ['Castor Oil',              ['co-200ml', 'co-500ml', 'co-b-', 'co-pack', 'fba-co', 'nt-castor']],
  ['Coconut Oil',             ['exvrgncocnt']],
  ['Mustard Oil',             ['ylmustoil']],
  ['Almond Oil',              ['almndoil']],
  ['Black Sesame Oil',        ['blksesmoil']],
  ['Walnut Oil',              ['wlntoil']],
  ['Pistachio Oil',           ['pstachoil']],
  ['Wheat Germ Oil',          ['whtgemoil', 'wgo-b']],
  ['Garlic Oil',              ['garlic', 'go-b']],
  ['Neem Seed Oil',           ['neem', 'nso-b']],
  ['Kalonji / Black Seed Oil',['kalnji', 'klo-b']],
  ['Fenugreek Oil',           ['fengrk', 'fo-b']],
  ['Flaxseed Oil',            ['flxseed', 'fso-b']],
  ['Evening Primrose Oil',    ['prmrose', 'pro-b']],
  ['Omega 3-6-9',             ['omega-369']],
  ['Aloe Vera Gel',           ['aloevera', 'ag-t']],
  ['Rose Water',              ['prw-']],
  ['Immunity Booster',        ['immunty', 'imb-b', 'ib-tg']],
];

export function inferCategory(productName, sku) {
  const nameLower = (productName || '').toLowerCase();
  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some(kw => nameLower.includes(kw))) return category;
  }
  const skuLower = (sku || '').toLowerCase();
  for (const [category, keywords] of SKU_CATEGORY_KEYWORDS) {
    if (keywords.some(kw => skuLower.includes(kw))) return category;
  }
  return 'Uncategorized';
}


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
  'reporting starts':           'campaign_date',   // Meta ads export
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
  'estimated budget consumed':  'standard_spend',   // Blinkit ads export

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
  'total revenue':              'standard_revenue',   // Flipkart ads export
  'conversion value':           'standard_revenue',
  'conv. value':                'standard_revenue',   // Google Ads export
  'website purchases value':    'standard_revenue',
  'direct sales':               'standard_revenue',   // Blinkit ads export

  // ── Impressions ───────────────────────────────────────────────
  'impressions':                'standard_impressions',
  'total impressions':          'standard_impressions',
  'ad impressions':             'standard_impressions',
  'impr.':                      'standard_impressions',   // Google Ads export

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
// KEY RESOLUTION
//
// Normalises a raw column header and looks it up in a map. Tries an
// exact match first; if that fails, strips a trailing parenthetical
// (e.g. "(₹)", "(INR)", "(#)", "(return on ad spend)") and retries.
// This lets one entry like '7 day total sales' also match
// '7 Day Total Sales (₹)', 'Amount spent (INR)' match 'amount spent',
// etc., without hardcoding every currency/unit suffix variant.
// ═══════════════════════════════════════════════════════════════════
export function normaliseHeaderKey(rawKey) {
  return String(rawKey).toLowerCase().trim().replace(/\s+/g, ' ').replace(/-/g, ' ');
}

function resolveKey(map, rawKey) {
  const normKey = normaliseHeaderKey(rawKey);
  if (map[normKey]) return map[normKey];

  const stripped = normKey.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (stripped !== normKey && map[stripped]) return map[stripped];

  return null;
}

// ═══════════════════════════════════════════════════════════════════
// DATA-TYPE CLASSIFICATION
//
// Filenames tell us the intended platform + data type, but a
// mislabeled or misnamed file (wrong prefix, wrong extension, a
// campaign export saved with a revenue-sounding name, etc.) can slip
// through. This scores a header row against both REVENUE_MAP and
// CAMPAIGN_MAP and returns whichever the columns actually look like,
// so ingestion can flag — or self-correct — a mismatch instead of
// silently ingesting a campaign report as revenue data or vice versa.
// ═══════════════════════════════════════════════════════════════════
export function scoreHeaderRow(headers) {
  let revenueHits = 0, campaignHits = 0;
  for (const h of headers) {
    if (resolveKey(REVENUE_MAP, h))  revenueHits++;
    if (resolveKey(CAMPAIGN_MAP, h)) campaignHits++;
  }
  return { revenueHits, campaignHits, total: revenueHits + campaignHits };
}

export function classifyDataType(headers) {
  const { revenueHits, campaignHits } = scoreHeaderRow(headers);
  // Revenue files always carry a SKU-like column; campaign files never do.
  // That single signal is the most reliable tie-breaker we have.
  const hasSkuLikeColumn = headers.some((h) => resolveKey(REVENUE_MAP, h) === 'standard_sku');

  if (revenueHits === 0 && campaignHits === 0) return null; // can't tell — let filename decide
  if (hasSkuLikeColumn && revenueHits >= campaignHits) return 'revenue';
  if (campaignHits > revenueHits) return 'campaign';
  if (revenueHits > campaignHits) return 'revenue';
  return null; // genuine tie — let filename decide
}

// ═══════════════════════════════════════════════════════════════════
// IDENTITY FIELDS  (for cancellation / fraud-pattern detection)
//
// Buyer name, phone, and address aren't part of the standard revenue
// schema, so they're never dropped — they already land in raw_extras
// via normaliseRow's "unmapped column" path. This map just tells the
// fraud-pattern detector which raw_extras keys, across the platforms
// that expose this data at all, to look for. Amazon/Acutas reports
// never include buyer PII (Amazon withholds it from sellers), so
// there's intentionally no entry for those here.
// ═══════════════════════════════════════════════════════════════════
export const IDENTITY_KEYS = {
  phone: [
    'Phone', 'Billing Phone', 'Shipping Phone', 'Buyer Phone',
    'Customer Phone', 'Mobile', 'Mobile Number', 'Contact Number',
  ],
  name: [
    'Billing Name', 'Shipping Name', 'Buyer name', 'Ship to name',
    'Customer Name', 'Name',
  ],
  address: [
    'Billing Street', 'Shipping Street', 'Address Line 1', 'Billing Address1',
    'Shipping Address1', 'Address',
  ],
  pincode: [
    'Billing Zip', 'Shipping Zip', 'PIN Code', 'Postal Code', 'Zip', 'Pincode',
  ],
};

// Pulls whatever identity signals are present in a row's raw_extras,
// trying each known variant for that platform. Returns nulls for
// anything not present (e.g. always null for Amazon/Acutas).
export function extractIdentity(rawExtras) {
  const pick = (keys, validate) => {
    for (const k of keys) {
      const v = rawExtras[k];
      if (v === undefined || v === '' || v === null) continue;
      const str = String(v).trim();
      if (validate && !validate(str)) continue; // looks corrupted — try the next column
      return str;
    }
    return null;
  };

  // Spreadsheet tools sometimes mangle long numeric strings (like phone
  // numbers) into scientific notation before we ever see the file, e.g.
  // "9.19913E+11" instead of "919913xxxxx" — precision is already lost
  // at that point, so treat it as unusable and prefer another column
  // (Billing/Shipping Phone) rather than a shorter, wrong set of digits.
  const isUsablePhone = (v) => !/e\+/i.test(v) && v.replace(/\D/g, '').length >= 7;

  return {
    phone:   pick(IDENTITY_KEYS.phone, isUsablePhone),
    name:    pick(IDENTITY_KEYS.name),
    address: pick(IDENTITY_KEYS.address),
    pincode: pick(IDENTITY_KEYS.pincode),
  };
}


// ═══════════════════════════════════════════════════════════════════
// ORDER ID  (for backfilling missing city/state within the same order)
//
// Some exports repeat an order's shipping details on every line item
// row but leave them blank on later rows (or vice versa) — e.g. a
// multi-item order where only the first row carries the city/state.
// This lets us group rows by order and fill in a blank city/state
// from a sibling row of the same order that does have it.
// ═══════════════════════════════════════════════════════════════════
const ORDER_ID_KEYS = [
  'Order Id', 'Order ID', 'order id', 'Order Number', 'ORDER ITEM ID',
  'amazon-order-id', 'merchant-order-id', 'Name', 'Id',
];

export function extractOrderId(rawExtras) {
  if (!rawExtras) return null;
  for (const k of ORDER_ID_KEYS) {
    const v = rawExtras[k];
    if (v !== undefined && v !== '' && v !== null) return String(v).trim();
  }
  return null;
}

// Groups rows by platform+orderId and fills in a blank standard_city /
// standard_state from a sibling row of the same order that has one.
// Mutates and returns the same array.
export function backfillLocationByOrder(rows) {
  const groups = new Map();
  for (const r of rows) {
    const orderId = extractOrderId(r.raw_extras);
    if (!orderId) continue;
    const key = r.platform + '|' + orderId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const knownCity  = group.find((r) => r.standard_city)?.standard_city  || null;
    const knownState = group.find((r) => r.standard_state)?.standard_state || null;
    if (!knownCity && !knownState) continue;
    for (const r of group) {
      if (!r.standard_city  && knownCity)  r.standard_city  = knownCity;
      if (!r.standard_state && knownState) r.standard_state = knownState;
    }
  }
  return rows;
}


// ═══════════════════════════════════════════════════════════════════
// STATE NAME NORMALISATION
//
// Different platforms/files represent Indian states differently —
// abbreviations ("MH", "TS"), inconsistent casing ("KARNATAKA",
// "uttar pradesh"), or full names. Left unnormalised, this fragments
// a single state into several rows in any breakdown table and breaks
// zone (North/South/East/West) classification, which only recognises
// one canonical spelling. This maps every common variant to one
// canonical, human-readable name.
// ═══════════════════════════════════════════════════════════════════
const INDIA_STATE_MAP = {
  // Abbreviations
  AP: 'Andhra Pradesh', AR: 'Arunachal Pradesh', AS: 'Assam', BR: 'Bihar',
  CG: 'Chhattisgarh', CT: 'Chhattisgarh', GA: 'Goa', GJ: 'Gujarat',
  HR: 'Haryana', HP: 'Himachal Pradesh', JH: 'Jharkhand', KA: 'Karnataka',
  KL: 'Kerala', MP: 'Madhya Pradesh', MH: 'Maharashtra', MN: 'Manipur',
  ML: 'Meghalaya', MZ: 'Mizoram', NL: 'Nagaland', OD: 'Odisha', OR: 'Odisha',
  PB: 'Punjab', RJ: 'Rajasthan', SK: 'Sikkim', TN: 'Tamil Nadu',
  TS: 'Telangana', TG: 'Telangana', TR: 'Tripura', UP: 'Uttar Pradesh',
  UK: 'Uttarakhand', UT: 'Uttarakhand', WB: 'West Bengal', DL: 'Delhi',
  JK: 'Jammu and Kashmir', LA: 'Ladakh', PY: 'Puducherry', CH: 'Chandigarh',
  AN: 'Andaman and Nicobar Islands', LD: 'Lakshadweep',
  DN: 'Dadra and Nagar Haveli and Daman and Diu',
  DD: 'Dadra and Nagar Haveli and Daman and Diu',

  // Full names (any casing) → canonical spelling
  'ANDHRA PRADESH': 'Andhra Pradesh', 'ARUNACHAL PRADESH': 'Arunachal Pradesh',
  ASSAM: 'Assam', BIHAR: 'Bihar', CHHATTISGARH: 'Chhattisgarh', GOA: 'Goa',
  GUJARAT: 'Gujarat', HARYANA: 'Haryana', 'HIMACHAL PRADESH': 'Himachal Pradesh',
  JHARKHAND: 'Jharkhand', KARNATAKA: 'Karnataka', KERALA: 'Kerala',
  'MADHYA PRADESH': 'Madhya Pradesh', MAHARASHTRA: 'Maharashtra', MANIPUR: 'Manipur',
  MEGHALAYA: 'Meghalaya', MIZORAM: 'Mizoram', NAGALAND: 'Nagaland', ODISHA: 'Odisha',
  ORISSA: 'Odisha', PUNJAB: 'Punjab', RAJASTHAN: 'Rajasthan', SIKKIM: 'Sikkim',
  'TAMIL NADU': 'Tamil Nadu', TAMILNADU: 'Tamil Nadu', TELANGANA: 'Telangana',
  TRIPURA: 'Tripura', 'UTTAR PRADESH': 'Uttar Pradesh', UTTARAKHAND: 'Uttarakhand',
  UTTARANCHAL: 'Uttarakhand', 'WEST BENGAL': 'West Bengal', DELHI: 'Delhi',
  'NEW DELHI': 'Delhi', 'JAMMU AND KASHMIR': 'Jammu and Kashmir',
  'JAMMU & KASHMIR': 'Jammu and Kashmir', LADAKH: 'Ladakh', PUDUCHERRY: 'Puducherry',
  PONDICHERRY: 'Puducherry', CHANDIGARH: 'Chandigarh',
};

export function normaliseStateName(raw) {
  if (!raw) return raw;
  const key = String(raw).trim().toUpperCase();
  return INDIA_STATE_MAP[key] || String(raw).trim();
}



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
    const target = resolveKey(map, rawKey);

    if (target) {
      // Don't overwrite if already set by a higher-priority column
      if (standardFields[target] === undefined) {
        standardFields[target] = coerceValue(target, rawValue);
      }
    } else {
      // Unmapped column — store in raw_extras for AI insight generator
      // (this is also where buyer name/phone/address live — see
      // extractIdentity() above)
      rawExtras[rawKey] = rawValue;
    }
  }

  // SKU fallback: only when this row had no real SKU/ASIN/item-id column
  // at all, fall back to the product name/title (now captured separately
  // as standard_product_name above) — so a long descriptive title never
  // wins over an actual short SKU just because of column order, but is
  // still available as a last resort when no real SKU exists.
  if (map === REVENUE_MAP && standardFields.standard_sku === undefined && standardFields.standard_product_name !== undefined) {
    standardFields.standard_sku = standardFields.standard_product_name;
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
export function normaliseBatch(rawRows, map, { clientId, platform, uploadId, defaultDate } = {}) {
  const rows = [];
  let skipped = 0;
  const dateField = map === REVENUE_MAP ? 'order_date' : 'campaign_date';

  for (const rawRow of rawRows) {
    const { standardFields, rawExtras } = normaliseRow(rawRow, map);

    // Some reports (e.g. Google Ads) have one date range for the whole
    // file rather than a per-row date column — fall back to it here.
    if (!standardFields[dateField] && defaultDate) {
      standardFields[dateField] = defaultDate;
    }

    // Skip rows with no identifiable revenue or SKU at all (i.e. the
    // columns genuinely weren't present/mapped — not just zero-valued,
    // since a paused campaign can legitimately have ₹0 spend for a day
    // and that's still a real data point, not something to drop).
    const isRevenueBatch = map === REVENUE_MAP;
    if (isRevenueBatch) {
      if (standardFields.standard_revenue == null && standardFields.standard_units == null) {
        skipped++;
        continue;
      }
    } else {
      if (standardFields.standard_spend == null && standardFields.standard_revenue == null) {
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

  if (targetField === 'standard_state') {
    return normaliseStateName(String(raw).trim());
  }

  return String(raw).trim();
}
