// lib/dataHealthChecker.js
// ─────────────────────────────────────────────────────────────────
// SCHEDULED DATA HEALTH CHECKS
//
// Runs every 6 hours via syncScheduler.js
// Checks all platforms for data integrity issues and
// writes findings to data_health_log table.
//
// Also exposed as POST /clients/:slug/health-check for manual runs.
// ─────────────────────────────────────────────────────────────────
import Anthropic        from '@anthropic-ai/sdk';
import { supabaseAdmin } from './supabase.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL     = 'claude-sonnet-4-6';

// ═══════════════════════════════════════════════════════════════════
// MAIN ENTRY — runHealthCheck
// ═══════════════════════════════════════════════════════════════════
export async function runHealthCheck(clientId) {
  console.log(`[health] Running data health check for client ${clientId}`);

  try {
    // 1. Get last 30 days of revenue data summary
    const since = new Date();
    since.setDate(since.getDate() - 30);
    const sinceStr = since.toISOString().slice(0, 10);

    const { data: rows } = await supabaseAdmin
      .from('revenue_data')
      .select('platform, standard_revenue, standard_units, standard_status, standard_order_id, order_date')
      .eq('client_id', clientId)
      .gte('order_date', sinceStr)
      .limit(10000);

    if (!rows || !rows.length) {
      console.log('[health] No data in last 30 days — skipping health check');
      return;
    }

    // 2. Build platform-level stats
    const byPlatform = {};
    for (const row of rows) {
      const p = row.platform || 'unknown';
      if (!byPlatform[p]) byPlatform[p] = {
        platform: p, totalRows: 0, totalRevenue: 0,
        totalUnits: 0, cancelledRows: 0, activeRows: 0,
        orderIds: new Set(),
      };
      byPlatform[p].totalRows++;
      byPlatform[p].totalRevenue += Number(row.standard_revenue) || 0;
      byPlatform[p].totalUnits   += Number(row.standard_units)   || 0;
      if (row.standard_status === 'Cancelled') byPlatform[p].cancelledRows++;
      else if (row.standard_revenue > 0) byPlatform[p].activeRows++;
      if (row.standard_order_id) byPlatform[p].orderIds.add(row.standard_order_id);
    }

    // Convert Sets to counts
    const platformStats = Object.values(byPlatform).map(p => ({
      ...p,
      uniqueOrders:     p.orderIds.size,
      cancellationRate: p.orderIds.size > 0
        ? (p.cancelledRows / p.orderIds.size * 100).toFixed(1)
        : 0,
      aov: p.activeRows > 0 ? (p.totalRevenue / p.activeRows).toFixed(0) : 0,
    }));

    // 3. Check when data was last uploaded per platform
    const { data: lastUploads } = await supabaseAdmin
      .from('uploads')
      .select('detected_platform, completed_at, status')
      .eq('client_id', clientId)
      .eq('status', 'success')
      .order('completed_at', { ascending: false })
      .limit(20);

    const lastUploadByPlatform = {};
    for (const u of (lastUploads || [])) {
      const p = u.detected_platform;
      if (!lastUploadByPlatform[p]) lastUploadByPlatform[p] = u.completed_at;
    }

    // 4. Build health issues list
    const issues = [];
    const now = new Date();

    for (const p of platformStats) {
      const lastUpload = lastUploadByPlatform[p.platform];
      if (lastUpload) {
        const hoursSince = (now - new Date(lastUpload)) / 3600000;
        if (hoursSince > 48) {
          issues.push({
            severity: 'warning',
            platform: p.platform,
            code: 'STALE_DATA',
            message: `${p.platform} data hasn't been updated in ${Math.round(hoursSince / 24)} days`,
          });
        }
      } else {
        issues.push({
          severity: 'info',
          platform: p.platform,
          code: 'NO_RECENT_UPLOAD',
          message: `No recent uploads found for ${p.platform}`,
        });
      }

      const cancelRate = parseFloat(p.cancellationRate);
      if (cancelRate > 30) {
        issues.push({
          severity: 'warning',
          platform: p.platform,
          code: 'HIGH_CANCELLATION',
          message: `${p.platform} has ${cancelRate}% cancellation rate over last 30 days`,
        });
      }

      const aov = parseFloat(p.aov);
      if (aov > 0 && aov < 50) {
        issues.push({
          severity: 'error',
          platform: p.platform,
          code: 'SUSPICIOUS_AOV',
          message: `${p.platform} AOV is ₹${aov} — may indicate revenue calculation error`,
        });
      }
    }

    // 5. Call Claude for summary analysis
    const aiSummary = await callClaudeHealthAnalysis(platformStats, issues, lastUploadByPlatform);

    // 6. Write to data_health_log
    const { error } = await supabaseAdmin
      .from('data_health_log')
      .insert({
        client_id:      clientId,
        checked_at:     new Date().toISOString(),
        platform_stats: platformStats.map(p => ({ ...p, orderIds: undefined })),
        issues,
        ai_summary:     aiSummary.summary,
        ai_recommendations: aiSummary.recommendations,
        overall_status: issues.filter(i => i.severity === 'error').length > 0 ? 'error'
          : issues.filter(i => i.severity === 'warning').length > 0 ? 'warning' : 'ok',
      });

    if (error) console.error('[health] Failed to write health log:', error.message);

    console.log(`[health] ✓ Health check complete — ${issues.length} issues found`);
    return { issues, platformStats };

  } catch (err) {
    console.error('[health] Health check failed:', err.message);
  }
}


async function callClaudeHealthAnalysis(platformStats, issues, lastUploads) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { summary: 'Health check complete.', recommendations: [] };
  }

  const statsText = platformStats.map(p =>
    `${p.platform}: ₹${(p.totalRevenue/100000).toFixed(2)}L revenue, ${p.uniqueOrders} orders, ${p.cancellationRate}% cancellation, AOV ₹${p.aov}, last upload: ${lastUploads[p.platform] ? new Date(lastUploads[p.platform]).toLocaleDateString('en-IN') : 'unknown'}`
  ).join('\n');

  const issuesText = issues.length
    ? issues.map(i => `[${i.severity.toUpperCase()}] ${i.platform || 'all'}: ${i.message}`).join('\n')
    : 'No issues detected';

  const prompt = `You are a data quality analyst for an Indian D2C e-commerce brand.
Review this 30-day data health report and provide a brief summary and recommendations.

PLATFORM STATS (last 30 days):
${statsText}

ISSUES DETECTED:
${issuesText}

Respond with JSON only:
{
  "summary": "2-3 sentence health summary for the business owner",
  "recommendations": ["actionable recommendation 1", "actionable recommendation 2"]
}`;

  try {
    const msg = await anthropic.messages.create({
      model: MODEL, max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });
    const parsed = JSON.parse(msg.content[0]?.text?.replace(/```json|```/g, '').trim() || '{}');
    return {
      summary: parsed.summary || 'Health check complete.',
      recommendations: parsed.recommendations || [],
    };
  } catch (err) {
    return { summary: 'Health check complete.', recommendations: [] };
  }
}
