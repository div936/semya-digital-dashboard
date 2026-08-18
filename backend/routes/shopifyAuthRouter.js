// routes/shopifyAuthRouter.js
// ─────────────────────────────────────────────────────────────────
// Handles Shopify OAuth flow to get and store the access token.
// 
// Flow:
//   1. Admin visits /shopify/install?shop=neat-everyday.myshopify.com
//   2. Redirects to Shopify OAuth consent page
//   3. Shopify redirects back to /shopify/callback?code=...
//   4. We exchange the code for an access token
//   5. Token is stored in shopify_tokens table in Supabase
//   6. Token is ready to use for API sync
// ─────────────────────────────────────────────────────────────────
import { Router }       from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import crypto            from 'crypto';

const router = Router();

const CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID_OAUTH;  // from Dev Dashboard Settings
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;    // from Dev Dashboard Settings
const SCOPES        = 'read_orders,read_all_orders,read_fulfillments,read_customers,read_products';
const REDIRECT_URI  = process.env.SHOPIFY_REDIRECT_URI || 'https://semya-api.onrender.com/shopify/callback';

// Store nonces to prevent CSRF
const nonces = new Set();

// ── GET /shopify/install ─────────────────────────────────────────
// Kick off the OAuth flow
router.get('/install', (req, res) => {
  const shop  = req.query.shop;
  if (!shop) return res.status(400).send('Missing shop parameter');

  const nonce = crypto.randomBytes(16).toString('hex');
  nonces.add(nonce);

  // Nonces expire after 10 minutes
  setTimeout(() => nonces.delete(nonce), 10 * 60 * 1000);

  const authUrl = `https://${shop}/admin/oauth/authorize?` +
    `client_id=${CLIENT_ID}` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&state=${nonce}`;

  res.redirect(authUrl);
});

// ── GET /shopify/callback ────────────────────────────────────────
// Shopify redirects here after merchant approves
router.get('/callback', async (req, res) => {
  const { shop, code, state, hmac } = req.query;

  // Validate nonce
  if (!nonces.has(state)) {
    return res.status(403).send('Invalid state parameter');
  }
  nonces.delete(state);

  // Validate HMAC
  const params   = Object.entries(req.query)
    .filter(([k]) => k !== 'hmac')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const digest   = crypto.createHmac('sha256', CLIENT_SECRET).update(params).digest('hex');
  if (digest !== hmac) return res.status(403).send('HMAC validation failed');

  // Exchange code for access token
  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    console.error('[shopify-auth] token exchange failed:', err);
    return res.status(500).send('Token exchange failed: ' + err);
  }

  const { access_token, scope } = await tokenRes.json();

  // Store token in Supabase
  const { error } = await supabaseAdmin
    .from('shopify_tokens')
    .upsert({ shop, access_token, scopes: scope }, { onConflict: 'shop' });

  if (error) {
    console.error('[shopify-auth] failed to store token:', error.message);
    return res.status(500).send('Failed to store token: ' + error.message);
  }

  console.log(`[shopify-auth] token stored for ${shop}`);
  res.send(`
    <html><body style="font-family:sans-serif;padding:40px">
      <h2>✅ Shopify connected successfully!</h2>
      <p>Shop: <strong>${shop}</strong></p>
      <p>Scopes: <code>${scope}</code></p>
      <p>The access token has been saved. Your dashboard will now sync orders automatically every 6 hours.</p>
      <p>You can close this window.</p>
    </body></html>
  `);

  // Trigger an immediate sync in the background
  try {
    const { runOrderSync } = await import('../services/syncScheduler.js');
    runOrderSync().catch(e => console.error('[shopify-auth] initial sync failed:', e.message));
  } catch (e) {
    console.warn('[shopify-auth] could not trigger initial sync:', e.message);
  }
});

export default router;
