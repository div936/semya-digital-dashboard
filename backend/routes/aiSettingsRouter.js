// routes/aiSettingsRouter.js
// Per-client AI provider settings (Gemini or Claude)
// GET  /clients/:client_slug/ai-settings  — get current AI config
// POST /clients/:client_slug/ai-settings  — save AI config

import { Router } from 'express';
import { rbacMiddleware } from '../middleware/rbac.js';
import { supabaseAdmin } from '../lib/supabase.js';

const router = Router({ mergeParams: true });

// GET — fetch current AI settings for this client
router.get('/:client_slug/ai-settings', rbacMiddleware, async (req, res) => {
  const { client } = req.semya;
  try {
    const { data, error } = await supabaseAdmin
      .from('clients')
      .select('ai_provider, ai_model, ai_key_set')
      .eq('id', client.id)
      .single();

    if (error) throw error;

    return res.json({
      ai_provider: data.ai_provider || null,
      ai_model:    data.ai_model    || null,
      ai_key_set:  data.ai_key_set  || false,  // never expose the actual key
    });
  } catch (err) {
    console.error('[ai-settings GET]', err.message);
    return res.status(500).json({ error: 'Failed to fetch AI settings.' });
  }
});

// POST — save AI settings for this client
router.post('/:client_slug/ai-settings', rbacMiddleware, async (req, res) => {
  const { client } = req.semya;
  const { ai_provider, ai_model, ai_api_key } = req.body || {};

  // Validate provider
  const validProviders = ['gemini', 'claude'];
  if (ai_provider && !validProviders.includes(ai_provider)) {
    return res.status(400).json({ error: 'Invalid AI provider. Use gemini or claude.' });
  }

  try {
    const updates = {};

    if (ai_provider !== undefined) updates.ai_provider = ai_provider;
    if (ai_model    !== undefined) updates.ai_model    = ai_model;

    // Only update key if provided (don't wipe existing key if not sent)
    if (ai_api_key) {
      updates.ai_api_key = ai_api_key;
      updates.ai_key_set = true;
    }

    // Allow clearing the key
    if (ai_api_key === '') {
      updates.ai_api_key = null;
      updates.ai_key_set = false;
      updates.ai_provider = null;
      updates.ai_model    = null;
    }

    const { error } = await supabaseAdmin
      .from('clients')
      .update(updates)
      .eq('id', client.id);

    if (error) throw error;

    return res.json({ ok: true, message: 'AI settings saved successfully.' });
  } catch (err) {
    console.error('[ai-settings POST]', err.message);
    return res.status(500).json({ error: 'Failed to save AI settings.' });
  }
});

export default router;
