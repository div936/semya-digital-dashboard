// lib/fraudDetector.js
// ─────────────────────────────────────────────────────────────────
// CANCELLATION / FRAUD-PATTERN DETECTION
//
// Looks for two patterns across revenue_data rows, using whatever
// buyer-identity signals each platform's file actually contains
// (see IDENTITY_KEYS in columnMapper.js):
//
//   1. Same phone/address, different buyer names, with cancellations
//      — someone re-ordering under different names from the same
//        contact details and cancelling repeatedly.
//   2. Same phone/address, repeated cancellations regardless of name
//      — a single identity with an abnormally high cancel/return rate.
//
// Honest scope limit: this can only run on platforms whose export
// actually includes buyer PII. Amazon/Acutas reports never do
// (Amazon withholds it from sellers) — rows from those platforms are
// skipped here, not silently mis-flagged.
// ─────────────────────────────────────────────────────────────────
import { extractIdentity } from './columnMapper.js';

const CANCEL_KEYWORDS = ['cancel', 'return', 'refund', 'reject', 'void'];

// Some exports (Shopify-style) have a dedicated timestamp column that's
// only populated when an order was cancelled — more reliable than
// parsing status text when it's present.
const CANCELLED_AT_KEYS = ['Cancelled at', 'Cancellation Date', 'Voided at'];

function looksCancelled(status, rawExtras) {
  if (rawExtras) {
    for (const k of CANCELLED_AT_KEYS) {
      if (rawExtras[k] && String(rawExtras[k]).trim()) return true;
    }
  }
  if (!status) return false;
  const s = String(status).toLowerCase();
  return CANCEL_KEYWORDS.some((kw) => s.includes(kw));
}

function normalisePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  // Keep the last 10 digits (drops country code variations like +91/0)
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function normaliseName(name) {
  return name ? String(name).trim().toLowerCase() : null;
}

// ═══════════════════════════════════════════════════════════════════
// detectSuspiciousPatterns
//
// rows: revenue_data rows, each with { platform, standard_status,
//       standard_revenue, standard_sku, order_date, raw_extras }
//
// Returns an array of flagged clusters:
//   {
//     key,                 // phone or name+pincode used to group
//     signal,              // 'phone' | 'name_pincode'
//     platform,
//     identities: [names...],
//     totalOrders, cancelledOrders, cancelRate,
//     totalRevenueAtRisk,  // sum of revenue on the cancelled orders
//     reason,              // human-readable flag reason
//     sampleOrders,        // up to 5 example rows for review
//   }
// ═══════════════════════════════════════════════════════════════════
export function detectSuspiciousPatterns(rows, { minOrders = 2, minCancelled = 2 } = {}) {
  const groups = new Map(); // key -> { platform, identities:Set, orders:[] }

  let skippedNoIdentity = 0;

  for (const row of rows) {
    const identity = extractIdentity(row.raw_extras || {});
    const phoneKey = normalisePhone(identity.phone);
    const nameKey  = normaliseName(identity.name);
    const pin      = identity.pincode ? String(identity.pincode).trim() : null;

    // Prefer phone as the correlation key (most reliable); fall back
    // to name+pincode when phone isn't present in this platform's export.
    let key = null, signal = null;
    if (phoneKey) { key = `phone:${phoneKey}`; signal = 'phone'; }
    else if (nameKey && pin) { key = `namepin:${nameKey}|${pin}`; signal = 'name_pincode'; }

    if (!key) { skippedNoIdentity++; continue; }

    if (!groups.has(key)) {
      groups.set(key, { key, signal, platform: row.platform, identities: new Set(), orders: [] });
    }
    const g = groups.get(key);
    if (identity.name) g.identities.add(identity.name.trim());
    g.orders.push({
      platform:  row.platform,
      status:    row.standard_status,
      revenue:   Number(row.standard_revenue) || 0,
      sku:       row.standard_sku,
      date:      row.order_date,
      cancelled: looksCancelled(row.standard_status, row.raw_extras),
    });
  }

  const flagged = [];
  for (const g of groups.values()) {
    const totalOrders     = g.orders.length;
    const cancelledOrders = g.orders.filter((o) => o.cancelled).length;
    if (totalOrders < minOrders || cancelledOrders < minCancelled) continue;

    const cancelRate = cancelledOrders / totalOrders;
    const multipleNames = g.identities.size > 1;

    // Only flag if there's a real pattern: either multiple names on one
    // contact, or a high cancel rate on repeated orders (not just one
    // bad-luck cancellation).
    if (!multipleNames && cancelRate < 0.5) continue;

    const revenueAtRisk = g.orders.filter((o) => o.cancelled).reduce((s, o) => s + o.revenue, 0);

    flagged.push({
      key:            g.key,
      signal:         g.signal,
      platform:       g.platform,
      identities:     [...g.identities],
      totalOrders,
      cancelledOrders,
      cancelRate:     +(cancelRate * 100).toFixed(0),
      totalRevenueAtRisk: revenueAtRisk,
      reason: multipleNames
        ? `${g.identities.size} different names used the same ${g.signal === 'phone' ? 'phone number' : 'name+pincode combination'}, with ${cancelledOrders} of ${totalOrders} orders cancelled/returned.`
        : `${cancelledOrders} of ${totalOrders} orders (${(cancelRate * 100).toFixed(0)}%) from this contact were cancelled/returned.`,
      sampleOrders: g.orders.slice(0, 5),
    });
  }

  // Worst offenders first
  flagged.sort((a, b) => b.totalRevenueAtRisk - a.totalRevenueAtRisk || b.cancelledOrders - a.cancelledOrders);

  return {
    flagged,
    scanned: rows.length,
    skippedNoIdentity, // rows from platforms with no buyer PII at all (e.g. Amazon/Acutas)
  };
}
