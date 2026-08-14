// lib/dataValidator.js
// ─────────────────────────────────────────────────────────────────
// POST-UPLOAD DATA VALIDATION
//
// Called after every successful file ingestion (fire-and-forget).
// Uses Claude API to analyse the upload and flag anomalies.
//
// Checks:
//   1. Revenue inflation (sub-row duplication)
//   2. Cancelled orders included in revenue
//   3. Unit count anomalies
//   4. Order count vs expected range
//   5. Revenue per order plausibility
//   6. Platform-level cross-checks
//
// Writes results to upload_validations table.
// Dashboard reads this to show ✅ / ⚠️ badge on each upload.
// ─────────────────────────────────────────────────────────────────
import Anthropic        from '@anthropic-ai/sdk';
import { supabaseAdmin } from './supabase.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL     = 'claude-sonnet-4-6';

// ═══════════════════════════════════════════════════════════════════
// MAIN ENTRY — validateUpload
// ═══════════════════════════════════════════════════════════════════
export async function validateUpload({ clientId, uploadId, platform, rowCount }) {
  console.log(`[validator] Starting validation for upload ${uploadId} (${platform})`);

  try {
    // 1. Pull stats for this specific upload from the database
    const stats = await gatherUploadStats(clientId, uploadId, platform);

    // 2. Run rule-based checks first (fast, no API cost)
    const ruleIssues = runRuleChecks(stats, platform);

    // 3. Call Claude for intelligent anomaly detection
    const claudeAnalysis = await callClaudeValidator(stats, platform, ruleIssues);

    // 4. Determine overall status
    const status = ruleIssues.filter(i => i.severity === 'error').length > 0
      ? 'error'
      : ruleIssues.filter(i => i.severity === 'warning').length > 0
        ? 'warning'
        : 'ok';

    // 5. Write to upload_validations table
    await supabaseAdmin
      .from('upload_validations')
      .upsert({
        client_id:      clientId,
        upload_id:      uploadId,
        platform,
        status,
        row_count:      rowCount,
        order_count:    stats.uniqueOrders,
        revenue_total:  stats.totalRevenue,
        cancelled_count: stats.cancelledOrders,
        issues:         ruleIssues,
        ai_summary:     claudeAnalysis.summary,
        ai_flags:       claudeAnalysis.flags,
        validated_at:   new Date().toISOString(),
      }, { onConflict: 'upload_id' });

    console.log(`[validator] ✓ Upload ${uploadId} validated — status: ${status}, issues: ${ruleIssues.length}`);
    return { status, issues: ruleIssues, stats };

  } catch (err) {
    console.error('[validator] Validation failed (non-fatal):', err.message);
    // Write error state so dashboard doesn't show stale data
    await supabaseAdmin
      .from('upload_validations')
      .upsert({
        client_id:    clientId,
        upload_id:    uploadId,
        platform,
        status:       'unknown',
        ai_summary:   'Validation could not complete: ' + err.message,
        ai_flags:     [],
        issues:       [],
        validated_at: new Date().toISOString(),
      }, { onConflict: 'upload_id' }).catch(() => {});
  }
}


// ═══════════════════════════════════════════════════════════════════
// GATHER STATS — query revenue_data for this upload
// ═══════════════════════════════════════════════════════════════════
async function gatherUploadStats(clientId, uploadId, platform) {
  const { data: rows } = await supabaseAdmin
    .from('revenue_data')
    .select('standard_order_id, standard_revenue, standard_units, standard_status, order_date, standard_sku')
    .eq('client_id', clientId)
    .eq('upload_id', uploadId)
    .limit(5000);

  if (!rows || !rows.length) return {
    totalRows: 0, uniqueOrders: 0, totalRevenue: 0,
    totalUnits: 0, cancelledOrders: 0, activeOrders: 0,
    avgOrderValue: 0, maxOrderValue: 0, minOrderValue: 0,
    rowsWithRevenue: 0, rowsZeroRevenue: 0,
    uniqueSkus: 0, dateRange: null,
  };

  const uniqueOrders   = new Set(rows.filter(r => r.standard_order_id).map(r => r.standard_order_id));
  const activeRows     = rows.filter(r => r.standard_status !== 'Cancelled' && r.standard_revenue > 0);
  const cancelledRows  = rows.filter(r => r.standard_status === 'Cancelled');
  const revenueValues  = activeRows.map(r => Number(r.standard_revenue));
  const dates          = rows.map(r => r.order_date).filter(Boolean).sort();

  return {
    totalRows:       rows.length,
    uniqueOrders:    uniqueOrders.size,
    totalRevenue:    revenueValues.reduce((s, v) => s + v, 0),
    totalUnits:      rows.reduce((s, r) => s + (Number(r.standard_units) || 0), 0),
    cancelledOrders: cancelledRows.length,
    activeOrders:    activeRows.length,
    rowsWithRevenue: rows.filter(r => r.standard_revenue > 0).length,
    rowsZeroRevenue: rows.filter(r => !r.standard_revenue || r.standard_revenue === 0).length,
    avgOrderValue:   revenueValues.length ? revenueValues.reduce((s,v) => s+v, 0) / revenueValues.length : 0,
    maxOrderValue:   revenueValues.length ? Math.max(...revenueValues) : 0,
    minOrderValue:   revenueValues.length ? Math.min(...revenueValues) : 0,
    uniqueSkus:      new Set(rows.map(r => r.standard_sku).filter(Boolean)).size,
    dateRange:       dates.length ? `${dates[0]} to ${dates[dates.length-1]}` : null,
    cancellationRate: rows.length > 0 ? ((cancelledRows.length / uniqueOrders.size) * 100).toFixed(1) : 0,
  };
}


// ═══════════════════════════════════════════════════════════════════
// RULE-BASED CHECKS — fast, no API cost
// ═══════════════════════════════════════════════════════════════════
function runRuleChecks(stats, platform) {
  const issues = [];

  if (stats.totalRows === 0) {
    issues.push({ severity: 'error', code: 'NO_DATA', message: 'No rows found for this upload. File may not have been processed correctly.' });
    return issues;
  }

  // Check 1: Revenue inflation (rows with revenue >> unique orders)
  const isShopify = ['meta', 'google'].includes(platform);
  if (isShopify) {
    const inflationRatio = stats.rowsWithRevenue / Math.max(stats.uniqueOrders, 1);
    if (inflationRatio > 1.5) {
      issues.push({
        severity: 'error',
        code: 'REVENUE_INFLATION',
        message: `Revenue inflation detected: ${stats.rowsWithRevenue} rows have revenue but only ${stats.uniqueOrders} unique orders. Expected ~1:1 ratio after auto-correction.`,
        data: { inflationRatio: inflationRatio.toFixed(2) }
      });
    }
  }

  // Check 2: High cancellation rate
  const cancelRate = parseFloat(stats.cancellationRate);
  if (cancelRate > 35) {
    issues.push({
      severity: 'warning',
      code: 'HIGH_CANCELLATION_RATE',
      message: `Cancellation rate is ${cancelRate}% — unusually high. Investigate if this is a data issue or real cancellations.`,
      data: { cancelRate }
    });
  } else if (cancelRate > 25) {
    issues.push({
      severity: 'warning',
      code: 'ELEVATED_CANCELLATION_RATE',
      message: `Cancellation rate is ${cancelRate}% — above normal range (typically 10-20%).`,
      data: { cancelRate }
    });
  }

  // Check 3: Zero revenue on active orders
  const zeroRevPct = stats.totalRows > 0 ? (stats.rowsZeroRevenue / stats.totalRows * 100) : 0;
  if (isShopify && zeroRevPct > 60) {
    issues.push({
      severity: 'warning',
      code: 'HIGH_ZERO_REVENUE_ROWS',
      message: `${zeroRevPct.toFixed(0)}% of rows have zero revenue. This is expected after sub-row correction but worth verifying.`,
      data: { zeroRevPct: zeroRevPct.toFixed(1) }
    });
  }

  // Check 4: Implausible AOV
  const aov = stats.avgOrderValue;
  if (aov > 0 && aov < 50) {
    issues.push({
      severity: 'warning',
      code: 'LOW_AOV',
      message: `Average order value is ₹${aov.toFixed(0)} — unusually low. Check if revenue column was mapped correctly.`,
      data: { aov: aov.toFixed(0) }
    });
  }
  if (aov > 50000) {
    issues.push({
      severity: 'warning',
      code: 'HIGH_AOV',
      message: `Average order value is ₹${aov.toFixed(0)} — unusually high. Check if revenue is being double-counted.`,
      data: { aov: aov.toFixed(0) }
    });
  }

  // Check 5: No unique order IDs (deduplication can't work)
  if (stats.uniqueOrders === 0 && stats.totalRows > 10) {
    issues.push({
      severity: 'warning',
      code: 'NO_ORDER_IDS',
      message: 'No order IDs found in this upload. Deduplication is using composite hash — re-uploading may create duplicates.',
    });
  }

  // Check 6: Very small upload
  if (stats.uniqueOrders > 0 && stats.uniqueOrders < 5) {
    issues.push({
      severity: 'warning',
      code: 'SMALL_UPLOAD',
      message: `Only ${stats.uniqueOrders} orders in this upload. Is this a partial file?`,
    });
  }

  return issues;
}


// ═══════════════════════════════════════════════════════════════════
// CLAUDE VALIDATION — intelligent anomaly detection
// ═══════════════════════════════════════════════════════════════════
async function callClaudeValidator(stats, platform, ruleIssues) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { summary: 'AI validation skipped — API key not configured.', flags: [] };
  }

  const prompt = `You are a data quality analyst for an Indian D2C e-commerce brand.
Analyse this upload summary and identify any data quality issues.

UPLOAD SUMMARY:
Platform: ${platform}
Total rows in file: ${stats.totalRows}
Unique orders: ${stats.uniqueOrders}
Active orders (with revenue): ${stats.activeOrders}
Cancelled orders: ${stats.cancelledOrders}
Cancellation rate: ${stats.cancellationRate}%
Total revenue: ₹${(stats.totalRevenue / 100000).toFixed(2)} Lakhs
Average order value: ₹${stats.avgOrderValue.toFixed(0)}
Min order value: ₹${stats.minOrderValue.toFixed(0)}
Max order value: ₹${stats.maxOrderValue.toFixed(0)}
Total units: ${stats.totalUnits}
Rows with revenue > 0: ${stats.rowsWithRevenue}
Rows with revenue = 0: ${stats.rowsZeroRevenue}
Unique SKUs: ${stats.uniqueSkus}
Date range: ${stats.dateRange || 'unknown'}

RULE-BASED FLAGS ALREADY FOUND:
${ruleIssues.length > 0 ? ruleIssues.map(i => `- [${i.severity.toUpperCase()}] ${i.message}`).join('\n') : 'None'}

CONTEXT:
- Platform "${platform}" is ${['meta','google'].includes(platform) ? 'Shopify website orders (multi-line-item format — one row per item, revenue repeated on each row, auto-correction should have zeroed sub-rows)' : platform === 'amazon' ? 'Amazon orders (one row per item, each row has its own item price — summing rows is correct)' : 'marketplace orders'}
- Normal cancellation rate for this brand: 15-25%
- Normal AOV range: ₹400-₹3,000
- Zero-revenue rows are expected after Shopify sub-row correction

Respond with a JSON object:
{
  "summary": "2-3 sentence plain English summary of data quality for a business owner",
  "flags": [
    { "severity": "ok|warning|error", "message": "specific issue or confirmation" }
  ],
  "data_looks_correct": true/false
}

Only respond with the JSON, no preamble.`;

  try {
    const message = await anthropic.messages.create({
      model:      MODEL,
      max_tokens: 600,
      messages:   [{ role: 'user', content: prompt }],
    });
    const raw  = message.content[0]?.text || '{}';
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return {
      summary: parsed.summary || 'Validation complete.',
      flags:   Array.isArray(parsed.flags) ? parsed.flags : [],
      dataLooksCorrect: parsed.data_looks_correct ?? true,
    };
  } catch (err) {
    console.warn('[validator] Claude call failed:', err.message);
    return { summary: 'AI validation unavailable.', flags: [] };
  }
}
