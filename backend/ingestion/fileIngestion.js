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
// ─────────────────────────────────────────────────────────────────
import xlsx from 'xlsx';
import path from 'path';
import { parse as parseCsv } from 'csv-parse/sync';
import { supabaseAdmin }  from '../lib/supabase.js';
import { REVENUE_MAP, CAMPAIGN_MAP, normaliseBatch } from '../lib/columnMapper.js';
import { generateInsights } from '../lib/insightGenerator.js';

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
// .xlsx → parsed with the xlsx library (needed for real spreadsheets).
// .csv  → parsed with a small hand-rolled streaming-style parser
//         instead of xlsx. xlsx builds a full in-memory workbook
//         object model even for plain CSVs, which can use 5-10x the
//         raw file size in RAM — on a large file that was enough to
//         OOM-crash the whole Node process on a memory-constrained
//         host. The parser below reads the buffer once and emits
//         plain row objects directly, with correct handling of
//         quoted fields, escaped quotes (""), and embedded newlines
//         inside quoted values (common in Shopify-style exports).
// Returns an array of plain row objects (column header → value).
// ═══════════════════════════════════════════════════════════════════
function parseFile(fileBuffer, originalName) {
  const ext = path.extname(originalName).toLowerCase();

  if (ext === '.csv') {
    return parseCsvBuffer(fileBuffer);
  }

  const workbook = xlsx.read(fileBuffer, {
    type: 'buffer',
    cellDates: true,           // parse dates as JS Date objects
    cellNF: false,
    cellText: false,
  });

  // Always use the first sheet
  const sheetName = workbook.SheetNames[0];
  const sheet     = workbook.Sheets[sheetName];

  // header: 1  → first row becomes array of header strings
  // defval: '' → missing cells become empty string, not undefined
  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  if (rows.length < 2) return [];

  const headers = rows[0].map(String);
  const dataRows = rows.slice(1);

  return dataRows
    .filter((row) => row.some((cell) => cell !== ''))   // skip blank rows
    .map((row) => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = row[i] ?? '';
      });
      return obj;
    });
}

// ─── CSV parsing ────────────────────────────────────────────────
// Uses the csv-parse library rather than xlsx for .csv files: on a
// 24MB / ~22k row Shopify-style export, xlsx (which builds a full
// in-memory workbook object model) used ~300MB RSS and took ~7s;
// csv-parse used ~170MB and took ~2s. That difference was enough to
// OOM-crash the whole Node process on a memory-constrained host.
// Correctly handles quoted fields, escaped quotes (""), and embedded
// newlines inside quoted values (common in these exports).
function parseCsvBuffer(fileBuffer) {
  const records = parseCsv(fileBuffer, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
  });
  // Drop rows where every value is blank
  return records.filter((r) => Object.values(r).some((v) => v !== '' && v != null));
}


// ═══════════════════════════════════════════════════════════════════
// BULK INSERT — inserts in chunks to avoid Supabase payload limits.
// Chunks are sent with bounded concurrency (not fully sequential) so
// large files (10k+ rows) don't take so long that a hosting platform's
// request/gateway timeout kills the connection before we respond.
// ═══════════════════════════════════════════════════════════════════
const CHUNK_SIZE   = 500;
const CONCURRENCY  = 5; // number of chunk inserts in flight at once

async function bulkInsert(table, rows) {
  const chunks = [];
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    chunks.push(rows.slice(i, i + CHUNK_SIZE));
  }

  let inserted = 0;
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((chunk) => supabaseAdmin.from(table).insert(chunk))
    );
    for (const { error } of results) {
      if (error) throw new Error(`Supabase insert error on ${table}: ${error.message}`);
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
  const { platform, dataType } = route;

  // 2. Create an uploads audit record in 'processing' state
  const { data: uploadRecord, error: uploadErr } = await supabaseAdmin
    .from('uploads')
    .insert({
      client_id:          clientId,
      uploaded_by:        uploadedBy,
      original_name:      originalName,
      detected_platform:  platform,
      detected_data_type: dataType,
      status:             'processing',
    })
    .select('id')
    .single();

  if (uploadErr) throw new Error(`Failed to create upload record: ${uploadErr.message}`);
  const uploadId = uploadRecord.id;

  try {
    // 3. Parse file into raw row objects
    const rawRows = parseFile(fileBuffer, originalName);
    if (rawRows.length === 0) {
      await finaliseUpload(uploadId, 'success', 0, 0);
      return { uploadId, platform, dataType, rowCount: 0, skippedRows: 0 };
    }

    // 4. Normalise via column mapper
    const map = dataType === 'revenue' ? REVENUE_MAP : CAMPAIGN_MAP;
    const { rows, skipped } = normaliseBatch(rawRows, map, {
      clientId,
      platform,
      uploadId,
    });

    // 5. Bulk insert into the correct table
    const table     = dataType === 'revenue' ? 'revenue_data' : 'campaign_data';
    const inserted  = await bulkInsert(table, rows);

    // 6. Mark upload as complete
    await finaliseUpload(uploadId, 'success', inserted, skipped);

    console.log(
      `[ingestion] ✓ ${originalName} → ${table} | ` +
      `platform=${platform} rows=${inserted} skipped=${skipped}`
    );

    // 7. Fire-and-forget insight generation (non-blocking)
    generateInsights({ clientId, uploadId, platform }).catch(err =>
      console.error('[ingestion] Insight generation failed (non-fatal):', err.message)
    );

    return { uploadId, platform, dataType, rowCount: inserted, skippedRows: skipped };

  } catch (err) {
    // Mark upload as failed, bubble up for the route handler to respond
    await finaliseUpload(uploadId, 'error', 0, 0, err.message);
    throw err;
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
