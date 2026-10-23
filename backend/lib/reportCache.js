// lib/reportCache.js
// ─────────────────────────────────────────────────────────────────
// Short-lived in-memory cache for the heavy report endpoints
// (platform-sales, sku-performance, campaign-insights, geographic,
// fraud-patterns).
//
// WHY: each of those reads a client's whole order history from
// Postgres. On the Supabase free "Nano" instance (0.5 GB RAM) that is
// expensive — confirmed 2026-10-23: the DB sat in 650 MB+ swap and every
// query took up to ~8 s once several dashboard tabs, the 5-minute
// auto-refresh and an upload overlapped. The data only changes when
// someone uploads/imports/deletes, so re-reading it on every page load
// and tab switch is pure waste.
//
// HOW:
//   • GET responses are cached per client + exact URL (incl. query) for
//     REPORT_CACHE_TTL_MS (default 15 min).
//   • Identical requests that arrive while one is already computing wait
//     for that one instead of starting a second full read.
//   • ANY successful write (POST/PUT/PATCH/DELETE anywhere in the API)
//     clears the whole cache, and so does the end of every file
//     ingestion (uploads can finish in the background after the
//     response is sent) — so new data shows up on the next load.
// ─────────────────────────────────────────────────────────────────

const TTL_MS    = Number(process.env.REPORT_CACHE_TTL_MS) || 15 * 60 * 1000;
const MAX_ITEMS = Number(process.env.REPORT_CACHE_MAX_ITEMS) || 150;

const store    = new Map(); // key -> { at, gen, body }
const inflight = new Map(); // key -> Promise<{ status, body } | null>
let generation = 0;

function keyFor(req) {
  const clientId = req.semya?.client?.id || req.params?.client_slug || 'anon';
  const url = new URL(req.originalUrl, 'http://x');
  const params = [...url.searchParams.entries()].sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
  return clientId + '|' + url.pathname + '?' + new URLSearchParams(params).toString();
}

function remember(key, body) {
  if (store.size >= MAX_ITEMS) {
    // drop the oldest entry (Map keeps insertion order)
    store.delete(store.keys().next().value);
  }
  store.set(key, { at: Date.now(), gen: generation, body });
}

/** Clear everything — called after any data change. */
export function invalidateReportCache(reason = '') {
  generation++;
  store.clear();
  inflight.clear();
  if (reason) console.log('[report-cache] cleared:', reason);
}

/** Express middleware: put it after auth/permission checks on a GET report route. */
export function reportCache(req, res, next) {
  if (req.method !== 'GET' || req.query.nocache === '1') return next();
  const key = keyFor(req);

  const hit = store.get(key);
  if (hit && hit.gen === generation && Date.now() - hit.at < TTL_MS) {
    res.set('X-Report-Cache', 'HIT');
    return res.json(hit.body);
  }

  const pending = inflight.get(key);
  if (pending) {
    return pending.then(result => {
      if (result && result.status === 200) {
        res.set('X-Report-Cache', 'SHARED');
        return res.json(result.body);
      }
      return next(); // the first request failed — compute our own
    }).catch(() => next());
  }

  // We're the one computing: capture the JSON body when the handler sends it.
  let resolveFn;
  const p = new Promise(r => { resolveFn = r; });
  inflight.set(key, p);
  const startGen = generation;
  const origJson = res.json.bind(res);
  res.json = (body) => {
    const status = res.statusCode || 200;
    if (status === 200 && startGen === generation) remember(key, body);
    if (inflight.get(key) === p) inflight.delete(key);
    resolveFn({ status, body });
    res.set('X-Report-Cache', 'MISS');
    return origJson(body);
  };
  res.on('close', () => {
    // handler threw / connection dropped before json() — release waiters
    if (inflight.get(key) === p) inflight.delete(key);
    resolveFn(null);
  });
  next();
}

/** App-level middleware: any successful write clears the cache once it finishes. */
export function invalidateOnWrite(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  res.on('finish', () => {
    if (res.statusCode < 400) invalidateReportCache(req.method + ' ' + req.path);
  });
  next();
}
