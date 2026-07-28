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
import { parse as parseCsv } from 'csv-parse/sync';
import { supabaseAdmin }  from '../lib/supabase.js';
import { REVENUE_MAP, CAMPAIGN_MAP, normaliseBatch, classifyDataType, scoreHeaderRow } from '../lib/columnMapper.js';
import { generateInsights, generateNarrativeSummaries } from '../lib/insightGenerator.js';

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
  const dateRe = /([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/;
  for (const line of preambleLines) {
    const match = line.match(dateRe);
    if (match) {
      const d = new Date(match[1]);
      if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
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
    const { rows: rawRows, defaultDate } = parseFile(fileBuffer, originalName);
    if (rawRows.length === 0) {
      await finaliseUpload(uploadId, 'success', 0, 0);
      return { uploadId, platform, dataType: filenameDataType, rowCount: 0, skippedRows: 0 };
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
    const { rows, skipped } = normaliseBatch(rawRows, map, {
      clientId,
      platform,
      uploadId,
      defaultDate,
    });

    // 5. Bulk insert into the correct table
    const table     = dataType === 'revenue' ? 'revenue_data' : 'campaign_data';
    const inserted  = await bulkInsert(table, rows);

    // 6. Mark upload as complete
    const note = routingCorrected
      ? `Note: filename suggested '${filenameDataType}' data, but the columns in this file matched '${dataType}' data instead — routed accordingly.`
      : null;
    await finaliseUpload(uploadId, 'success', inserted, skipped, note);

    console.log(
      `[ingestion] ✓ ${originalName} → ${table} | ` +
      `platform=${platform} rows=${inserted} skipped=${skipped}` +
      (routingCorrected ? ` | routing corrected (${filenameDataType} → ${dataType})` : '')
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
    };

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
