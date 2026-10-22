// services/flipkartClient.js
// ─────────────────────────────────────────────────────────────────
// Authenticated Flipkart Seller API client with automatic token
// refresh and pagination. Mirrors shopifyClient.js exactly in
// structure so the rest of the codebase feels familiar.
//
// Auth model (Client Credentials — Self Access Application):
//   Access token expires in ~60 days.
//   Refresh token expires in ~180 days.
//   We auto-refresh the access token using the refresh token
//   when a 401 is returned, and persist both tokens back to
//   Supabase so the server can restart without losing auth state.
//
// Base URLs:
//   Production:  https://api.flipkart.net/sellers
//   OAuth:       https://api.flipkart.net/oauth-service/oauth
// ─────────────────────────────────────────────────────────────────

import { supabaseAdmin } from '../lib/supabase.js';

const BASE_API   = 'https://api.flipkart.net/sellers';
const OAUTH_BASE = 'https://api.flipkart.net/oauth-service/oauth';

// In-memory token cache — populated from Supabase on first call,
// then kept hot for the life of the process.
let _accessToken  = null;
let _refreshToken = null;
let _appId        = null;
let _appSecret    = null;

// ── Token bootstrap ───────────────────────────────────────────────
// Load credentials from environment (set once in Render dashboard)
// and any persisted tokens from Supabase.
async function ensureTokens() {
  if (_accessToken) return; // already loaded this process

  _appId     = process.env.FLIPKART_APP_ID;
  _appSecret = process.env.FLIPKART_APP_SECRET;

  if (!_appId || !_appSecret) {
    throw new Error('[flipkart] FLIPKART_APP_ID / FLIPKART_APP_SECRET env vars not set');
  }

  // Try to load a stored token from Supabase so a server restart
  // doesn't force a full re-auth.
  const { data } = await supabaseAdmin
    .from('flipkart_tokens')
    .select('access_token, refresh_token')
    .eq('app_id', _appId)
    .maybeSingle();

  if (data) {
    _accessToken  = data.access_token;
    _refreshToken = data.refresh_token;
    console.log('[flipkart] loaded persisted tokens from Supabase');
  } else {
    // First-ever boot — generate tokens via client credentials flow
    await _generateAccessToken();
  }
}

// ── Generate brand-new token pair (client credentials flow) ──────
async function _generateAccessToken() {
  const credentials = Buffer.from(`${_appId}:${_appSecret}`).toString('base64');
  const res = await fetch(
    `${OAUTH_BASE}/token?grant_type=client_credentials&scope=Seller_Api`,
    { headers: { Authorization: `Basic ${credentials}` } }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[flipkart] token generation failed (${res.status}): ${body}`);
  }
  const json = await res.json();
  _accessToken  = json.access_token;
  _refreshToken = json.refresh_token || null;
  await _persistTokens();
  console.log('[flipkart] generated new access token');
}

// ── Refresh an expiring/expired access token ─────────────────────
async function _refreshAccessToken() {
  if (!_refreshToken) {
    console.warn('[flipkart] no refresh token stored — falling back to full re-auth');
    return _generateAccessToken();
  }
  const credentials = Buffer.from(`${_appId}:${_appSecret}`).toString('base64');
  const res = await fetch(
    `${OAUTH_BASE}/token?grant_type=refresh_token&refresh_token=${_refreshToken}`,
    { headers: { Authorization: `Basic ${credentials}` } }
  );
  if (!res.ok) {
    console.warn('[flipkart] refresh failed — attempting full re-auth');
    return _generateAccessToken();
  }
  const json = await res.json();
  _accessToken  = json.access_token;
  _refreshToken = json.refresh_token || _refreshToken; // keep old refresh if not rotated
  await _persistTokens();
  console.log('[flipkart] refreshed access token');
}

// ── Persist tokens to Supabase ───────────────────────────────────
async function _persistTokens() {
  const { error } = await supabaseAdmin
    .from('flipkart_tokens')
    .upsert(
      { app_id: _appId, access_token: _accessToken, refresh_token: _refreshToken, updated_at: new Date().toISOString() },
      { onConflict: 'app_id' }
    );
  if (error) console.warn('[flipkart] failed to persist tokens:', error.message);
}

// ── Core GET request ─────────────────────────────────────────────
export async function flipkartGet(path, params = {}) {
  await ensureTokens();

  const url = new URL(BASE_API + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));

  const res = await fetch(url.toString(), {
    headers: {
      Authorization:  `Bearer ${_accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  // Auto-refresh on 401
  if (res.status === 401) {
    console.warn('[flipkart] 401 — refreshing token and retrying');
    await _refreshAccessToken();
    return flipkartGet(path, params); // one retry
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[flipkart] GET ${path} → ${res.status}: ${body}`);
  }

  return res.json();
}

// ── Core POST request ────────────────────────────────────────────
export async function flipkartPost(path, body = {}) {
  await ensureTokens();

  const res = await fetch(BASE_API + path, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${_accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (res.status === 401) {
    console.warn('[flipkart] 401 — refreshing token and retrying');
    await _refreshAccessToken();
    return flipkartPost(path, body);
  }

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`[flipkart] POST ${path} → ${res.status}: ${errBody}`);
  }

  return res.json();
}

// ── Paginated shipment fetcher ───────────────────────────────────
// Flipkart uses nextPageUrl in the response body (not a Link header
// like Shopify) and caps each page at 20 results. This generator
// yields one page of shipments at a time, following nextPageUrl
// until hasMore is false.
export async function* flipkartPaginateShipments(filter = {}, pageSize = 20) {
  await ensureTokens();

  let nextUrl = `${BASE_API}/v3/shipments/filter/`;
  let isFirst = true;

  while (nextUrl) {
    // First call uses POST with full filter body.
    // Subsequent pages use GET on the nextPageUrl returned by FK.
    let data;
    if (isFirst) {
      data = await flipkartPost('/v3/shipments/filter/', {
        filter,
        pagination: { pageSize },
      });
      isFirst = false;
    } else {
      // nextPageUrl is a full absolute URL — fetch directly
      const res = await fetch(nextUrl, {
        headers: { Authorization: `Bearer ${_accessToken}` },
      });
      if (!res.ok) throw new Error(`[flipkart] paginate → ${res.status}`);
      data = await res.json();
    }

    yield data.shipments || [];

    nextUrl = data.hasMore ? data.nextPageUrl : null;

    if (nextUrl) {
      // Polite pause between pages — Flipkart's rate limits aren't
      // published but 500ms matches what we use for Shopify.
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

// ── Returns paginator ────────────────────────────────────────────
// GET /v2/returns follows a simpler pattern: returns nextUrl in body.
export async function* flipkartPaginateReturns(params = {}) {
  await ensureTokens();

  let url = new URL(`${BASE_API}/v2/returns`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  let nextUrl = url.toString();

  while (nextUrl) {
    const res = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${_accessToken}` },
    });

    if (res.status === 401) {
      await _refreshAccessToken();
      continue; // retry same page
    }
    if (!res.ok) throw new Error(`[flipkart] returns → ${res.status}`);

    const data = await res.json();
    yield data.returns || [];

    nextUrl = data.nextUrl || null;
    if (nextUrl) await new Promise(r => setTimeout(r, 500));
  }
}
