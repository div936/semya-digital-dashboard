// routes/insightsRouter.js
// ─────────────────────────────────────────────────────────────────
// AI Insights — uses Google Gemini (free) instead of Claude
// ─────────────────────────────────────────────────────────────────
import { Router }        from 'express';
import { rbacMiddleware, requireTab } from '../middleware/rbac.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { generateInsights, generateNarrativeSummaries } from '../lib/insightGenerator.js';

const router = Router({ mergeParams: true });

const VALID_SCOPES = new Set(['all', 'amazon', 'acutas', 'flipkart', 'blinkit', 'meta', 'google']);

// ─── GET /clients/:client_slug/ai-summary ─────────────────────────
router.get('/:client_slug/ai-summary', rbacMiddleware, async (req, res) => {
  const { client } = req.semya;
  const scope = VALID_SCOPES.has(req.query.scope) ? req.query.scope : 'all';
  const { data, error } = await supabaseAdmin
    .from('ai_narrative_summaries')
    .select('scope, narrative, pointers, confidence, has_data, generated_at')
    .eq('client_id', client.id)
    .eq('scope', scope)
    .maybeSingle();
  if (error) {
    console.error('[ai-summary GET]', error.message);
    return res.status(500).json({ error: 'Failed to fetch summary.' });
  }
  return res.json({ scope, summary: data || null });
});

// ─── POST /clients/:client_slug/ai-summary/regenerate ─────────────
router.post('/:client_slug/ai-summary/regenerate', rbacMiddleware, async (req, res) => {
  if (!req.semya.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  const { client } = req.semya;
  try {
    const result = await generateNarrativeSummaries({ clientId: client.id });
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[ai-summary regenerate]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /clients/:client_slug/ai-insights ────────────────────────
router.get('/:client_slug/ai-insights', rbacMiddleware, requireTab('ai_insights'), async (req, res) => {
  const { client } = req.semya;
  const limit = Math.min(parseInt(req.query.limit) || 10, 20);
  const type  = req.query.type;
  let query = supabaseAdmin
    .from('ai_insights')
    .select('id, insight_type, tag, body, confidence, platform, sku, generated_at, model')
    .eq('client_id', client.id)
    .eq('is_active', true)
    .order('generated_at', { ascending: false })
    .limit(limit);
  if (type && ['warn', 'positive', 'neutral'].includes(type)) query = query.eq('insight_type', type);
  const { data, error } = await query;
  if (error) {
    console.error('[insights GET]', error.message);
    return res.status(500).json({ error: 'Failed to fetch insights.' });
  }
  return res.json({ insights: data || [], generatedAt: data?.[0]?.generated_at || null, count: data?.length || 0 });
});

// ─── POST /clients/:client_slug/ai-insights/generate ─────────────
router.post('/:client_slug/ai-insights/generate', rbacMiddleware, async (req, res) => {
  if (!req.semya.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  const { client } = req.semya;
  const { platform } = req.body || {};
  try {
    const result = await generateInsights({ clientId: client.id, uploadId: null, platform: platform || null });
    return res.json({ ok: true, count: result.insights.length, tokensUsed: result.tokensUsed, insights: result.insights });
  } catch (err) {
    console.error('[insights generate]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /clients/:client_slug/claude-insight ───────────────────
// Uses Gemini (free) instead of Claude
router.post('/:client_slug/claude-insight', rbacMiddleware, async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) return res.status(503).json({ error: 'AI service not configured' });

  try {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');

    // Gemini streaming API
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 800 },
        }),
      }
    );

    if (!geminiRes.ok) {
      const err = await geminiRes.text();
      console.error('[gemini-insight] API error:', err);
      return res.status(500).json({ error: 'Gemini API error' });
    }

    // Stream the response
    const reader = geminiRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (jsonStr === '[DONE]') continue;
        try {
          const parsed = JSON.parse(jsonStr);
          const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) res.write(text);
        } catch (_) {}
      }
    }
    res.end();
  } catch (err) {
    console.error('[gemini-insight]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

export default router;
