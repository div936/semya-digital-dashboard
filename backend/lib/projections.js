// lib/projections.js
// ─────────────────────────────────────────────────────────────────
// PROFIT CALCULATION + PROJECTIONS
//
// profit = realised revenue − COGS − shipping − platform commission
//          (ad spend is subtracted separately at the aggregate level,
//           since it's a campaign-level cost, not a per-order one)
//
// Cancelled/returned/refunded orders contribute ₹0 realised revenue
// but still incur COGS + shipping — the product was picked and
// shipped before it came back — so they show up as a real loss, not
// as if the order never happened. That loss is reported separately
// (returnLoss) so it's visible rather than silently netted away.
// ─────────────────────────────────────────────────────────────────

import { toISTDateString } from './dateUtils.js';

const CANCEL_RE = /cancel|return|refund|reject|void/i;

// ── SKU cost resolution (effective-dated) ──────────────────────────
// costRows: [{ sku, cost_price, effective_from }, ...] for one client,
// any order. Picks the latest effective_from that is <= orderDate.
// Returns null if no price has ever been set for that SKU as of that
// date — callers must treat that as "unknown", not "free" (₹0 cost
// would wildly overstate profit).
export function resolveSkuCost(costRows, sku, orderDate) {
  if (!sku || !orderDate) return null;
  let best = null;
  for (const row of costRows) {
    if (row.sku !== sku) continue;
    if (row.effective_from > orderDate) continue; // not yet in effect on this order's date
    if (!best || row.effective_from > best.effective_from) best = row;
  }
  return best ? Number(best.cost_price) : null;
}

// Shopify-style exports sometimes carry a real per-order shipping
// figure — prefer that over the platform-level flat assumption when
// it's present.
function extractShippingFromRow(row) {
  const raw = row.raw_extras;
  if (!raw) return null;
  const v = raw['Shipping'] ?? raw['shipping'] ?? raw['Shipping Charges'];
  if (v === undefined || v === '' || v === null) return null;
  const n = Number(String(v).replace(/[₹,\s]/g, ''));
  return isNaN(n) ? null : n;
}

// ═══════════════════════════════════════════════════════════════════
// computeProfitSeries
//
// revenueRows: revenue_data rows (platform, standard_sku, standard_units,
//   standard_revenue, standard_status, order_date, raw_extras)
// campaignRows: campaign_data rows (platform, standard_spend, campaign_date)
// costRows: sku_costs rows for this client
// assumptions: { [platform]: { commission_percent, shipping_cost_flat } }
// bucketBy: 'day' | 'week' | 'month'
//
// Returns { series, totals, unpricedSkus, unpricedRevenue }
// ═══════════════════════════════════════════════════════════════════
export function computeProfitSeries(revenueRows, campaignRows, costRows, assumptions, bucketBy = 'week') {
  const buckets = {}; // key -> { revenue, cogs, shipping, commission, returnLoss, adSpend }
  const unpricedSkus = new Set();
  let unpricedRevenue = 0;

  const bucketKey = (dateStr) => {
    const d = new Date(dateStr);
    if (bucketBy === 'day') return dateStr;
    if (bucketBy === 'month') return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    // week: ISO-ish Monday-start key
    const day = (d.getDay() + 6) % 7;
    const monday = new Date(d); monday.setDate(d.getDate() - day);
    return toISTDateString(monday);
  };

  for (const row of revenueRows) {
    if (!row.order_date) continue;
    const key = bucketKey(row.order_date);
    if (!buckets[key]) buckets[key] = { revenue: 0, cogs: 0, shipping: 0, commission: 0, returnLoss: 0, adSpend: 0 };
    const b = buckets[key];

    const units = Number(row.standard_units) || 0;
    const revenue = Number(row.standard_revenue) || 0;
    const isCancelled = row.standard_status && CANCEL_RE.test(row.standard_status);
    const platformAssump = assumptions[row.platform] || { commission_percent: 0, shipping_cost_flat: 0 };

    const unitCost = resolveSkuCost(costRows, row.standard_sku, row.order_date);
    if (unitCost === null && row.standard_sku) {
      unpricedSkus.add(row.standard_sku);
      // Track unpriced revenue but still add it to the bucket so ad-spend ROAS
      // and revenue trend are visible even without cost prices configured.
      // Profit calculation will exclude these rows (cogs treated as 0 = profit = revenue,
      // which would be misleading), so we zero-out cogs/commission for now and flag
      // the revenue as "unpriced" for the frontend to annotate.
      unpricedRevenue += isCancelled ? 0 : revenue;
      if (!isCancelled) {
        b.revenue    += revenue;   // show revenue trend
        b.unpricedRevenue = (b.unpricedRevenue || 0) + revenue; // flag it
        // profit contribution is excluded (we subtract it back out)
      }
      continue; // still skip cogs/commission/profit calculation
    }
    const cogs = (unitCost || 0) * units;
    const shipping = extractShippingFromRow(row) ?? platformAssump.shipping_cost_flat;
    const commission = isCancelled ? 0 : revenue * (platformAssump.commission_percent / 100);

    b.cogs     += cogs;
    b.shipping += shipping;
    if (isCancelled) {
      b.returnLoss += cogs + shipping; // sunk cost on an order that earned nothing
    } else {
      b.revenue    += revenue;
      b.commission += commission;
    }
  }

  for (const row of campaignRows) {
    if (!row.campaign_date) continue;
    const key = bucketKey(row.campaign_date);
    if (!buckets[key]) buckets[key] = { revenue: 0, cogs: 0, shipping: 0, commission: 0, returnLoss: 0, adSpend: 0 };
    buckets[key].adSpend += Number(row.standard_spend) || 0;
  }

  const series = Object.entries(buckets)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([period, b]) => {
      // Exclude unpriced revenue from profit so it's not misleading
      const pricedRevenue = b.revenue - (b.unpricedRevenue || 0);
      const profit = pricedRevenue - b.cogs - b.shipping - b.commission - b.adSpend;
      return { period, ...b, pricedRevenue, profit };
    });

  const totals = series.reduce((acc, s) => {
    acc.revenue += s.revenue; acc.cogs += s.cogs; acc.shipping += s.shipping;
    acc.commission += s.commission; acc.returnLoss += s.returnLoss;
    acc.adSpend += s.adSpend; acc.profit += s.profit;
    return acc;
  }, { revenue: 0, cogs: 0, shipping: 0, commission: 0, returnLoss: 0, adSpend: 0, profit: 0 });

  return {
    series, totals,
    unpricedSkus: [...unpricedSkus],
    unpricedRevenue,
  };
}


// ═══════════════════════════════════════════════════════════════════
// PROJECTIONS
//
// Two methods, shown side by side rather than picking one:
//   - linear:      ordinary least-squares fit of CUMULATIVE profit vs.
//                  period index. Conservative/steady — treats the
//                  recent trend as a straight line forward.
//   - growthRate:  average period-over-period % change in profit,
//                  compounded forward. More realistic if the business
//                  is actually accelerating (or decelerating), but
//                  needs a real recent trend to be meaningful and is
//                  more volatile with limited history.
//
// Both report: current cumulative profit, projected cumulative profit
// N periods ahead, and — if not yet profitable — the period at which
// cumulative profit is projected to cross zero (breakeven).
// ═══════════════════════════════════════════════════════════════════
export function projectProfit(series, periodsAhead = 8) {
  if (!series.length) return null;

  const cumulative = [];
  let running = 0;
  for (const s of series) { running += s.profit; cumulative.push(running); }
  const n = cumulative.length;
  const currentCumulative = cumulative[n - 1];

  const linear = linearProjection(cumulative, periodsAhead);
  const growthRate = growthRateProjection(series, cumulative, periodsAhead);

  return {
    currentCumulativeProfit: currentCumulative,
    isProfitableNow: currentCumulative > 0,
    periodsOfHistory: n,
    linear,
    growthRate,
  };
}

function linearProjection(cumulative, periodsAhead) {
  const n = cumulative.length;
  if (n < 2) return { available: false, reason: 'Need at least 2 periods of history.' };

  // Least-squares fit: x = period index (0..n-1), y = cumulative profit
  const xs = cumulative.map((_, i) => i);
  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = cumulative.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xMean) * (cumulative[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = yMean - slope * xMean;

  const projected = [];
  for (let i = 1; i <= periodsAhead; i++) {
    projected.push(intercept + slope * (n - 1 + i));
  }

  let breakevenPeriodsFromNow = null;
  const current = cumulative[n - 1];
  if (current <= 0 && slope > 0) {
    // Solve intercept + slope*x = 0 for x, relative to "now" (index n-1)
    const xZero = -intercept / slope;
    breakevenPeriodsFromNow = Math.ceil(xZero - (n - 1));
    if (breakevenPeriodsFromNow < 0) breakevenPeriodsFromNow = null; // already past — inconsistent trend, don't claim a date
  }

  return {
    available: true,
    slopePerPeriod: +slope.toFixed(2),
    projectedCumulative: projected.map(v => +v.toFixed(2)),
    breakevenPeriodsFromNow,
    trending: slope > 0 ? 'up' : slope < 0 ? 'down' : 'flat',
  };
}

function growthRateProjection(series, cumulative, periodsAhead) {
  // Revenue is always >= 0, so its period-over-period growth rate is a
  // coherent thing to compound. Profit/loss is a signed figure that
  // can cross zero — compounding a growth rate directly onto a
  // negative-but-improving profit number is mathematically backwards
  // (multiplying a negative by (1+rate) with rate>0 makes it MORE
  // negative, not less). Instead: grow revenue, then apply the recent
  // average profit margin to derive projected profit.
  const recent = series.slice(-8);
  if (recent.length < 3) return { available: false, reason: 'Need at least 3 periods of history.' };

  const revenues = recent.map(s => s.revenue);
  const rates = [];
  for (let i = 1; i < revenues.length; i++) {
    if (revenues[i - 1] <= 0) continue; // no meaningful growth rate off a zero revenue base
    rates.push((revenues[i] - revenues[i - 1]) / revenues[i - 1]);
  }
  const avgRevenueGrowthRate = rates.length
    ? Math.max(-0.5, Math.min(0.5, rates.reduce((a, b) => a + b, 0) / rates.length))
    : 0;

  // Margin (profit ÷ revenue) is trended forward too, not frozen at a
  // flat average — a business with genuinely improving unit economics
  // (the common early-D2C pattern: losses shrinking as it scales)
  // would otherwise get its real recent improvement diluted by older,
  // worse weeks sitting in the same averaging window.
  const marginPoints = recent.filter(s => s.revenue > 0).map(s => s.profit / s.revenue);
  const avgMargin = marginPoints.length ? marginPoints.reduce((a, b) => a + b, 0) / marginPoints.length : 0;
  const marginSlope = linearSlope(marginPoints); // ∆margin per period, 0 if <2 points

  let lastRevenue = revenues[revenues.length - 1] || 0;
  let cum = cumulative[cumulative.length - 1];
  const startedNegative = cum <= 0;
  const projected = [];
  let breakevenPeriodsFromNow = null;
  let projectedMargin = marginPoints.length ? marginPoints[marginPoints.length - 1] : avgMargin;

  for (let i = 1; i <= periodsAhead; i++) {
    lastRevenue = lastRevenue * (1 + avgRevenueGrowthRate);
    projectedMargin = Math.max(-1, Math.min(1, projectedMargin + marginSlope)); // clamp to [-100%, 100%]
    const periodProfit = lastRevenue * projectedMargin;
    cum += periodProfit;
    projected.push(+cum.toFixed(2));
    if (breakevenPeriodsFromNow === null && startedNegative && cum > 0) {
      breakevenPeriodsFromNow = i;
    }
  }

  return {
    available: true,
    avgRevenueGrowthRatePerPeriod: +(avgRevenueGrowthRate * 100).toFixed(1), // as a %
    avgProfitMargin: +(avgMargin * 100).toFixed(1),                          // as a %, for display only
    marginTrendPerPeriod: +(marginSlope * 100).toFixed(2),                   // as a %, for display only
    projectedCumulative: projected,
    breakevenPeriodsFromNow,
    trending: marginSlope > 0 ? 'up' : marginSlope < 0 ? 'down' : (avgMargin >= 0 ? 'up' : 'flat'),
  };
}

// Simple OLS slope of a sequence of y-values against their index (0,1,2,...).
function linearSlope(values) {
  const n = values.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (values[i] - yMean);
    den += (i - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den;
}
