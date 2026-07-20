// lib/insightGenerator.js
// ─────────────────────────────────────────────────────────────────
// INSIGHT GENERATION PIPELINE
//
// Called after a successful file ingestion (or on-demand by admin).
//
// Pipeline:
//   1. Pull a data summary from revenue_data + campaign_data
//      for this client (last 30 days, or since the upload's date)
//   2. Collect raw_extras samples (unmapped columns) from the upload
//   3. Build a structured prompt and call claude-sonnet-4-6
//   4. Parse the JSON response into typed insight objects
//   5. Soft-delete previous active insights, insert new batch
//
// Called from fileIngestion.js (fire-and-forget after upload success)
// and from insightsRouter.js (on-demand regenerate endpoint).
// ─────────────────────────────────────────────────────────────────
import Anthropic       from '@anthropic-ai/sdk';
import { supabaseAdmin } from './supabase.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL      = 'claude-sonnet-4-6';
const MAX_TOKENS = 1500;


// ═══════════════════════════════════════════════════════════════════
// MAIN ENTRY — generateInsights
//
// Parameters:
//   clientId  — UUID
//   uploadId  — UUID (the upload that triggered this run, or null for manual)
//   platform  — string | null  (scope to one platform, or null for all)
//   dataType  — 'revenue' | 'campaign' | null
//
// Returns:
//   { insights: Array<InsightRow>, tokensUsed: number }
// ═══════════════════════════════════════════════════════════════════
export async function generateInsights({ clientId, uploadId = null, platform = null }) {
  console.log(`[insights] Generating for client=${clientId} upload=${uploadId}`);

  // 1. Build data summary
  const summary = await buildDataSummary(clientId, platform);

  if (!summary.hasData) {
    console.log('[insights] No data available to analyse — skipping generation.');
    return { insights: [], tokensUsed: 0 };
  }

  // 2. Build prompt
  const prompt = buildPrompt(summary);

  // 3. Call Claude
  let rawResponse;
  try {
    const message = await anthropic.messages.create({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      messages:   [{ role: 'user', content: prompt }],
    });
    rawResponse = message.content[0]?.text || '';
    var tokensUsed = message.usage.input_tokens + message.usage.output_tokens;
  } catch (err) {
    console.error('[insights] Anthropic API error:', err.message);
    throw new Error('AI generation failed: ' + err.message);
  }

  // 4. Parse insights from response
  const parsed = parseInsightResponse(rawResponse);
  if (!parsed.length) {
    console.warn('[insights] No parseable insights in response.');
    return { insights: [], tokensUsed };
  }

  // 5. Soft-delete previous active insights for this client
  await supabaseAdmin
    .from('ai_insights')
    .update({ is_active: false })
    .eq('client_id', clientId)
    .eq('is_active', true);

  // 6. Insert new insights
  const rows = parsed.map(ins => ({
    client_id:    clientId,
    upload_id:    uploadId,
    insight_type: ins.type,
    tag:          ins.tag,
    body:         ins.body,
    confidence:   ins.confidence,
    platform:     ins.platform || null,
    sku:          ins.sku || null,
    model:        MODEL,
    is_active:    true,
  }));

  const { data: inserted, error } = await supabaseAdmin
    .from('ai_insights')
    .insert(rows)
    .select('id');

  if (error) {
    console.error('[insights] Insert error:', error.message);
    throw new Error('Failed to store insights: ' + error.message);
  }

  console.log(`[insights] ✓ Generated ${inserted.length} insights (${tokensUsed} tokens)`);
  return { insights: rows, tokensUsed };
}


// ═══════════════════════════════════════════════════════════════════
// BUILD DATA SUMMARY
// Pulls aggregated numbers from Supabase to feed into the prompt.
// ═══════════════════════════════════════════════════════════════════
async function buildDataSummary(clientId, platformFilter) {
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const sinceStr = since.toISOString().split('T')[0];

  // Revenue data
  let revQuery = supabaseAdmin
    .from('revenue_data')
    .select('platform, standard_sku, standard_revenue, standard_units, standard_city, standard_state, order_date, raw_extras')
    .eq('client_id', clientId)
    .gte('order_date', sinceStr)
    .order('order_date', { ascending: false })
    .limit(2000);

  if (platformFilter) revQuery = revQuery.eq('platform', platformFilter);

  // Campaign data
  let campQuery = supabaseAdmin
    .from('campaign_data')
    .select('platform, campaign_name, standard_spend, standard_revenue, standard_impressions, standard_clicks, standard_orders, campaign_date, raw_extras')
    .eq('client_id', clientId)
    .gte('campaign_date', sinceStr)
    .order('campaign_date', { ascending: false })
    .limit(500);

  if (platformFilter) campQuery = campQuery.eq('platform', platformFilter);

  const [{ data: revRows }, { data: campRows }] = await Promise.all([revQuery, campQuery]);

  if (!revRows?.length && !campRows?.length) {
    return { hasData: false };
  }

  // ── Aggregate revenue ──────────────────────────────────────────
  const byPlatform = {};
  const bySku      = {};
  const byCity     = {};
  const byWeek     = {};
  let   totalRev = 0, totalUnits = 0;

  for (const r of (revRows || [])) {
    const rev   = Number(r.standard_revenue) || 0;
    const units = Number(r.standard_units)   || 0;
    totalRev   += rev;
    totalUnits += units;

    const p = r.platform || 'unknown';
    byPlatform[p] = byPlatform[p] || { revenue: 0, units: 0 };
    byPlatform[p].revenue += rev;
    byPlatform[p].units   += units;

    const s = r.standard_sku || 'unknown';
    bySku[s] = bySku[s] || { revenue: 0, units: 0 };
    bySku[s].revenue += rev;
    bySku[s].units   += units;

    const c = r.standard_city || 'unknown';
    byCity[c] = (byCity[c] || 0) + rev;

    if (r.order_date) {
      const d = new Date(r.order_date);
      const wk = `W${Math.ceil(d.getDate() / 7)}-${d.getMonth()+1}`;
      byWeek[wk] = byWeek[wk] || { revenue: 0, orders: 0 };
      byWeek[wk].revenue += rev;
      byWeek[wk].orders  += 1;
    }
  }

  // ── Aggregate campaigns ────────────────────────────────────────
  let totalSpend = 0, totalCampRev = 0, totalClicks = 0, totalImpr = 0;
  const campByPlatform = {};

  for (const c of (campRows || [])) {
    const spend = Number(c.standard_spend)       || 0;
    const crev  = Number(c.standard_revenue)     || 0;
    const clk   = Number(c.standard_clicks)      || 0;
    const impr  = Number(c.standard_impressions) || 0;
    totalSpend   += spend;
    totalCampRev += crev;
    totalClicks  += clk;
    totalImpr    += impr;

    const p = c.platform || 'unknown';
    campByPlatform[p] = campByPlatform[p] || { spend: 0, revenue: 0, clicks: 0, impressions: 0, campaigns: [] };
    campByPlatform[p].spend       += spend;
    campByPlatform[p].revenue     += crev;
    campByPlatform[p].clicks      += clk;
    campByPlatform[p].impressions += impr;
    if (c.campaign_name) campByPlatform[p].campaigns.push(c.campaign_name);
  }

  // ── Top items ─────────────────────────────────────────────────
  const topSkus  = Object.entries(bySku)
    .sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 5)
    .map(([sku, d]) => ({ sku, ...d }));

  const topCities = Object.entries(byCity)
    .sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([city, revenue]) => ({ city, revenue }));

  const weeklyTrend = Object.entries(byWeek)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, d]) => ({ week, ...d }));

  // ── Raw extras sample (unmapped columns from vendor files) ─────
  const extrasMap = {};
  for (const r of (revRows || []).slice(0, 100)) {
    if (r.raw_extras && typeof r.raw_extras === 'object') {
      Object.keys(r.raw_extras).forEach(k => { extrasMap[k] = (extrasMap[k] || 0) + 1; });
    }
  }
  const extraFields = Object.entries(extrasMap)
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([field]) => field);

  return {
    hasData: true,
    period:  `Last 30 days (since ${sinceStr})`,
    revenue: {
      total:  totalRev,
      units:  totalUnits,
      byPlatform: Object.entries(byPlatform)
        .sort((a, b) => b[1].revenue - a[1].revenue)
        .map(([platform, d]) => ({ platform, ...d })),
      topSkus,
      topCities,
      weeklyTrend,
    },
    campaigns: {
      totalSpend,
      totalRevenue: totalCampRev,
      blendedRoas: totalSpend > 0 ? +(totalCampRev / totalSpend).toFixed(2) : 0,
      totalClicks,
      totalImpressions: totalImpr,
      avgCTR: totalImpr > 0 ? +((totalClicks / totalImpr) * 100).toFixed(3) : 0,
      byPlatform: Object.entries(campByPlatform)
        .map(([platform, d]) => ({
          platform,
          roas: d.spend > 0 ? +(d.revenue / d.spend).toFixed(2) : 0,
          ...d,
          campaigns: [...new Set(d.campaigns)].slice(0, 3),
        }))
        .sort((a, b) => b.revenue - a.revenue),
    },
    extraFields,
    rowCount: revRows?.length || 0,
    campCount: campRows?.length || 0,
  };
}


// ═══════════════════════════════════════════════════════════════════
// BUILD PROMPT
// ═══════════════════════════════════════════════════════════════════
function buildPrompt(summary) {
  const { revenue, campaigns, period, extraFields } = summary;

  const platformRevLines = revenue.byPlatform.map(p =>
    `  - ${p.platform}: ₹${fmt(p.revenue)} revenue, ${p.units} units`
  ).join('\n');

  const skuLines = revenue.topSkus.map((s, i) =>
    `  ${i+1}. ${s.sku}: ₹${fmt(s.revenue)} (${s.units} units)`
  ).join('\n');

  const cityLines = revenue.topCities.slice(0, 6).map(c =>
    `  - ${c.city}: ₹${fmt(c.revenue)}`
  ).join('\n');

  const campLines = campaigns.byPlatform.map(p =>
    `  - ${p.platform}: spend ₹${fmt(p.spend)}, revenue ₹${fmt(p.revenue)}, RoAS ${p.roas}x, CTR ${((p.clicks/(p.impressions||1))*100).toFixed(2)}%`
  ).join('\n');

  const trendLines = revenue.weeklyTrend.map(w =>
    `  ${w.week}: ₹${fmt(w.revenue)} (${w.orders} orders)`
  ).join('\n');

  const extrasNote = extraFields.length
    ? `\nUnmapped vendor columns available in raw_extras (may contain additional signals): ${extraFields.join(', ')}`
    : '';

  return `You are a senior e-commerce performance analyst for an Indian D2C brand. Analyse the following data summary and generate exactly 4 actionable insights.

ANALYSIS PERIOD: ${period}

REVENUE DATA:
Total revenue: ₹${fmt(revenue.total)} | Total units: ${revenue.units}
By platform:
${platformRevLines}

Top SKUs:
${skuLines}

Top cities by revenue:
${cityLines}

Weekly revenue trend:
${trendLines}

CAMPAIGN DATA:
Total ad spend: ₹${fmt(campaigns.totalSpend)} | Total campaign revenue: ₹${fmt(campaigns.totalRevenue)}
Blended RoAS: ${campaigns.blendedRoas}x | Avg CTR: ${campaigns.avgCTR}%
By platform:
${campLines}
${extrasNote}

INSTRUCTIONS:
Generate exactly 4 insights covering these topics (one each):
1. Inventory / stock velocity risk (based on units sold rate)
2. Geographic opportunity (underserved cities or states vs spend allocation)
3. RoAS or campaign efficiency signal (compression, opportunity, or anomaly)
4. Platform mix or channel opportunity

Respond ONLY with a valid JSON array. No preamble, no markdown, no backticks.
Each object must have exactly these fields:
- "type": one of "warn", "positive", or "neutral"
- "tag": a short emoji + label string, max 40 chars (e.g. "⚠ Inventory Burn Rate")
- "body": 2-3 sentence actionable insight. Include specific numbers from the data. Use HTML <strong> tags for key figures only.
- "confidence": a number 0-100 representing your confidence in this insight
- "platform": the most relevant platform string, or null if cross-platform
- "sku": the most relevant SKU, or null if cross-SKU

Example format:
[
  {
    "type": "warn",
    "tag": "⚠ Inventory Burn Rate",
    "body": "At current velocity of <strong>512 units/day</strong>, stockout is projected in 18 days.",
    "confidence": 88,
    "platform": "amazon",
    "sku": "NE-MOIST-200ML"
  }
]`;
}

function fmt(n) {
  if (n >= 10000000) return (n / 10000000).toFixed(1) + 'Cr';
  if (n >= 100000)   return (n / 100000).toFixed(1) + 'L';
  if (n >= 1000)     return (n / 1000).toFixed(0) + 'K';
  return Math.round(n).toString();
}


// ═══════════════════════════════════════════════════════════════════
// PARSE INSIGHT RESPONSE
// ═══════════════════════════════════════════════════════════════════
function parseInsightResponse(raw) {
  try {
    // Strip any accidental markdown fences
    const cleaned = raw
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/,  '')
      .trim();

    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) throw new Error('Response is not an array');

    return parsed
      .filter(ins =>
        typeof ins.type === 'string'  &&
        typeof ins.tag  === 'string'  &&
        typeof ins.body === 'string'  &&
        ['warn', 'positive', 'neutral'].includes(ins.type)
      )
      .map(ins => ({
        type:       ins.type,
        tag:        ins.tag.slice(0, 60),
        body:       ins.body,
        confidence: typeof ins.confidence === 'number'
          ? Math.min(100, Math.max(0, ins.confidence))
          : null,
        platform:   ins.platform || null,
        sku:        ins.sku      || null,
      }));
  } catch (err) {
    console.error('[insights] Failed to parse AI response:', err.message);
    console.error('[insights] Raw response:', raw.slice(0, 500));
    return [];
  }
}
