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
import { rbacMiddleware, requireTab } from '../middleware/rbac.js';
import { supabaseAdmin }   from '../lib/supabase.js';
import { generateInsights } from '../lib/insightGenerator.js';

const router = Router({ mergeParams: true });


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


export default router;
