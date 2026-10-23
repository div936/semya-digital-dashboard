// lib/fetchRows.js
// ─────────────────────────────────────────────────────────────────
// Fast, deterministic "fetch every matching row" helpers for Supabase.
//
// WHY THIS EXISTS
// The old fetchAllRows() in clientRouter.js paged with .range() — i.e.
// LIMIT/OFFSET — one page at a time, sorted by id. For a client with
// ~40k rows per month that meant ~40+ sequential round-trips per month
// of data, and every page made Postgres re-find and re-sort the whole
// result set just to skip past the earlier pages. A single month took
// ~25s; Jan→today (3 heavy months) blew past the frontend's 45s timeout
// and the dashboard sat on "Loading… ₹0" forever.
//
// HOW THIS IS FASTER
//   1. Find the first and last date that actually has data in the
//      requested window (two tiny indexed queries) — so a range like
//      2026-01-01 → 2026-10-23 only walks the days that have rows.
//   2. Split that span into 1-day chunks and fetch several chunks in
//      parallel.
//   3. Inside a chunk, page with a keyset (id > lastId) instead of
//      OFFSET, so no page ever re-reads rows from an earlier page.
//
// Uses the index:
//   create index if not exists idx_revenue_data_client_date_id
//     on revenue_data (client_id, order_date, id);
//   create index if not exists idx_campaign_data_client_date_id
//     on campaign_data (client_id, campaign_date, id);
//
// Result order is: rows grouped by date ascending, id ascending within
// a date, then undated rows last. Callers that need a different order
// sort the returned array themselves.
// ─────────────────────────────────────────────────────────────────

// Rows requested per page. PostgREST's project-level "Max rows" setting
// caps this server-side (Supabase default 1000) — the paging loop below
// detects a lower cap automatically, so this can safely be higher.
const DEFAULT_PAGE_SIZE   = Number(process.env.SUPABASE_PAGE_SIZE) || 5000;
const DEFAULT_CONCURRENCY = Number(process.env.SUPABASE_FETCH_CONCURRENCY) || 8;

function addDays(isoDate, n) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Run async tasks with at most `limit` in flight; preserves result order.
async function runPool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

function withId(select) {
  const cols = select.split(',').map(s => s.trim());
  if (cols.includes('*') || cols.includes('id')) return { select, added: false };
  return { select: select + ', id', added: true };
}

// Keyset-paginate one query shape by id until exhausted.
// `build()` must return a FRESH query builder each call (they're single-use),
// with select + all filters applied but no order/range/limit.
// `capState` is shared across concurrent calls so the server's row cap is
// learned once rather than per chunk.
async function keysetAll(build, pageSize, capState) {
  const rows = [];
  let lastId = null;
  for (;;) {
    let q = build();
    if (lastId !== null) q = q.gt('id', lastId);
    const { data, error } = await q.order('id', { ascending: true }).limit(pageSize);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const r of data) rows.push(r);
    lastId = data[data.length - 1].id;
    if (data.length > capState.max) capState.max = data.length;
    // A short page means we're done — unless the server simply caps pages
    // below pageSize, in which case a "full" page equals the cap. We only
    // treat a page as short once it's below the largest page seen.
    if (data.length >= pageSize) continue;
    if (data.length < capState.max) break;
    // data.length === capState.max < pageSize: ambiguous (could be the
    // cap, or could be exactly the last rows) — one more request settles it.
  }
  return rows;
}

/**
 * Fetch every row of `table` for one client within an optional date window.
 *
 * @param {object} supabase       supabase-js client (service role)
 * @param {object} opts
 * @param {string} opts.table
 * @param {string} opts.select    column list (id is added automatically if missing)
 * @param {string} opts.clientId
 * @param {string} [opts.dateCol='order_date']
 * @param {string} [opts.from]    YYYY-MM-DD inclusive
 * @param {string} [opts.to]      YYYY-MM-DD inclusive
 * @param {boolean} [opts.includeNullDates=true]  also return rows whose dateCol is NULL
 * @param {(q:any)=>any} [opts.filter]            extra filters (platform, sku, …)
 */
export async function fetchRowsByDate(supabase, {
  table,
  select,
  clientId,
  dateCol = 'order_date',
  from,
  to,
  includeNullDates = true,
  filter = q => q,
  pageSize = DEFAULT_PAGE_SIZE,
  concurrency = DEFAULT_CONCURRENCY,
}) {
  // An inverted window matches no dated rows (undated rows still count,
  // exactly as the old OR-with-null filter behaved).
  const emptyWindow = !!(from && to && from > to);
  const { select: sel, added } = withId(select);
  const base = () => filter(supabase.from(table).select(sel).eq('client_id', clientId));
  const capState = { max: 0 };

  // 1. First / last date that actually has data in the window.
  const edge = async (ascending) => {
    let q = filter(supabase.from(table).select(dateCol).eq('client_id', clientId).not(dateCol, 'is', null));
    if (from) q = q.gte(dateCol, from);
    if (to)   q = q.lte(dateCol, to);
    const { data, error } = await q.order(dateCol, { ascending }).limit(1);
    if (error) throw new Error(error.message);
    const v = data?.[0]?.[dateCol];
    return v ? String(v).slice(0, 10) : null;
  };
  const [first, last] = emptyWindow ? [null, null] : await Promise.all([edge(true), edge(false)]);

  // 2. One task per day that could have data, plus one for undated rows.
  const tasks = [];
  if (first && last) {
    for (let d = first; d <= last; d = addDays(d, 1)) {
      const day = d;
      tasks.push(() => keysetAll(() => base().eq(dateCol, day), pageSize, capState));
    }
  }
  if (includeNullDates) {
    tasks.push(() => keysetAll(() => base().is(dateCol, null), pageSize, capState));
  }

  const chunks = await runPool(tasks, concurrency);
  const rows = chunks.flat();
  if (added) for (const r of rows) delete r.id;
  return rows;
}

/**
 * Fetch every row matching an arbitrary query, keyset-paginated by id.
 * For small/irregular result sets that don't have a natural date column
 * to chunk on (e.g. "cancelled rows whose cancel date is in range").
 * `build()` must return a fresh builder with select + filters applied;
 * the select must include `id`.
 */
export async function fetchAllByKeyset(build, { pageSize = DEFAULT_PAGE_SIZE } = {}) {
  return keysetAll(build, pageSize, { max: 0 });
}
