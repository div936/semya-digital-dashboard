// routes/insightsRouter.js
// AI Insights — supports per-client Gemini or Claude key
// Falls back to admin GEMINI_API_KEY if client has none

import { Router }        from 'express';
import { rbacMiddleware, requireTab } from '../middleware/rbac.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { generateInsights, generateNarrativeSummaries } from '../lib/insightGenerator.js';

const router = Router({ mergeParams: true });

const VALID_SCOPES = new Set(['all', 'amazon', 'acutas', 'flipkart', 'blinkit', 'meta', 'google']);

// ─── Helper: get AI config for this client ────────────────────────
async function getClientAiConfig(clientId) {
  // Wrapped in try/catch: ai_provider, ai_model, ai_api_key columns may not
  // exist yet if the AI settings migration hasn't been run. A missing column
  // causes Supabase to throw, which previously 500'd every claude-insight
  // request. Treat any failure here as "no client AI key configured" and fall
  // through to the admin env-var key — same as if the columns existed but
  // were empty. This is the same defensive pattern used for registered_brands
  // and access_expires_at elsewhere in the codebase.
  let data = null;
  try {
    const result = await supabaseAdmin
      .from('clients')
      .select('ai_provider, ai_model, ai_api_key')
      .eq('id', clientId)
      .maybeSingle();
    data = result.data;
  } catch (_) { /* columns may not exist yet — fall through to env key */ }

  if (data?.ai_api_key) {
    return {
      provider: data.ai_provider || 'gemini',
      model:    data.ai_model    || (data.ai_provider === 'claude' ? 'claude-haiku-4-5-20251001' : 'gemini-1.5-flash'),
      apiKey:   data.ai_api_key,
      source:   'client',
    };
  }

  // Fallback to admin Gemini key from environment
  if (process.env.GEMINI_API_KEY) {
    return {
      provider: 'gemini',
      model:    'gemini-1.5-flash',
      apiKey:   process.env.GEMINI_API_KEY,
      source:   'admin',
    };
  }

  return null; // No AI configured anywhere
}

// ─── SSE helper — write a plain-text chunk as an SSE data line ────
// Both streamGemini and streamClaude use this so the frontend only
// needs one parser regardless of which provider is active.
function sseWrite(res, text) {
  if (text) res.write('data: ' + JSON.stringify({ text }) + '\n\n');
}

// ─── Stream Gemini response ───────────────────────────────────────
async function streamGemini(apiKey, model, prompt, res) {
  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`,
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
    throw new Error('Gemini API error: ' + geminiRes.status);
  }

  const reader = geminiRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const jsonStr = line.slice(6).trim();
      if (jsonStr === '[DONE]') continue;
      try {
        const parsed = JSON.parse(jsonStr);
        const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
        // FIX: was res.write(text) — now uses SSE format so frontend parser works
        if (text) sseWrite(res, text);
      } catch (_) {}
    }
  }
}

// ─── Stream Claude response ───────────────────────────────────────
async function streamClaude(apiKey, model, prompt, res) {
  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      // FIX: removed invalid 'anthropic-beta: messages-2023-12-15' header
      // — streaming works with just anthropic-version, the beta header
      // caused 400 errors from the Anthropic API
    },
    body: JSON.stringify({
      model,
      max_tokens: 800,
      stream: true,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!claudeRes.ok) {
    const err = await claudeRes.text();
    console.error('[claude-insight] API error:', err);
    throw new Error('Claude API error: ' + claudeRes.status);
  }

  const reader = claudeRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const jsonStr = line.slice(6).trim();
      if (jsonStr === '[DONE]') continue;
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
          // FIX: was res.write(parsed.delta.text) — now uses SSE format
          sseWrite(res, parsed.delta.text);
        }
      } catch (_) {}
    }
  }
}

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
  if (error) return res.status(500).json({ error: 'Failed to fetch summary.' });
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
  if (error) return res.status(500).json({ error: 'Failed to fetch insights.' });
  return res.json({ insights: data || [], count: data?.length || 0 });
});

// ─── POST /clients/:client_slug/ai-insights/generate ─────────────
router.post('/:client_slug/ai-insights/generate', rbacMiddleware, async (req, res) => {
  if (!req.semya.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  const { client } = req.semya;
  const { platform } = req.body || {};
  try {
    const result = await generateInsights({ clientId: client.id, uploadId: null, platform: platform || null });
    return res.json({ ok: true, count: result.insights.length, insights: result.insights });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /clients/:client_slug/claude-insight ────────────────────
// Main AI streaming endpoint — auto-selects provider based on client config.
// Streams response as SSE: each chunk is sent as `data: {"text":"..."}\n\n`
// so the frontend's single parser works for both Gemini and Claude.
router.post('/:client_slug/claude-insight', rbacMiddleware, async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const { client } = req.semya;
  const aiConfig = await getClientAiConfig(client.id);

  // No AI key configured — tell frontend to show the unlock message
  if (!aiConfig) {
    return res.status(402).json({
      error: 'no_ai_key',
      message: 'No AI key configured. Add your API key in Settings → AI Settings to unlock AI Insights.',
    });
  }

  try {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-AI-Provider', aiConfig.provider);
    res.setHeader('X-AI-Source', aiConfig.source);

    if (aiConfig.provider === 'claude') {
      await streamClaude(aiConfig.apiKey, aiConfig.model, prompt, res);
    } else {
      await streamGemini(aiConfig.apiKey, aiConfig.model, prompt, res);
    }

    // Signal end of stream
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('[ai-insight]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

export default router;
