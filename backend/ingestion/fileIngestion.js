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
import { REVENUE_MAP, CAMPAIGN_MAP, normaliseBatch, classifyDataType, scoreHeaderRow, computeDedupKey } from '../lib/columnMapper.js';
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
// DEDUPLICATION  (revenue rows)
//
// Attaches row_hash/order_id/order_item_id/dedup_method to each row
// (see computeDedupKey() in columnMapper.js), and drops any row that
// hashes the same as one already seen EARLIER IN THIS SAME FILE — a
// file can genuinely contain a literal repeat of a line, and without
// this check both copies would attempt the same upsert key within one
// batch, which is at best redundant and at worst order-dependent.
// Returns { rows, withinFileDuplicates }.
// ═══════════════════════════════════════════════════════════════════
function attachDedupKeys(rows) {
  const seen = new Set();
  const out = [];
  let withinFileDuplicates = 0;

  rows.forEach((row, i) => {
    const rawExtras = row.raw_extras || {};
    const dk = computeDedupKey(rawExtras, row);
    if (seen.has(dk.rowHash)) {
      withinFileDuplicates++;
      return;
    }
    seen.add(dk.rowHash);
    out.push({
      ...row,
      row_hash: dk.rowHash,
      order_id: dk.orderId,
      order_item_id: dk.orderItemId,
      dedup_method: dk.dedupMethod,
    });
  });

  return { rows: out, withinFileDuplicates };
}

// True if this Postgres/PostgREST error is specifically "a column we
// expect doesn't exist" — i.e. the dedup_schema.sql migration hasn't
// been run yet — as opposed to some other real failure. Matches both
// Postgres's own wording ("column X does not exist") and PostgREST's
// ("Could not find the 'X' column ... in the schema cache").
function isMissingDedupColumnError(error) {
  if (!error) return false;
  const msg = (error.message || '').toLowerCase();
  return (msg.includes('does not exist') || msg.includes('schema cache')) &&
    (msg.includes('row_hash') || msg.includes('order_id') || msg.includes('order_item_id') || msg.includes('dedup_method'));
}

// Checks which row_hashes already exist for this client, so the
// caller can report an accurate new-vs-updated split. Chunked to keep
// each IN-list a reasonable size.
//
// Degrades gracefully if the dedup_schema.sql migration hasn't been
// run yet: rather than blocking the upload entirely, this just
// returns "nothing matched" (so every row reports as new, and no
// updated-row detection happens) until the migration runs.
async function findExistingHashes(clientId, hashes) {
  const existing = new Set();
  const CHECK_CHUNK = 1000;
  for (let i = 0; i < hashes.length; i += CHECK_CHUNK) {
    const chunk = hashes.slice(i, i + CHECK_CHUNK);
    const { data, error } = await supabaseAdmin
      .from('revenue_data')
      .select('row_hash')
      .eq('client_id', clientId)
      .in('row_hash', chunk);
    if (error) {
      if (isMissingDedupColumnError(error)) {
        console.warn('[ingestion] Dedup columns not found (migration not run?) — skipping duplicate-check for this upload:', error.message);
        return { hashes: existing, degraded: true };
      }
      throw new Error(`Failed to check existing rows: ${error.message}`);
    }
    for (const r of data || []) existing.add(r.row_hash);
  }
  return { hashes: existing, degraded: false };
}


// ═══════════════════════════════════════════════════════════════════
// BULK UPSERT — inserts new rows / replaces matching existing ones in
// chunks, to avoid Supabase payload limits. Chunks are sent with
// bounded concurrency (not fully sequential) so large files (10k+
// rows) don't take so long that a hosting platform's request/gateway
// timeout kills the connection before we respond.
//
// conflictCols identifies what counts as "the same row" — for
// revenue_data that's (client_id, row_hash); for campaign_data it's
// (client_id, platform, campaign_name, campaign_date). A conflicting
// row gets ALL its columns replaced with the new values (Supabase's
// default upsert behaviour) — so a later export showing an order's
// updated status/revenue naturally overwrites the earlier version
// instead of creating a duplicate.
//
// Degrades gracefully if the dedup_schema.sql migration hasn't been
// run yet: falls back to a plain insert with the dedup-specific
// columns stripped out, rather than failing the whole upload over a
// feature that isn't set up yet. Returns { processed, degraded }.
// ═══════════════════════════════════════════════════════════════════
const CHUNK_SIZE   = 500;
const CONCURRENCY  = 5; // number of chunk upserts in flight at once
const DEDUP_ONLY_COLUMNS = ['row_hash', 'order_id', 'order_item_id', 'dedup_method'];

async function bulkUpsert(table, rows, conflictCols) {
  const chunks = [];
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    chunks.push(rows.slice(i, i + CHUNK_SIZE));
  }

  let processed = 0;
  let degraded = false;

  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY);
    let results = await Promise.all(
      batch.map((chunk) => supabaseAdmin.from(table).upsert(chunk, { onConflict: conflictCols }))
    );

    const schemaError = results.find((r) => r.error && isMissingDedupColumnError(r.error));
    if (schemaError) {
      // Retry this batch as a plain insert with dedup columns
      // stripped, rather than failing the whole upload.
      console.warn(`[ingestion] Dedup columns not found on ${table} (migration not run?) — inserting without dedup for this upload.`);
      degraded = true;
      const strippedBatch = batch.map((chunk) => chunk.map((row) => {
        const clean = { ...row };
        for (const col of DEDUP_ONLY_COLUMNS) delete clean[col];
        return clean;
      }));
      results = await Promise.all(
        strippedBatch.map((chunk) => supabaseAdmin.from(table).insert(chunk))
      );
    }

    for (const { error } of results) {
      if (error) throw new Error(`Supabase upsert error on ${table}: ${error.message}`);
    }
    processed += batch.reduce((sum, c) => sum + c.length, 0);
  }
  return { processed, degraded };
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
    const { rows: normalisedRows, skipped } = normaliseBatch(rawRows, map, {
      clientId,
      platform,
      uploadId,
      defaultDate,
    });

    // 5. Deduplicate + upsert into the correct table
    const table = dataType === 'revenue' ? 'revenue_data' : 'campaign_data';
    let inserted = 0, updated = 0, withinFileDuplicates = 0, dedupDegraded = false;

    if (dataType === 'revenue') {
      const { rows, withinFileDuplicates: wfd } = attachDedupKeys(normalisedRows);
      withinFileDuplicates = wfd;

      // Figure out new vs. updated BEFORE upserting, so the admin sees
      // an honest breakdown rather than just a total row count.
      const { hashes: existingHashes, degraded: checkDegraded } = await findExistingHashes(clientId, rows.map((r) => r.row_hash));
      updated  = existingHashes.size ? rows.filter((r) => existingHashes.has(r.row_hash)).length : 0;
      inserted = rows.length - updated;

      const { degraded: upsertDegraded } = await bulkUpsert(table, rows, 'client_id,row_hash');
      dedupDegraded = checkDegraded || upsertDegraded;
    } else {
      // Campaign rows dedup on a natural key (platform + campaign name
      // + date) rather than a computed hash — no line-item granularity
      // to worry about for ad performance rows.
      const seen = new Set();
      const rows = [];
      for (const row of normalisedRows) {
        const key = (row.campaign_name || '') + '|' + (row.campaign_date || '');
        if (row.campaign_name && row.campaign_date) {
          if (seen.has(key)) { withinFileDuplicates++; continue; }
          seen.add(key);
        }
        rows.push(row);
      }
      await bulkUpsert(table, rows, 'client_id,platform,campaign_name,campaign_date');
      inserted = rows.length; // campaign rows without a name+date can't be matched against existing ones anyway
    }

    // 6. Mark upload as complete
    const notes = [];
    if (routingCorrected) notes.push(`Note: filename suggested '${filenameDataType}' data, but the columns in this file matched '${dataType}' data instead — routed accordingly.`);
    if (dedupDegraded)    notes.push(`Note: duplicate-detection is not active yet for this client (run db/dedup_schema.sql) — rows were added without checking for duplicates.`);
    const note = notes.length ? notes.join(' ') : null;
    await finaliseUpload(uploadId, 'success', inserted, skipped, note, { updated, withinFileDuplicates });

    console.log(
      `[ingestion] ✓ ${originalName} → ${table} | ` +
      `platform=${platform} new=${inserted} updated=${updated} skipped=${skipped} withinFileDupes=${withinFileDuplicates}` +
      (dedupDegraded ? ' | DEDUP DEGRADED (migration not run)' : '') +
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
      rowCount: inserted, updatedRows: updated, withinFileDuplicates, skippedRows: skipped,
      routingCorrected, filenameDataType, dedupDegraded,
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
async function finaliseUpload(uploadId, status, rowCount, skippedRows, errorMessage = null, dedupStats = {}) {
  const { error } = await supabaseAdmin
    .from('uploads')
    .update({
      status,
      row_count:     rowCount,
      skipped_rows:  skippedRows,
      error_message: errorMessage,
      completed_at:  new Date().toISOString(),
      rows_updated:            dedupStats.updated || 0,
      rows_duplicate_in_file:  dedupStats.withinFileDuplicates || 0,
    })
    .eq('id', uploadId);

  if (error && isMissingDedupColumnError(error)) {
    // The uploads table's own dedup-tracking columns aren't there yet
    // either (same un-run migration) — retry without them so the
    // upload record still gets marked complete instead of staying
    // stuck on "processing" forever, which would be worse than just
    // missing the extra stats.
    console.warn('[ingestion] uploads table missing dedup columns (migration not run?) — finalising without them.');
    const { error: retryError } = await supabaseAdmin
      .from('uploads')
      .update({ status, row_count: rowCount, skipped_rows: skippedRows, error_message: errorMessage, completed_at: new Date().toISOString() })
      .eq('id', uploadId);
    if (retryError) console.error(`[ingestion] Failed to finalise upload ${uploadId} even without dedup columns:`, retryError.message);
    return;
  }

  if (error) {
    console.error(`[ingestion] Failed to finalise upload ${uploadId}:`, error.message);
  }
}
