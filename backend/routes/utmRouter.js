// routes/utmRouter.js
// ─────────────────────────────────────────────────────────────────
// UTM TRACKING
//
// PUBLIC (no auth — called anonymously by the tracking snippets
// installed on the client's storefront):
//   GET  /clients/:client_slug/utm/click        (Snippet A, click ping)
//   POST /clients/:client_slug/utm/conversion    (Snippet B, checkout ping)
//
// ADMIN-GATED (requires the 'utm_analytics' tab to be enabled):
//   GET    /clients/:client_slug/utm/stats
//   GET    /clients/:client_slug/utm/attribution
//   GET    /clients/:client_slug/utm/campaign-details
//   GET    /clients/:client_slug/utm/links
//   POST   /clients/:client_slug/utm/links
//   DELETE /clients/:client_slug/utm/links/:id
//   GET    /clients/:client_slug/utm/snippets     (returns the ready-
//          to-paste Snippet A / B / C text, with this client's real
//          slug + API base baked in)
// ─────────────────────────────────────────────────────────────────
import { Router } from 'express';
import { rbacMiddleware, requireTab } from '../middleware/rbac.js';
import { supabaseAdmin } from '../lib/supabase.js';

const router = Router({ mergeParams: true });

// ── Shared helper: resolve a client by slug without requiring auth ──
// (public endpoints only — never used to leak anything beyond the id)
async function resolvePublicClient(slug) {
  const { data } = await supabaseAdmin.from('clients').select('id').eq('slug', slug).single();
  return data?.id || null;
}


// ═══════════════════════════════════════════════════════════════════
// PUBLIC — GET /clients/:client_slug/utm/click
// Called by Snippet A when a visitor lands with UTM params. Returns a
// 1x1 transparent GIF so it can be fired via <img> (no CORS needed).
// ═══════════════════════════════════════════════════════════════════
router.get('/:client_slug/utm/click', async (req, res) => {
  const clientId = await resolvePublicClient(req.params.client_slug);
  if (!clientId) return res.status(404).end();

  const { utm_source, utm_medium, utm_campaign, utm_term, utm_content, page } = req.query;

  const ipRaw = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  let ipHash = null;
  if (ipRaw) {
    const crypto = await import('crypto');
    ipHash = crypto.createHash('sha256').update(ipRaw).digest('hex').slice(0, 16);
  }

  await supabaseAdmin.from('utm_clicks').insert({
    client_id: clientId,
    utm_source: utm_source || null, utm_medium: utm_medium || null,
    utm_campaign: utm_campaign || null, utm_term: utm_term || null,
    utm_content: utm_content || null, page: page || null, ip_hash: ipHash,
  });

  const gif = Buffer.from('47494638396101000100800000ffffff00000021f90400000000002c00000000010001000002024401003b', 'hex');
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache' });
  return res.send(gif);
});


// ═══════════════════════════════════════════════════════════════════
// PUBLIC — POST /clients/:client_slug/utm/conversion
// Called by Snippet B (Shopify Customer Event Pixel) at checkout when
// a stored UTM session is found.
// ═══════════════════════════════════════════════════════════════════
router.post('/:client_slug/utm/conversion', async (req, res) => {
  const clientId = await resolvePublicClient(req.params.client_slug);
  if (!clientId) return res.status(404).json({ error: 'Unknown client.' });

  const p = req.body || {};
  const { error } = await supabaseAdmin.from('utm_conversions').insert({
    client_id: clientId,
    utm_source: p.utm_source || null, utm_medium: p.utm_medium || null,
    utm_campaign: p.utm_campaign || null, utm_term: p.utm_term || null,
    utm_content: p.utm_content || null,
    order_id: p.order_id || null,
    revenue: Number(p.revenue) || 0,
    type: p.type || 'assisted_conversion',
    days_to_convert: p.days_to_convert != null ? Number(p.days_to_convert) : null,
    first_seen: p.first_seen || null,
  });

  if (error) return res.status(500).json({ error: 'Failed to record conversion.' });
  return res.json({ status: 'ok' });
});


// ═══════════════════════════════════════════════════════════════════
// ADMIN — GET /clients/:client_slug/utm/stats
// Clicks + conversions joined per campaign, for the analytics table.
// ═══════════════════════════════════════════════════════════════════
router.get(
  '/:client_slug/utm/stats',
  rbacMiddleware,
  requireTab('utm_analytics'),
  async (req, res) => {
    const { client } = req.semya;
    const days = req.query.days ? parseInt(req.query.days) : 30;
    const since = days ? new Date(Date.now() - days * 86400000).toISOString() : null;

    let clickQ = supabaseAdmin
      .from('utm_clicks')
      .select('utm_campaign, utm_source, utm_medium')
      .eq('client_id', client.id)
      .not('utm_campaign', 'is', null);
    if (since) clickQ = clickQ.gte('clicked_at', since);

    let convQ = supabaseAdmin
      .from('utm_conversions')
      .select('utm_campaign, revenue')
      .eq('client_id', client.id)
      .not('utm_campaign', 'is', null);
    if (since) convQ = convQ.gte('converted_at', since);

    const [{ data: clicks, error: e1 }, { data: convs, error: e2 }] = await Promise.all([clickQ, convQ]);
    if (e1 || e2) return res.status(500).json({ error: 'Failed to fetch UTM stats.' });

    const byCampaign = {};
    for (const c of clicks || []) {
      const key = c.utm_campaign;
      if (!byCampaign[key]) byCampaign[key] = { campaign: key, source: c.utm_source, medium: c.utm_medium, clicks: 0, conversions: 0, revenue: 0 };
      byCampaign[key].clicks += 1;
    }
    for (const c of convs || []) {
      const key = c.utm_campaign;
      if (!byCampaign[key]) byCampaign[key] = { campaign: key, source: null, medium: null, clicks: 0, conversions: 0, revenue: 0 };
      byCampaign[key].conversions += 1;
      byCampaign[key].revenue += Number(c.revenue) || 0;
    }

    return res.json(Object.values(byCampaign).sort((a, b) => b.clicks - a.clicks));
  }
);


// ═══════════════════════════════════════════════════════════════════
// ADMIN — GET /clients/:client_slug/utm/attribution
// Assisted-conversion records — customer clicked an ad, bought later.
// ═══════════════════════════════════════════════════════════════════
router.get(
  '/:client_slug/utm/attribution',
  rbacMiddleware,
  requireTab('utm_analytics'),
  async (req, res) => {
    const { client } = req.semya;
    const days = req.query.days ? parseInt(req.query.days) : 30;
    const since = days ? new Date(Date.now() - days * 86400000).toISOString() : null;

    let q = supabaseAdmin
      .from('utm_conversions')
      .select('utm_campaign, utm_source, utm_medium, order_id, revenue, days_to_convert, first_seen, converted_at')
      .eq('client_id', client.id)
      .eq('type', 'assisted_conversion')
      .order('converted_at', { ascending: false })
      .limit(200);
    if (since) q = q.gte('converted_at', since);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: 'Failed to fetch attribution data.' });
    return res.json(data || []);
  }
);


// ═══════════════════════════════════════════════════════════════════
// ADMIN — GET /clients/:client_slug/utm/campaign-details
// Decodes campaign names into likely products by matching keywords in
// the campaign name against this client's actual SKUs/product names —
// e.g. "fb_neat_f1_sales_kalonji_oil" matching a SKU containing
// "kalonji" and "oil". Heuristic, not exact — campaign naming
// conventions vary by team.
// ═══════════════════════════════════════════════════════════════════
router.get(
  '/:client_slug/utm/campaign-details',
  rbacMiddleware,
  requireTab('utm_analytics'),
  async (req, res) => {
    const { client } = req.semya;
    const days = req.query.days ? parseInt(req.query.days) : 30;
    const since = days ? new Date(Date.now() - days * 86400000).toISOString() : null;

    let clickQ = supabaseAdmin
      .from('utm_clicks')
      .select('utm_campaign, utm_source, utm_medium')
      .eq('client_id', client.id)
      .not('utm_campaign', 'is', null);
    if (since) clickQ = clickQ.gte('clicked_at', since);

    let convQ = supabaseAdmin
      .from('utm_conversions')
      .select('utm_campaign, revenue')
      .eq('client_id', client.id)
      .not('utm_campaign', 'is', null);
    if (since) convQ = convQ.gte('converted_at', since);

    const [{ data: clicks }, { data: convs }, { data: skuRows }] = await Promise.all([
      clickQ, convQ,
      supabaseAdmin.from('revenue_data').select('standard_sku').eq('client_id', client.id).not('standard_sku', 'is', null).limit(2000),
    ]);

    const knownSkus = [...new Set((skuRows || []).map(r => r.standard_sku).filter(Boolean))];

    const byCampaign = {};
    for (const c of clicks || []) {
      const key = c.utm_campaign;
      if (!byCampaign[key]) byCampaign[key] = { campaign: key, source: c.utm_source, medium: c.utm_medium, clicks: 0, conversions: 0, revenue: 0 };
      byCampaign[key].clicks += 1;
    }
    for (const c of convs || []) {
      const key = c.utm_campaign;
      if (!byCampaign[key]) byCampaign[key] = { campaign: key, source: null, medium: null, clicks: 0, conversions: 0, revenue: 0 };
      byCampaign[key].conversions += 1;
      byCampaign[key].revenue += Number(c.revenue) || 0;
    }

    const results = Object.values(byCampaign).map(row => ({
      ...row,
      product: guessProductFromCampaignName(row.campaign, knownSkus),
    })).sort((a, b) => b.clicks - a.clicks);

    return res.json(results);
  }
);

// Splits a campaign name into tokens and looks for the token sequence
// that best overlaps with a known SKU's own tokens. Best-effort only.
function guessProductFromCampaignName(campaignName, knownSkus) {
  if (!campaignName || !knownSkus.length) return null;
  const tokens = campaignName.toLowerCase().split(/[_\-\s]+/).filter(t => t.length > 2);

  let best = null, bestScore = 0;
  for (const sku of knownSkus) {
    const skuTokens = sku.toLowerCase().split(/[_\-\s]+/).filter(t => t.length > 2);
    const overlap = skuTokens.filter(t => tokens.includes(t)).length;
    if (overlap > bestScore) { bestScore = overlap; best = sku; }
  }
  return bestScore > 0 ? best : null;
}


// ═══════════════════════════════════════════════════════════════════
// ADMIN — Saved Links CRUD
// ═══════════════════════════════════════════════════════════════════
router.get(
  '/:client_slug/utm/links',
  rbacMiddleware,
  requireTab('utm_analytics'),
  async (req, res) => {
    const { client } = req.semya;
    const { data, error } = await supabaseAdmin
      .from('utm_saved_links')
      .select('id, url, campaign, source, medium, saved_at')
      .eq('client_id', client.id)
      .order('saved_at', { ascending: false })
      .limit(200);
    if (error) return res.status(500).json({ error: 'Failed to fetch saved links.' });
    return res.json({ links: data || [] });
  }
);

router.post(
  '/:client_slug/utm/links',
  rbacMiddleware,
  requireTab('utm_analytics'),
  async (req, res) => {
    const { client } = req.semya;
    const url = (req.body?.url || '').trim();
    if (!url) return res.status(400).json({ error: 'url is required.' });

    const { data, error } = await supabaseAdmin
      .from('utm_saved_links')
      .insert({
        client_id: client.id, url,
        campaign: req.body?.campaign?.trim() || null,
        source:   req.body?.source?.trim()   || null,
        medium:   req.body?.medium?.trim()   || null,
      })
      .select('id, saved_at')
      .single();

    if (error) return res.status(500).json({ error: 'Failed to save link.' });
    return res.json({ status: 'ok', id: data.id, saved_at: data.saved_at });
  }
);

router.delete(
  '/:client_slug/utm/links/:id',
  rbacMiddleware,
  requireTab('utm_analytics'),
  async (req, res) => {
    const { client } = req.semya;
    const { error } = await supabaseAdmin
      .from('utm_saved_links')
      .delete()
      .eq('id', req.params.id)
      .eq('client_id', client.id); // scoping by client_id too — can't delete another client's link by guessing an id
    if (error) return res.status(500).json({ error: 'Failed to delete link.' });
    return res.json({ status: 'ok', deleted_id: req.params.id });
  }
);


// ═══════════════════════════════════════════════════════════════════
// ADMIN — GET /clients/:client_slug/utm/snippets
// Returns ready-to-paste tracking snippet text with this client's real
// slug + the deployed API base URL already filled in, plus (if set) a
// GA4 snippet mirroring the same events into their GA4 property.
// ═══════════════════════════════════════════════════════════════════
router.get(
  '/:client_slug/utm/snippets',
  rbacMiddleware,
  requireTab('utm_analytics'),
  async (req, res) => {
    const { client } = req.semya;
    const apiBase = process.env.PUBLIC_API_BASE || `${req.protocol}://${req.get('host')}`;
    const slug = client.slug;

    const snippetA = buildSnippetA(apiBase, slug);
    const snippetB = buildSnippetB(apiBase, slug);
    const snippetC = client.ga4_measurement_id ? buildSnippetC(client.ga4_measurement_id) : null;

    return res.json({ snippetA, snippetB, snippetC, ga4MeasurementId: client.ga4_measurement_id || null });
  }
);


// ═══════════════════════════════════════════════════════════════════
// ADMIN — GA4 Measurement ID (Settings)
// ═══════════════════════════════════════════════════════════════════
router.patch(
  '/:client_slug/admin/ga4',
  rbacMiddleware,
  async (req, res) => {
    if (!req.semya.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
    const { client } = req.semya;
    const id = (req.body?.measurementId || '').trim();

    const { error } = await supabaseAdmin
      .from('clients')
      .update({ ga4_measurement_id: id || null })
      .eq('id', client.id);

    if (error) return res.status(500).json({ error: 'Failed to save GA4 measurement ID.' });
    return res.json({ ok: true, ga4MeasurementId: id || null });
  }
);


// ─── Snippet templates ─────────────────────────────────────────────
function buildSnippetA(apiBase, slug) {
  return `<!-- Semya UTM Tracking — Snippet A (paste before </head> in theme.liquid) -->
<script>
(function() {
  var params = new URLSearchParams(window.location.search);
  var utm = {
    utm_source:   params.get('utm_source'),
    utm_medium:   params.get('utm_medium'),
    utm_campaign: params.get('utm_campaign'),
    utm_term:     params.get('utm_term'),
    utm_content:  params.get('utm_content'),
  };
  if (utm.utm_source || utm.utm_campaign) {
    // Save for 30 days so a later purchase (even a different session) still gets credit
    var expiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
    localStorage.setItem('semya_utm', JSON.stringify({ ...utm, firstSeen: Date.now(), expiry }));
    try { sessionStorage.setItem('semya_utm', JSON.stringify(utm)); } catch(e) {}

    // Click ping (1x1 gif, no CORS needed)
    var q = Object.entries(utm).filter(([,v]) => v).map(([k,v]) => k + '=' + encodeURIComponent(v)).join('&');
    new Image().src = '${apiBase}/clients/${slug}/utm/click?' + q + '&page=' + encodeURIComponent(location.pathname);
  }

  // Write UTM data into Shopify cart attributes so it survives checkout
  function writeCartAttributes() {
    var stored = localStorage.getItem('semya_utm');
    if (!stored) return;
    try {
      var data = JSON.parse(stored);
      if (data.expiry && Date.now() > data.expiry) { localStorage.removeItem('semya_utm'); return; }
      fetch('/cart/update.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attributes: {
          utm_source: data.utm_source || '', utm_medium: data.utm_medium || '',
          utm_campaign: data.utm_campaign || '', utm_term: data.utm_term || '',
          utm_content: data.utm_content || '', utm_first_seen: String(data.firstSeen || ''),
        }}),
      }).catch(function(){});
    } catch(e) {}
  }
  if (location.pathname.indexOf('/cart') === 0) writeCartAttributes();
})();
</script>`;
}

function buildSnippetB(apiBase, slug) {
  return `// Semya UTM Tracking — Snippet B (Shopify Admin → Settings → Customer events → Add custom pixel)
// Name it "Semya UTM Conversion Tracker" → paste → Save → Connect
analytics.subscribe('checkout_completed', (event) => {
  try {
    var stored = localStorage.getItem('semya_utm');
    if (!stored) return;
    var data = JSON.parse(stored);
    if (data.expiry && Date.now() > data.expiry) return;

    var order = event.data.checkout;
    var daysToConvert = data.firstSeen ? Math.floor((Date.now() - data.firstSeen) / 86400000) : 0;

    fetch('${apiBase}/clients/${slug}/utm/conversion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        utm_source: data.utm_source, utm_medium: data.utm_medium,
        utm_campaign: data.utm_campaign, utm_term: data.utm_term, utm_content: data.utm_content,
        order_id: order.order ? order.order.id : null,
        revenue: order.totalPrice ? order.totalPrice.amount : 0,
        type: daysToConvert > 0 ? 'assisted_conversion' : 'direct',
        days_to_convert: daysToConvert,
        first_seen: data.firstSeen ? new Date(data.firstSeen).toISOString() : null,
      }),
      keepalive: true,
    }).catch(function(){});
  } catch(e) {}
});`;
}

function buildSnippetC(measurementId) {
  return `<!-- Semya UTM Tracking — Snippet C (GA4 mirror, optional) -->
<!-- Paste before </head> alongside Snippet A. Sends the same UTM click event to your own GA4 property. -->
<script async src="https://www.googletagmanager.com/gtag/js?id=${measurementId}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){ dataLayer.push(arguments); }
  gtag('js', new Date());
  gtag('config', '${measurementId}');

  (function() {
    var params = new URLSearchParams(window.location.search);
    if (params.get('utm_source') || params.get('utm_campaign')) {
      gtag('event', 'campaign_click', {
        source:   params.get('utm_source'),
        medium:   params.get('utm_medium'),
        campaign: params.get('utm_campaign'),
        term:     params.get('utm_term'),
        content:  params.get('utm_content'),
      });
    }
  })();
</script>`;
}

export default router;
