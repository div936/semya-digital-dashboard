// routes/insightsRouter.js
// ─────────────────────────────────────────────────────────────────
// GET  /clients/:client_slug/ai-insights
//   Returns latest active insights for the client.
//   Query params: ?limit=10  ?type=warn|positive|neutral
//
// POST /clients/:client_slug/ai-insights/generate  (admin only)
//   Triggers on-demand regeneration and returns the new insights.
//
// Mount in app.js:
//   import insightsRouter from './routes/insightsRouter.js';
//   app.use('/clients', insightsRouter);
// ─────────────────────────────────────────────────────────────────
import { Router }          from 'express';
import Anthropic            from '@anthropic-ai/sdk';
import { rbacMiddleware, requireTab } from '../middleware/rbac.js';
import { supabaseAdmin }   from '../lib/supabase.js';
import { generateInsights, generateNarrativeSummaries } from '../lib/insightGenerator.js';

const router = Router({ mergeParams: true });

const VALID_SCOPES = new Set(['all', 'amazon', 'acutas', 'flipkart', 'blinkit', 'meta', 'google']);

// ─── GET /clients/:client_slug/ai-summary ─────────────────────────
// The sidebar "smart suggestion" widget. Always a plain read of the
// last-generated cache — never triggers a live Claude call, so
// switching the platform filter is instant and free.
// Query params: ?scope=all|amazon|acutas|flipkart|blinkit|meta|google
router.get(
  '/:client_slug/ai-summary',
  rbacMiddleware,
  async (req, res) => {
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

    return res.json({
      scope,
      summary: data || null, // null = never generated yet for this client at all
    });
  }
);


// ─── POST /clients/:client_slug/ai-summary/regenerate ─────────────
router.post(
  '/:client_slug/ai-summary/regenerate',
  rbacMiddleware,
  async (req, res) => {
    if (!req.semya.isAdmin) {
      return res.status(403).json({ error: 'Admin access required to regenerate summaries.' });
    }
    const { client } = req.semya;
    try {
      const result = await generateNarrativeSummaries({ clientId: client.id });
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error('[ai-summary regenerate]', err.message);
      return res.status(500).json({ error: err.message });
    }
  }
);


// ─── GET /clients/:client_slug/ai-insights ────────────────────────
router.get(
  '/:client_slug/ai-insights',
  rbacMiddleware,
  requireTab('ai_insights'),
  async (req, res) => {
    const { client } = req.semya;
    const limit  = Math.min(parseInt(req.query.limit) || 10, 20);
    const type   = req.query.type;  // optional filter: warn | positive | neutral

    let query = supabaseAdmin
      .from('ai_insights')
      .select('id, insight_type, tag, body, confidence, platform, sku, generated_at, model')
      .eq('client_id', client.id)
      .eq('is_active', true)
      .order('generated_at', { ascending: false })
      .limit(limit);

    if (type && ['warn', 'positive', 'neutral'].includes(type)) {
      query = query.eq('insight_type', type);
    }

    const { data, error } = await query;

    if (error) {
      console.error('[insights GET]', error.message);
      return res.status(500).json({ error: 'Failed to fetch insights.' });
    }

    // Group by generated_at batch (same second = same run)
    const generatedAt = data?.[0]?.generated_at || null;

    return res.json({
      insights:    data || [],
      generatedAt,
      count:       data?.length || 0,
    });
  }
);


// ─── POST /clients/:client_slug/ai-insights/generate ─────────────
router.post(
  '/:client_slug/ai-insights/generate',
  rbacMiddleware,
  async (req, res) => {
    if (!req.semya.isAdmin) {
      return res.status(403).json({ error: 'Admin access required to regenerate insights.' });
    }

    const { client } = req.semya;
    const { platform } = req.body || {};

    try {
      const result = await generateInsights({
        clientId: client.id,
        uploadId: null,
        platform: platform || null,
      });

      return res.json({
        ok:         true,
        count:      result.insights.length,
        tokensUsed: result.tokensUsed,
        insights:   result.insights,
      });
    } catch (err) {
      console.error('[insights generate]', err.message);
      return res.status(500).json({ error: err.message });
    }
  }
);




// ─── POST /clients/:client_slug/claude-insight ───────────────────
// Streaming endpoint for the AI sidebar insight generation.
// Called by _streamClaudeInsight() in the frontend.
router.post(
  '/:client_slug/claude-insight',
  rbacMiddleware,
  async (req, res) => {
    const { client } = req.semya;
    const { prompt } = req.body || {};

    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'AI service not configured' });
    }

    try {
      // Use the already-imported Anthropic SDK (static import at top of file)
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      // Set headers for streaming
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('X-Accel-Buffering', 'no');

      const stream = anthropic.messages.stream({
        model:      'claude-sonnet-4-6',
        max_tokens: 800,
        messages:   [{ role: 'user', content: prompt }],
      });

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          res.write(event.delta.text);
        }
      }
      res.end();
    } catch (err) {
      console.error('[claude-insight]', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      } else {
        res.end();
      }
    }
  }
);

export default router;
