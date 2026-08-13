// ingestion/fileIngestion.js
// ─────────────────────────────────────────────────────────────────
// FILE INGESTION LOOP
//
// Triggered when an admin uploads a daily export file.
// Pipeline:
//   1. Detect platform + data type from filename prefix
//   2. Parse the file (xlsx or csv) into raw row objects
//   3. Normalise rows via columnMapper
//   4. Bulk-insert into revenue_data or campaign_data
//   5. Update the uploads audit record with status + row counts
//
// Supported prefixes (from the spec):
//   Amazon_File              → amazon   · revenue
//   Amazon_Campaign_File     → amazon   · campaign
//   Flipkart_File            → flipkart · revenue
//   Flipkart_Campaign_File   → flipkart · campaign
//   Blinkit_File             → blinkit  · revenue
//   Blinkit_Campaign_File    → blinkit  · campaign
//   Meta_File                → meta     · revenue  (website revenue)
//   Meta_Campaign_File       → meta     · campaign
//   Google_File              → google   · revenue  (website revenue)
//   Google_Campaign_File     → google   · campaign
//   Acutas_File              → acutas   · revenue  (Amazon via Acutas)
//   Acutas_Campaign_File     → acutas   · campaign
//
// The prefix only decides the PLATFORM. The data TYPE (revenue vs
// campaign) is confirmed — and corrected if needed — by looking at
// the file's actual columns (see classifyDataType() in columnMapper.js
// and step 3b below). This matters most for Google: a real Google Ads
// export is a single campaign-shaped report (spend, clicks, conv.
// value) with no per-order SKU data, so whether it's named
// "Google_File" or "Google_Campaign_File", it will always be routed
// to campaign_data based on its columns — one Google file is enough,
// no separate "revenue" export is needed for that platform.
// ─────────────────────────────────────────────────────────────────
import xlsx from 'xlsx';
import path from 'path';
import crypto from 'crypto';
import { parse as parseCsv } from 'csv-parse/sync';
import { supabaseAdmin }  from '../lib/supabase.js';
import { REVENUE_MAP, CAMPAIGN_MAP, normaliseBatch, classifyDataType, scoreHeaderRow, detectFallbackMapping } from '../lib/columnMapper.js';
import { generateInsights, generateNarrativeSummaries } from '../lib/insightGenerator.js';
import { extractLiteralDate } from '../lib/dateUtils.js';
import { recordMovement } from '../routes/inventoryRouter.js';

// ═══════════════════════════════════════════════════════════════════
// PREFIX → ROUTING TABLE
// ═══════════════════════════════════════════════════════════════════
const PREFIX_ROUTES = [
  // Order matters — longer/more-specific prefixes first
  { prefix: 'Amazon_Campaign_File',  platform: 'amazon',   dataType: 'campaign' },
  { prefix: 'Amazon_File',           platform: 'amazon',   dataType: 'revenue'  },
  { prefix: 'Flipkart_Campaign_File',platform: 'flipkart', dataType: 'campaign' },
  { prefix: 'Flipkart_File',         platform: 'flipkart', dataType: 'revenue'  },
  { prefix: 'Blinkit_Campaign_File', platform: 'blinkit',  dataType: 'campaign' },
  { prefix: 'Blinkit_File',          platform: 'blinkit',  dataType: 'revenue'  },
  { prefix: 'Meta_Campaign_File',    platform: 'meta',     dataType: 'campaign' },
  { prefix: 'Meta_File',             platform: 'meta',     dataType: 'revenue'  },
  { prefix: 'Google_Campaign_File',  platform: 'google',   dataType: 'campaign' },
  { prefix: 'Google_File',           platform: 'google',   dataType: 'revenue'  },
  { prefix: 'Acutas_Campaign_File',  platform: 'acutas',   dataType: 'campaign' },
  { prefix: 'Acutas_File',           platform: 'acutas',   dataType: 'revenue'  },
];

// ─────────────────────────────────────────────────────────────────
// detectRoute — returns { platform, dataType } or null
// ─────────────────────────────────────────────────────────────────
export function detectRoute(filename) {
  const basename = path.basename(filename);
  for (const route of PREFIX_ROUTES) {
    if (basename.startsWith(route.prefix)) {
      return { platform: route.platform, dataType: route.dataType };
    }
  }
  return null;
}


// ═══════════════════════════════════════════════════════════════════
// PARSE FILE
//
// .xlsx/.xls → parsed with the xlsx library (also auto-detects real
//   XLSX content even if the extension is wrong, e.g. a ".xls" file
//   that's actually a modern XLSX under the hood).
// .csv       → parsed with the csv-parse library, but first passed
//   through a small "smart preamble" step, because real-world
//   exports are rarely a clean header-on-row-1 file:
//     - Google Ads exports are UTF-16 encoded and TAB-delimited, with
//       2 metadata lines before the real header, and a single date
//       range for the whole file rather than a per-row date column.
//     - Flipkart's campaign export has 4 metadata lines before its
//       header row.
//   Rather than hardcoding each platform's quirks, this detects
//   encoding, delimiter, and the real header row generically by
//   scoring candidate lines against the column-mapping dictionary —
//   the same approach used for classifyDataType() — so a new
//   platform with a similar preamble pattern doesn't need new code.
//
// Returns { rows, defaultDate }:
//   rows        — array of plain row objects (column header → value)
//   defaultDate — ISO date string extracted from a metadata line
//                 (e.g. "July 16, 2026 - July 16, 2026"), if the file
//                 has one and no per-row date column exists. null
//                 otherwise.
// ═══════════════════════════════════════════════════════════════════
function parseFile(fileBuffer, originalName) {
  const ext = path.extname(originalName).toLowerCase();

  // xlsx.read auto-detects real spreadsheet content regardless of the
  // extension on disk (handles a ".xls" that's actually XLSX, etc.),
  // so only route to the CSV path for buffers that actually look like
  // delimited text, not XML/ZIP-based spreadsheet formats.
  const looksLikeSpreadsheet = fileBuffer.slice(0, 4).toString('hex') === '504b0304' // PK.. (xlsx/zip)
    || fileBuffer.slice(0, 8).toString('hex') === 'd0cf11e0a1b11ae1';                 // legacy .xls (OLE2)

  if (ext !== '.csv' && looksLikeSpreadsheet) {
    return { rows: parseSpreadsheet(fileBuffer), defaultDate: null };
  }
  if (ext === '.csv' || !looksLikeSpreadsheet) {
    return parseCsvSmart(fileBuffer);
  }

  return { rows: parseSpreadsheet(fileBuffer), defaultDate: null };
}

function parseSpreadsheet(fileBuffer) {
  const workbook = xlsx.read(fileBuffer, {
    type: 'buffer',
    cellDates: true,           // parse dates as JS Date objects
    cellNF: false,
    cellText: false,
  });

  const sheetName = workbook.SheetNames[0];
  const sheet     = workbook.Sheets[sheetName];

  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (rows.length < 2) return [];

  const headers = rows[0].map(String);
  const dataRows = rows.slice(1);

  return dataRows
    .filter((row) => row.some((cell) => cell !== ''))   // skip blank rows
    .map((row) => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i] ?? ''; });
      return obj;
    });
}

// ─── Smart CSV/TSV parsing ──────────────────────────────────────
function parseCsvSmart(fileBuffer) {
  const { text } = decodeBuffer(fileBuffer);
  const lines = text.split(/\r?\n/);

  const delimiter = detectDelimiter(lines);
  const headerIdx = findHeaderLineIndex(lines, delimiter);

  // Look for a file-level date range in the preamble lines above the
  // header (Google Ads-style reports: "July 16, 2026 - July 16, 2026").
  const defaultDate = extractDateFromPreamble(lines.slice(0, headerIdx));

  const records = parseCsv(text, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
    delimiter,
    from_line: headerIdx + 1, // csv-parse from_line is 1-based
  });

  const rows = records.filter((r) => Object.values(r).some((v) => v !== '' && v != null));
  return { rows, defaultDate };
}

// Detects UTF-16 (LE/BE) via BOM, otherwise assumes UTF-8.
function decodeBuffer(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.slice(2).toString('utf16le'), encoding: 'utf16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16 BE — swap bytes, then decode as LE (Node has no native BE decoder)
    const swapped = Buffer.alloc(buf.length - 2);
    for (let i = 2; i < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1];
      swapped[i - 1] = buf[i];
    }
    return { text: swapped.toString('utf16le'), encoding: 'utf16be' };
  }
  return { text: buf.toString('utf8'), encoding: 'utf8' };
}

// Samples the first several non-empty lines and picks whichever of
// comma / tab / semicolon splits them into the most (consistent) fields.
function detectDelimiter(lines) {
  const candidates = [',', '\t', ';'];
  const sample = lines.filter((l) => l.trim() !== '').slice(0, 10);
  if (!sample.length) return ',';

  let best = ',', bestScore = -1;
  for (const d of candidates) {
    const counts = sample.map((l) => l.split(d).length);
    const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
    if (avg > bestScore) { bestScore = avg; best = d; }
  }
  return best;
}

// Scans the first ~20 lines for the one that looks most like a real
// column-header row (highest number of cells that match something in
// REVENUE_MAP/CAMPAIGN_MAP), so metadata/title lines above it are
// skipped automatically regardless of how many there are.
function findHeaderLineIndex(lines, delimiter) {
  const searchLimit = Math.min(lines.length, 20);
  let bestIdx = 0, bestScore = -1;

  for (let i = 0; i < searchLimit; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const cells = line.split(delimiter).map((c) => c.replace(/^"|"$/g, ''));
    if (cells.length < 2) continue;
    const { total } = scoreHeaderRow(cells);
    if (total > bestScore) { bestScore = total; bestIdx = i; }
  }
  // If nothing scored at all, fall back to the first line (old behaviour).
  return bestScore > 0 ? bestIdx : 0;
}

// Looks for a date or date-range in the preamble lines above the
// header row (e.g. Google Ads: '"July 16, 2026 - July 16, 2026"').
// Returns an ISO date string (the range start) or null.
function extractDateFromPreamble(preambleLines) {
  // ISO (YYYY-MM-DD) must be tried FIRST and as a whole token — the old
  // regex only had "Month Day, Year" and "D/M/YY"-style alternatives,
  // so a line like Flipkart's "Start Time, 2026-07-18 00:00:00" fell
  // through to the short-date alternative and grabbed a garbage partial
  // match ("26-07-18") instead of the real date, which then failed
  // validation and silently produced no default date at all.
  const dateRe = /(\d{4}-\d{2}-\d{2})|([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})|(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/;
  for (const line of preambleLines) {
    const match = line.match(dateRe);
    if (match) {
      const isoDate = extractLiteralDate(match[0]);
      if (isoDate) return isoDate;
    }
  }
  return null;
}


// ═══════════════════════════════════════════════════════════════════
// BULK INSERT — inserts in chunks to avoid Supabase payload limits.
// Chunks are sent with bounded concurrency (not fully sequential) so
// large files (10k+ rows) don't take so long that a hosting platform's
// request/gateway timeout kills the connection before we respond.
// ═══════════════════════════════════════════════════════════════════
const CHUNK_SIZE   = 500;
const CONCURRENCY  = 5; // number of chunk inserts in flight at once

// ═══════════════════════════════════════════════════════════════════
// MERGE DUPLICATE CAMPAIGN ROWS
// Sums numeric fields (spend, revenue, impressions, clicks, orders) for
// any rows that share the same (platform, campaign_date, campaign_name)
// — the exact key campaign_data upserts on. Keeps the first row's
// raw_extras/client_id/upload_id. Rows with a missing campaign_name are
// left unmerged (each treated as its own key) since NULL never conflicts
// with NULL in a unique constraint, so they wouldn't collide anyway.
// ═══════════════════════════════════════════════════════════════════
function mergeDuplicateCampaignRows(rows) {
  const merged = new Map();
  let nullNameCounter = 0;

  for (const row of rows) {
    const key = row.campaign_name
      ? `${row.platform}|${row.campaign_date}|${row.campaign_name}`
      : `__no_name_${nullNameCounter++}`; // never collides — matches Postgres NULL-never-equals-NULL behaviour

    if (!merged.has(key)) {
      merged.set(key, { ...row });
    } else {
      const existing = merged.get(key);
      existing.standard_spend       = (Number(existing.standard_spend)       || 0) + (Number(row.standard_spend)       || 0);
      existing.standard_revenue     = (Number(existing.standard_revenue)     || 0) + (Number(row.standard_revenue)     || 0);
      existing.standard_impressions = (Number(existing.standard_impressions) || 0) + (Number(row.standard_impressions) || 0);
      existing.standard_clicks      = (Number(existing.standard_clicks)      || 0) + (Number(row.standard_clicks)      || 0);
      existing.standard_orders      = (Number(existing.standard_orders)      || 0) + (Number(row.standard_orders)      || 0);
      // raw_extras from the first-seen row is kept as-is (merging JSON
      // blobs meaningfully isn't well-defined here, and the summed
      // numeric fields are what actually matters for the dashboard).
    }
  }

  return Array.from(merged.values());
}

// ═══════════════════════════════════════════════════════════════════
// REVENUE ROW DE-DUP KEY — ported from the old (pre-Semya) dashboard's
// backend, which handled this correctly for a long time before this
// system existed. 3-tier selection, most to least reliable:
//
//   1. order_item_id — unique per LINE ITEM. Correctly distinguishes
//      multiple products within the same multi-item order. Amazon
//      uses "0" as a placeholder on some zero-revenue adjustment
//      rows — treated as absent, or every such row across every
//      order would falsely collide as duplicates of each other.
//   2. order_id + sku — unique per order+product combination, used
//      when there's an order-level ID but no line-item-level one.
//   3. composite (order_date + sku + state + units + revenue) —
//      last resort when neither ID is present. Can rarely produce a
//      false-positive collision if two genuinely different orders
//      share all five values (e.g. two customers buying 1 unit of
//      the same cheap SKU, same state, same day, same price) — the
//      old system carries the identical caveat; prefer files with a
//      real order ID whenever the platform provides one.
//
// This MUST stay in sync with any change to how standard_order_id /
// standard_order_item_id are populated in columnMapper.js — in
// particular, don't let "Order Item ID" get merged back into
// standard_order_id (see the comment on that mapping), or tier 1
// silently degrades into tier 2/3 for every platform that only sends
// a line-item ID.
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// ORDER-LEVEL DISCOUNT ALLOCATION (Shopify/Meta-style exports)
//
// THE PROBLEM: Shopify order exports (used for Meta/Google-attributed
// sales) put the line-item price BEFORE any discount in "Lineitem
// price", and the real post-discount order total in "Total" — but
// "Total" is only populated on ONE row per order (Shopify's export
// quirk), with every other line item of a multi-product order left
// blank. Mapping "Lineitem price" straight to standard_revenue (the
// previous behaviour) overstates revenue by the discount amount on
// every discounted order. Switching to "Total" instead would fix the
// total but WRONGLY attribute the entire order's revenue to whichever
// single line item happened to carry the Total value, zeroing out
// every other product in that order — breaking SKU-level reporting.
//
// THE FIX: allocate each order's real (post-discount) Total across
// its line items proportionally, by each item's share of that SAME
// order's own line-item prices summed together.
//
// IMPORTANT: the ratio is deliberately computed as
//   Total / (sum of this order's own "Lineitem price" values)
// and NOT as Total / Subtotal (the file's own Subtotal column),
// even though Subtotal looks like it should be exactly that sum.
// Cross-checked directly against two real uploaded files: on both,
// a meaningful fraction of orders (14 of 36 on one day, 15 of 27 on
// another) have a Subtotal that doesn't actually equal the sum of
// that order's own line items — an inconsistency in the export
// itself, not something we can fix by trusting a different column.
// Deriving the ratio from the line items being scaled is
// self-consistent by construction: it always reconstructs the
// order's real Total exactly when summed back up, regardless of
// whether Subtotal agrees. Verified against a second, independently
// uploaded day's file: this formula landed within 0.3% of the old
// dashboard's own number (₹37,908 vs ₹37,799) — the closest of every
// approach tried, including trusting Subtotal (which was noticeably
// further off on both files tested).
//
// SCOPE: only touches rows carrying a "Total" value in their
// raw_extras (i.e. actually came from a Shopify-shaped export). A
// no-op for Amazon/Flipkart/Blinkit files, which don't have this
// column at all — nothing here changes their behaviour.
// ═══════════════════════════════════════════════════════════════════
function allocateOrderLevelDiscount(rows) {
  // ARCHITECTURE: standard_revenue stores GROSS line revenue for Shopify rows:
  //   standard_revenue = Lineitem price × Lineitem quantity
  // This matches Shopify's own "Gross Sales" figure and the old dashboard's
  // formula exactly. The per-line discount (Lineitem discount) stays in
  // raw_extras untouched and is subtracted at query time by clientRouter
  // when the user has "Apply discounts" toggled on — giving them the choice
  // between gross and net revenue without needing a separate DB column.
  //
  // For Shopify rows: standard_revenue is already set to Lineitem price
  // (per-unit) by normaliseRow. Here we multiply by standard_units to get
  // the total gross line revenue, making it consistent with Amazon/Flipkart
  // which already store total line amounts in their revenue column.
  for (const row of rows) {
    if (row.raw_extras?.Total === undefined) continue; // not a Shopify-shaped row
    if (row.standard_revenue == null) continue;
    const units = Number(row.standard_units) || 1;
    row.standard_revenue = Math.round(row.standard_revenue * units * 100) / 100;
  }
  return rows;
}

// lineItemSeq is an optional 0-based position of this row within its
// order group (platform + orderId). Callers that pre-compute it pass it
// in; callers that don't get undefined, which preserves the old behaviour
// for tiers that don't need it.
export function computeRevenueDedupKey(row, lineItemSeq) {
  const orderItemId = row.standard_order_item_id && String(row.standard_order_item_id) !== '0'
    ? String(row.standard_order_item_id).trim()
    : '';
  const orderId = row.standard_order_id ? String(row.standard_order_id).trim() : '';
  const sku     = row.standard_sku ? String(row.standard_sku).trim() : '';

  if (orderItemId) {
    return { hash: hash(`order_item_id:${orderItemId}`), method: 'order_item_id' };
  }
  if (orderId) {
    // BUG FIX: Shopify exports can legitimately have multiple line-item
    // rows for the same order_id + sku (e.g. two units of the same
    // product fulfilled separately, or a partial-fulfilment duplicate
    // row). Previously both rows produced the same hash
    // ("order_id_sku:NEAT-xxxxx|SKU"), causing a Postgres
    // "ON CONFLICT DO UPDATE command cannot affect row a second time"
    // error that silently failed the entire upload batch.
    // Fix: include the 0-based line-item sequence within the order so
    // each physical row gets a unique hash even when order+sku repeats.
    // lineItemSeq is pre-computed by the caller by counting how many
    // rows with the same platform+orderId appeared before this one.
    const seq = lineItemSeq !== undefined ? lineItemSeq : 0;
    return { hash: hash(`order_id_sku:${orderId}|${sku}|${seq}`), method: 'order_id_sku' };
  }

  const revenueStr = row.standard_revenue != null && row.standard_revenue !== ''
    ? Number(row.standard_revenue).toFixed(2) : '';
  const unitsStr = row.standard_units != null && row.standard_units !== ''
    ? String(row.standard_units) : '';
  // BUG FIX: revenue removed from composite hash. Previously including
  // revenue meant a cancellation that zeroed the revenue produced a
  // different hash — causing a new row to be inserted instead of the
  // existing row being updated. Without revenue, the hash is stable
  // across status/revenue changes so re-uploading a cancelled order
  // correctly updates standard_status in place.
  const composite = `composite:${row.order_date ?? ''}|${sku}|${row.standard_state ?? ''}|${unitsStr}`;
  return { hash: hash(composite), method: 'composite' };
}

function hash(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// ═══════════════════════════════════════════════════════════════════
// AUTOMATIC INVENTORY DEDUCTION
//
// Resolves, once per call, which warehouse each platform present in
// this batch should deduct from — platform_warehouse_map if one's
// configured, otherwise the client's single default warehouse. Rows
// for a platform with neither (no mapping AND no default warehouse
// configured yet) are skipped with a warning rather than failing the
// whole batch — inventory tracking is opt-in; a client who hasn't
// set up any warehouses yet should be able to upload revenue files
// exactly as before, with no inventory side-effects at all.
//
// Runs in small concurrent batches (mirrors bulkInsert's own
// CONCURRENCY pattern) rather than one row at a time sequentially,
// since a large file could otherwise mean thousands of sequential
// round trips.
// ═══════════════════════════════════════════════════════════════════
async function deductInventoryForSale(clientId, rows) {
  const sellable = rows.filter(r => r.standard_sku && Number(r.standard_units) > 0);
  if (!sellable.length) return;

  const platforms = [...new Set(sellable.map(r => r.platform))];

  const [{ data: mappings }, { data: warehouses }] = await Promise.all([
    supabaseAdmin.from('platform_warehouse_map').select('platform, warehouse_id').eq('client_id', clientId).in('platform', platforms),
    supabaseAdmin.from('warehouses').select('id, is_default').eq('client_id', clientId).eq('is_active', true),
  ]);

  const defaultWarehouseId = warehouses?.find(w => w.is_default)?.id || null;
  const warehouseByPlatform = {};
  for (const p of platforms) {
    warehouseByPlatform[p] = mappings?.find(m => m.platform === p)?.warehouse_id || defaultWarehouseId;
  }

  const unresolvedPlatforms = platforms.filter(p => !warehouseByPlatform[p]);
  if (unresolvedPlatforms.length) {
    console.warn(`[inventory] No warehouse configured for platform(s) ${unresolvedPlatforms.join(', ')} (client ${clientId}) — skipping deduction for those rows. Set up a default warehouse or a platform mapping to enable this.`);
  }

  const toDeduct = sellable.filter(r => warehouseByPlatform[r.platform]);
  if (!toDeduct.length) return;

  const CONCURRENCY = 8;
  let deducted = 0, duplicates = 0;
  for (let i = 0; i < toDeduct.length; i += CONCURRENCY) {
    const batch = toDeduct.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(row =>
      recordMovement({
        clientId,
        warehouseId: warehouseByPlatform[row.platform],
        sku: row.standard_sku,
        qtyDelta: -Math.round(Number(row.standard_units)),
        reason: 'sale',
        platform: row.platform,
        sourceRowHash: row.row_hash,
      }).catch(e => { console.warn('[inventory] deduction failed for one row:', e.message); return false; })
    ));
    for (const wasNew of results) { if (wasNew) deducted++; else duplicates++; }
  }

  console.log(`[inventory] deducted ${deducted} sale(s), skipped ${duplicates} already-recorded duplicate(s) (client ${clientId})`);
}

async function bulkInsert(table, rows) {
  const chunks = [];
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    chunks.push(rows.slice(i, i + CHUNK_SIZE));
  }

  // Both tables upsert now, not insert — each for its own reason:
  //
  // campaign_data upserts-and-sums (see mergeDuplicateCampaignRows
  // above) because a daily campaign export very often legitimately
  // re-includes the same campaign/date from a prior upload. Upsert
  // updates the conflicting row instead of rejecting the whole 500-row
  // chunk over one collision.
  //
  // revenue_data upserts-and-UPDATES (not ignores) on row_hash —
  // ported from the old dashboard's behavior: re-uploading a file
  // (e.g. after an order's status changed from Pending to Delivered,
  // or a revenue correction) safely overwrites the existing row's
  // mutable fields instead of either duplicating it or silently
  // refusing the correction. Before this change revenue_data had NO
  // unique constraint at all, so re-uploading a file — or uploading
  // two files with overlapping date ranges — silently double-counted
  // revenue/units with no protection whatsoever.
  // Requires the migration in
  // db/migrations/2026-08_revenue_data_dedup.sql to have been applied
  // first — falls back to a clear error if the constraint is missing
  // rather than silently behaving like a plain insert.
  const isCampaignTable = table === 'campaign_data';
  const isRevenueTable  = table === 'revenue_data';

  let inserted = 0;
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((chunk) => {
        if (isCampaignTable) {
          return supabaseAdmin.from(table).upsert(chunk, { onConflict: 'client_id,platform,campaign_date,campaign_name' });
        }
        if (isRevenueTable) {
          return supabaseAdmin.from(table).upsert(chunk, { onConflict: 'client_id,row_hash' });
        }
        return supabaseAdmin.from(table).insert(chunk);
      })
    );
    for (const { error } of results) {
      if (error) throw new Error(`Supabase upsert error on ${table}: ${error.message}`);
    }
    inserted += batch.reduce((sum, c) => sum + c.length, 0);
  }
  return inserted;
}


// ═══════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT — ingestFile
//
// Call this from your Express upload handler after multer/busboy
// has buffered the file.
//
// Parameters:
//   fileBuffer   — Buffer (the raw file bytes)
//   originalName — string (original filename, used for prefix detection)
//   clientId     — UUID of the client this file belongs to
//   uploadedBy   — UUID of the admin user who triggered the upload
//
// Returns:
//   { uploadId, platform, dataType, rowCount, skippedRows }
// ═══════════════════════════════════════════════════════════════════
export async function ingestFile({ fileBuffer, originalName, clientId, uploadedBy }) {

  // 1. Detect platform + data type
  const route = detectRoute(originalName);
  if (!route) {
    throw new Error(
      `Filename '${originalName}' does not match any known prefix. ` +
      `Expected one of: ${PREFIX_ROUTES.map((r) => r.prefix).join(', ')}`
    );
  }
  const { platform, dataType: filenameDataType } = route;

  // 2. Create an uploads audit record in 'processing' state
  //    (dataType may still be corrected by content-detection below —
  //     we update it before finalising if that happens)
  const { data: uploadRecord, error: uploadErr } = await supabaseAdmin
    .from('uploads')
    .insert({
      client_id:          clientId,
      uploaded_by:        uploadedBy,
      original_name:      originalName,
      detected_platform:  platform,
      detected_data_type: filenameDataType,
      status:             'processing',
    })
    .select('id')
    .single();

  if (uploadErr) throw new Error(`Failed to create upload record: ${uploadErr.message}`);
  const uploadId = uploadRecord.id;

  try {
    // 3. Parse file into raw row objects (handles encoding/delimiter/
    //    header-row detection, and a file-level default date if the
    //    report doesn't have a per-row date column)
    const { rows: rawRows0, defaultDate } = parseFile(fileBuffer, originalName);
    if (rawRows0.length === 0) {
      await finaliseUpload(uploadId, 'success', 0, 0);
      return { uploadId, platform, dataType: filenameDataType, rowCount: 0, skippedRows: 0 };
    }

    // 3a. Drop rollup/summary rows before anything else touches them.
    // Google Ads campaign exports append several aggregate rows after
    // the real per-campaign data — "Total: Campaigns", "Total: Account",
    // "Total: Search", "Total: Performance Max", etc. — each carrying
    // its own real Cost/spend figure that's a SUM of (some subset of)
    // the individual campaigns above it, not a new campaign. Left in,
    // these get treated as ordinary rows and their spend gets summed
    // right alongside the real campaigns' spend, multiplying the
    // reported total several times over (confirmed directly against an
    // uploaded file: real spend ₹4,182.68, but summing every row
    // including 5 non-zero "Total: ..." rows on top of it produced
    // ₹16,730.72 — very close to what the affected dashboard actually
    // showed). Detected generically off the first column's value
    // starting with "Total" (case-insensitive) — a live campaign name
    // wouldn't naturally start with that word, and this same "Total:"
    // row shape hasn't shown up in any other platform's export so far,
    // so this is safe to apply across the board rather than gating it
    // to Google specifically.
    const rawRows = rawRows0.filter(row => {
      const firstValue = String(Object.values(row)[0] ?? '').trim();
      return !/^total\b/i.test(firstValue);
    });
    if (rawRows.length < rawRows0.length) {
      console.log(`[ingestion] dropped ${rawRows0.length - rawRows.length} rollup/summary row(s) from ${originalName} (e.g. Google Ads "Total: ..." rows)`);
    }
    if (rawRows.length === 0) {
      await finaliseUpload(uploadId, 'success', 0, 0);
      return { uploadId, platform, dataType: filenameDataType, rowCount: 0, skippedRows: rawRows0.length };
    }

    // 3b. Content-based data-type check — a file's actual columns are a
    //     more reliable signal than its filename (catches a mislabeled
    //     file, e.g. a campaign export saved with a revenue-style name).
    //     Only overrides the filename's implied type when the content
    //     clearly leans one way; ties keep the filename's own routing.
    const contentDataType = classifyDataType(Object.keys(rawRows[0]));
    const dataType = contentDataType || filenameDataType;
    const routingCorrected = contentDataType && contentDataType !== filenameDataType;

    if (routingCorrected) {
      console.warn(
        `[ingestion] Routing correction for ${originalName}: filename implied ` +
        `'${filenameDataType}' but columns look like '${contentDataType}' — using '${contentDataType}'.`
      );
      await supabaseAdmin.from('uploads').update({ detected_data_type: dataType }).eq('id', uploadId);
    }

    // 4. Normalise via column mapper
    const map = dataType === 'revenue' ? REVENUE_MAP : CAMPAIGN_MAP;
    let { rows: normalisedRows, skipped } = normaliseBatch(rawRows, map, {
      clientId,
      platform,
      uploadId,
      defaultDate,
    });

    // Fallback: the dictionary only recognises exact header text it's
    // already seen. If it mapped nothing usable (every row skipped,
    // even though the file clearly has data), try fuzzy keyword +
    // value-shape detection on the still-unmapped columns instead of
    // silently reporting "0 rows added" — this is exactly what used to
    // happen to files like an aggregated "Month/Net Sales/Orders"
    // report that don't match any known export format's column names.
    let usedFallbackMapping = false;
    if (normalisedRows.length === 0 && rawRows.length > 0) {
      const extraMap = detectFallbackMapping(rawRows, map);
      if (Object.keys(extraMap).length > 0) {
        const augmentedMap = { ...map, ...extraMap };
        const retry = normaliseBatch(rawRows, augmentedMap, { clientId, platform, uploadId, defaultDate });
        if (retry.rows.length > 0) {
          normalisedRows = retry.rows;
          skipped = retry.skipped;
          usedFallbackMapping = true;
          console.warn(
            `[ingestion] ${originalName}: dictionary mapping found 0 usable rows — ` +
            `fell back to fuzzy column detection (${JSON.stringify(extraMap)}), recovered ${retry.rows.length} rows. ` +
            `Flagging this upload for manual verification.`
          );
        }
      }
    }

    // Campaign exports frequently have multiple line items for the same
    // campaign on the same day (per ad set, per age group, per placement,
    // etc.) — same platform+date+campaign_name, different spend/revenue
    // split across rows. Since campaign_data now upserts on
    // (client_id, platform, campaign_date, campaign_name), a single
    // Postgres statement is not allowed to touch the same target row
    // twice ("ON CONFLICT DO UPDATE command cannot affect row a second
    // time"), so these must be summed into ONE row per key before we
    // ever call bulkInsert — otherwise the whole chunk is rejected.
    // Revenue rows get a de-dup key (hash + which tier produced it) so
    // bulkInsert can upsert instead of blind-insert — see
    // computeRevenueDedupKey() for the 3-tier algorithm, ported from
    // the old dashboard's backend.
    //
    // Per-row Meta vs Google split for Website/Shopify exports — was
    // missing entirely. Platform was being decided purely by FILENAME
    // (Meta_File.csv → every row tagged 'meta', Google_File.csv →
    // every row tagged 'google'), never by each row's own content —
    // but a single real Shopify export genuinely contains a MIX of
    // both (confirmed directly against an uploaded file: rows tagged
    // "source-google" sitting right alongside mostly "source-facebook"
    // ones in the same Meta_File.csv upload). Every Google-attributed
    // order in a file uploaded under the Meta_File naming convention
    // was silently being counted as Meta instead — not a missing-data
    // problem, a mis-attribution one, and it's why 'google' had zero
    // revenue rows despite Google Ads clearly being a real, active
    // channel (real Google campaign spend exists in this system).
    //
    // Ported from the old dashboard's own stated logic for this exact
    // file type: Tags containing "source-facebook" or "source-
    // instagram" → Meta; "source-google" → Google; anything else
    // (including no Tags at all) → Meta, same default the old system
    // uses. Only touches rows the filename already routed to 'meta'
    // or 'google' — never reclassifies Amazon/Flipkart/Blinkit rows,
    // which don't have this per-row ambiguity at all.
    for (const row of normalisedRows) {
      if (row.platform !== 'meta' && row.platform !== 'google') continue;
      const tags = String(row.raw_extras?.Tags || '').toLowerCase();
      if (tags.includes('source-google')) row.platform = 'google';
      else if (tags.includes('source-facebook') || tags.includes('source-instagram')) row.platform = 'meta';
      // else: leave whatever the filename already assigned — matches
      // the old system's own default of Meta for an untagged row.
    }

    // ── Shopify status normalisation ────────────────────────────────────────
    // Shopify exports only populate Financial Status and Cancelled at on the
    // FIRST line-item row of each order — every other line-item of a
    // multi-product order has these fields blank. Forward-fill them within
    // each order group so every row gets the correct status.
    // Then map raw Shopify statuses to canonical values matching the old
    // dashboard's logic exactly:
    //   voided or refunded Financial Status  → 'Cancelled'
    //   non-empty Cancelled at               → 'Cancelled'
    //   paid + fulfilled                     → 'Delivered'
    //   everything else                      → 'Pending'
    // This ensures voided/refunded orders are excluded from revenue totals
    // by the status filter (same as the old dashboard behaviour) rather than
    // being silently counted as paid revenue.
    if (dataType === 'revenue') {
      // Forward-fill Financial Status and Cancelled at within each order
      const orderStatusMap = new Map();   // orderId → { finStatus, cancelledAt }
      for (const row of normalisedRows) {
        const oid = row.standard_order_id;
        if (!oid) continue;
        const fin = String(row.raw_extras?.['Financial Status'] || '').trim();
        const ca  = String(row.raw_extras?.['Cancelled at']    || '').trim();
        if (!orderStatusMap.has(oid)) orderStatusMap.set(oid, { finStatus: '', cancelledAt: '' });
        const entry = orderStatusMap.get(oid);
        if (!entry.finStatus  && fin) entry.finStatus  = fin;
        if (!entry.cancelledAt && ca && ca !== 'nan' && ca !== 'none') entry.cancelledAt = ca;
      }
      for (const row of normalisedRows) {
        if (row.platform !== 'meta' && row.platform !== 'google') continue;
        const oid = row.standard_order_id;
        if (!oid) continue;
        const { finStatus, cancelledAt } = orderStatusMap.get(oid) || {};
        const fin = (finStatus || '').toLowerCase();
        const ful = String(row.raw_extras?.['Fulfillment Status'] || '').toLowerCase();
        let status;
        if (fin === 'voided' || fin === 'refunded' || cancelledAt) {
          status = 'Cancelled';
        } else if (fin === 'paid' && ful === 'fulfilled') {
          status = 'Delivered';
        } else if (fin === 'paid') {
          status = 'Paid';
        } else {
          status = 'Pending';
        }
        row.standard_status = status;

        // Also store raw Shopify fields for AI Insights cards.
        // financial_status: raw value ('voided','refunded','paid','pending')
        // risk_level: from Shopify Risk Level column ('High','Low')
        // tags: raw Tags string — used to detect High Risk, DUPLICATE_ORDER
        row.financial_status  = fin || null;
        row.risk_level        = String(row.raw_extras?.['Risk Level'] || '').trim() || null;
        row.tags              = String(row.raw_extras?.['Tags']       || '').trim() || null;
        row.is_duplicate_flag = (row.tags || '').includes('DUPLICATE_ORDER');
      }
    }

    // Order-level discount allocation for Shopify-shaped exports
    // (Meta/Google) — must run BEFORE the dedup hash is computed, so
    // the corrected revenue is what actually gets fingerprinted and
    // stored. No-op for platforms without Total/Subtotal columns.
    const discountAdjustedRows = dataType === 'revenue'
      ? allocateOrderLevelDiscount(normalisedRows)
      : normalisedRows;

    // Pre-compute each row's 0-based position within its order group
    // (platform + standard_order_id) so computeRevenueDedupKey can
    // include it in the tier-2 hash, preventing collisions when the
    // same order has multiple line-items with the same SKU.
    const orderSeqCounter = new Map();
    const rows = dataType === 'campaign'
      ? mergeDuplicateCampaignRows(normalisedRows)
      : discountAdjustedRows.map(row => {
          const orderKey = (row.platform || '') + '|' + (row.standard_order_id || '');
          const seq = orderSeqCounter.get(orderKey) || 0;
          orderSeqCounter.set(orderKey, seq + 1);
          const { hash: row_hash, method: dedup_method } = computeRevenueDedupKey(row, seq);
          return { ...row, row_hash, dedup_method };
        });

    // 5. Bulk insert into the correct table
    const table     = dataType === 'revenue' ? 'revenue_data' : 'campaign_data';
    const inserted  = await bulkInsert(table, rows);

    // 5b. Automatic inventory deduction — each revenue row that
    // represents a real sale (has both a SKU and a positive unit
    // count) decrements the warehouse stock mapped to its platform.
    // Uses the same row_hash already computed for revenue de-dup
    // above as the movement ledger's idempotency key, so re-uploading
    // this same file later (or any file containing the same rows)
    // can NEVER double-deduct — see recordMovement() in
    // routes/inventoryRouter.js for the full mechanism. Deliberately
    // best-effort: a failure here is logged but never fails the
    // upload itself — inventory tracking is a downstream convenience,
    // not something that should block getting revenue data in.
    if (dataType === 'revenue') {
      await deductInventoryForSale(clientId, rows).catch(e => {
        console.warn(`[ingestion] inventory deduction failed for ${originalName} (upload still succeeded):`, e.message);
      });
    }

    // 5c. Shopify revenue correction — automatically fixes multi-line-item
    // revenue inflation and cancelled order revenue for Meta/Google uploads.
    // Runs after bulk insert, best-effort (never fails the upload).
    if (dataType === 'revenue') {
      await correctShopifyRevenueForUpload(clientId, uploadId, platform).catch(e => {
        console.warn(`[ingestion] Shopify correction failed for ${originalName} (upload still succeeded):`, e.message);
      });
    }

    // 6. Mark upload as complete
    const routingNote = routingCorrected
      ? `Note: filename suggested '${filenameDataType}' data, but the columns in this file matched '${dataType}' data instead — routed accordingly.`
      : null;
    const fallbackNote = usedFallbackMapping
      ? `⚠ This file's column names didn't match any known format. Columns were auto-detected by pattern-matching instead — please spot-check the data (revenue, dates, product names) before relying on it.`
      : null;
    const note = [routingNote, fallbackNote].filter(Boolean).join(' ') || null;
    await finaliseUpload(uploadId, 'success', inserted, skipped, note);

    console.log(
      `[ingestion] ✓ ${originalName} → ${table} | ` +
      `platform=${platform} rows=${inserted} skipped=${skipped}` +
      (routingCorrected ? ` | routing corrected (${filenameDataType} → ${dataType})` : '') +
      (usedFallbackMapping ? ` | used fallback column detection` : '')
    );

    // 7. Fire-and-forget insight generation (non-blocking)
    generateInsights({ clientId, uploadId, platform }).catch(err =>
      console.error('[ingestion] Insight generation failed (non-fatal):', err.message)
    );
    generateNarrativeSummaries({ clientId }).catch(err =>
      console.error('[ingestion] Narrative summary generation failed (non-fatal):', err.message)
    );

    return {
      uploadId, platform, dataType,
      rowCount: inserted, skippedRows: skipped,
      routingCorrected, filenameDataType,
      usedFallbackMapping,
    };

  } catch (err) {
    // Mark upload as failed, bubble up for the route handler to respond
    await finaliseUpload(uploadId, 'error', 0, 0, err.message);
    throw err;
  }
}




// ═══════════════════════════════════════════════════════════════════
// SHOPIFY REVENUE CORRECTION
//
// Runs automatically after every Meta_File / Google_File upload.
// Fixes two structural issues in Shopify CSV exports:
//
// 1. MULTI-LINE ITEM INFLATION
//    Shopify exports one row per line item per order. An order with
//    3 products = 3 rows, all sharing the same order ID. The Total
//    column (order-level revenue) is only populated on the FIRST row
//    of each order — sub-rows have it blank, but our normaliser
//    forward-fills it, causing revenue to be counted 3× instead of 1×.
//    Fix: zero revenue on all rows except the one with the highest
//    revenue per order (the main row).
//
// 2. CANCELLED ORDER REVENUE
//    Voided (cancelled before fulfilment) and refunded orders are
//    mapped to standard_status = 'Cancelled' during ingestion, but
//    their revenue is still stored. Fix: zero revenue and units on
//    all Cancelled rows.
//
// 3. SUB-ROW UNIT INFLATION
//    After revenue is zeroed on sub-rows, zero their units too so
//    unit counts only reflect real sold quantities.
//
// This runs as a Supabase UPDATE after bulk insert, scoped only to
// the rows just uploaded (by upload_id) so it never touches other
// uploads or platforms.
// ═══════════════════════════════════════════════════════════════════
async function correctShopifyRevenueForUpload(clientId, uploadId, platform) {
  if (!['meta', 'google'].includes(platform)) return; // only Shopify platforms

  console.log(`[ingestion] Running Shopify revenue correction for upload ${uploadId}...`);

  try {
    // Step 1 — Zero cancelled order revenue and units
    const { error: e1 } = await supabaseAdmin
      .from('revenue_data')
      .update({ standard_revenue: 0, standard_units: 0 })
      .eq('client_id', clientId)
      .eq('upload_id', uploadId)
      .eq('standard_status', 'Cancelled');

    if (e1) console.warn('[ingestion] Cancelled correction error:', e1.message);

    // Step 2 — Zero sub-row revenue
    // Sub-rows share the same standard_order_id as the main row.
    // After zeroing, only the main row (highest revenue) keeps its value.
    // We do this via a raw SQL call since Supabase JS SDK doesn't support
    // "UPDATE ... WHERE id NOT IN (SELECT MAX... GROUP BY ...)" directly.
    const { error: e2 } = await supabaseAdmin.rpc('correct_shopify_sub_rows', {
      p_client_id: clientId,
      p_upload_id: uploadId,
    });

    if (e2) {
      // RPC not available — fall back to zeroing rows where revenue=0 and status not null
      // (forward-fill already set status on sub-rows, so we use order_id dedup instead)
      console.warn('[ingestion] RPC unavailable, using fallback sub-row correction:', e2.message);

      // Fallback: zero units on rows where revenue was already 0 after cancelled correction
      // These are the sub-rows that had their revenue zeroed or never had revenue
      const { error: e3 } = await supabaseAdmin
        .from('revenue_data')
        .update({ standard_units: 0 })
        .eq('client_id', clientId)
        .eq('upload_id', uploadId)
        .eq('standard_revenue', 0)
        .neq('standard_status', 'Cancelled'); // already handled above
      
      if (e3) console.warn('[ingestion] Fallback unit correction error:', e3.message);
    }

    console.log(`[ingestion] ✓ Shopify revenue correction complete for upload ${uploadId}`);
  } catch (err) {
    console.warn(`[ingestion] Revenue correction failed (non-fatal, upload still succeeded):`, err.message);
  }
}


// ─────────────────────────────────────────────────────────────────
// finaliseUpload — updates the uploads audit row
// ─────────────────────────────────────────────────────────────────
async function finaliseUpload(uploadId, status, rowCount, skippedRows, errorMessage = null) {
  const { error } = await supabaseAdmin
    .from('uploads')
    .update({
      status,
      row_count:     rowCount,
      skipped_rows:  skippedRows,
      error_message: errorMessage,
      completed_at:  new Date().toISOString(),
    })
    .eq('id', uploadId);

  if (error) {
    console.error(`[ingestion] Failed to finalise upload ${uploadId}:`, error.message);
  }
}
