// services/shopifyClient.js
// ─────────────────────────────────────────────────────────────────
// Throttled Shopify Admin API client with automatic pagination.
// ─────────────────────────────────────────────────────────────────

const SHOPIFY_STORE   = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN   = process.env.SHOPIFY_API_TOKEN;
const SHOPIFY_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';
const BASE = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_VERSION}`;

async function shopifyGet(path, params = {}) {
  const url = new URL(BASE + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));

  const res = await fetch(url.toString(), {
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
  });

  if (res.status === 429) {
    const wait = parseInt(res.headers.get('Retry-After') || '2', 10) * 1000;
    await new Promise(r => setTimeout(r, wait));
    return shopifyGet(path, params);
  }
  if (!res.ok) throw new Error(`Shopify API ${res.status} on ${path}`);

  const data = await res.json();
  const link  = res.headers.get('Link') || '';
  const next  = link.match(/<([^>]+)>;\s*rel="next"/);
  data.__nextLink = next ? next[1] : null;
  return data;
}

export async function* shopifyPaginate(path, params = {}, resultKey) {
  let data = await shopifyGet(path, { limit: 250, ...params });
  yield data[resultKey] || [];

  while (data.__nextLink) {
    await new Promise(r => setTimeout(r, 500));
    const res = await fetch(data.__nextLink, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN },
    });
    data = await res.json();
    data.__nextLink = (res.headers.get('Link') || '')
      .match(/<([^>]+)>;\s*rel="next"/)?.[1] || null;
    yield data[resultKey] || [];
  }
}

export { shopifyGet };
