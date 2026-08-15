// routes/clientRouter.js
// ─────────────────────────────────────────────────────────────────
// Mounts at /clients in your main Express app:
//   app.use('/clients', clientRouter)
//
// All routes follow: /clients/:client_slug/<resource>
//
// Public endpoints (no auth):        none — all routes are protected
// Protected (any auth):              /dashboard-config
// Protected (admin only):            /admin/tab-permissions
// Protected (tab-gated):             /sku, /campaigns, /ai-insights, etc.
// ─────────────────────────────────────────────────────────────────
import { Router } from 'express';
import { rbacMiddleware, requireTab } from '../middleware/rbac.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { detectSuspiciousPatterns } from '../lib/fraudDetector.js';
import { backfillLocationByOrder, normaliseStateName, inferCategory, CATEGORY_KEYWORDS } from '../lib/columnMapper.js';

const router = Router({ mergeParams: true });

// ─── PAGINATED FETCH ──────────────────────────────────────────────
// Supabase free tier caps rows at 1000 per request (project-level Max Rows setting).
// This helper fetches ALL rows by requesting pages until an empty page is returned.
// BUG FIX: every caller of this MUST include a deterministic, unique
// .order() clause (e.g. .order('id'), since id is the UUID primary
// key) in the query it builds. Without one, Postgres/PostgREST make
// NO guarantee about row order between separate query executions —
// meaning two consecutive calls to this exact function, with zero
// data changes in between, can genuinely return different rows on
// each page boundary (some rows silently skipped, others counted
// twice). This showed up in production as a plain page refresh
// producing a different total revenue figure with no upload, import,
// or cleanup having happened in between — confirmed the cause was
// exactly this: none of this file's five callers had an .order()
// clause at all before this comment was added.
// pageSize MUST be <= Supabase Data API "Max rows" project setting
// (Integrations → Data API → Max rows, currently set to 5000).
// If pageSize > Max rows, Supabase silently caps each response at Max rows —
// data.length < pageSize on the very first page — and the loop stops after
// one page, silently returning only a fraction of the data with no error.
// We use 1000 (the old default) as a safe floor. After changing Max rows
// to 5000, this can be raised to 5000 for fewer round-trips.
// pageSize MUST be <= Supabase Data API "Max rows" project setting
// (Integrations → Data API → Max rows, currently set to 5000).
// If pageSize > Max rows, Supabase silently caps each response at Max rows —
// data.length < pageSize on the very first page — and the loop stops after
// one page, silently returning only a fraction of the data with no error.
// We use 1000 as a safe conservative default. After verifying Max rows >= 5000
// in Supabase settings, this can be raised to 5000 for fewer round-trips.
async function fetchAllRows(buildQuery, pageSize = 1000) {
  const allRows = [];
  let from = 0;
  // effectivePageSize tracks the real cap Supabase is enforcing.
  // On the first response we learn the actual ceiling (which may be lower
  // than pageSize if the Supabase "Max rows" setting is below pageSize).
  // Subsequent pages use that observed ceiling as the stopping threshold,
  // so we never mistake a Supabase-capped first page for the final page.
  let effectivePageSize = pageSize;
  while (true) {
    const { data, error } = await buildQuery(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    allRows.push(...data);
    // After first non-empty response, lock in the real page size ceiling.
    if (allRows.length === data.length) effectivePageSize = data.length;
    if (data.length < effectivePageSize) break; // genuine last page
    from += pageSize;
  }
  return allRows;
}

// ─── PLATFORM GROUPS ──────────────────────────────────────────────
// Top-level filter pills group several raw data sources together:
//   "Amazon"  = amazon (Neat Amazon file) + acutas (Acutas file)
//   "Website" = meta (Meta file) + google (Google file)
// Kept in sync with PLATFORM_GROUPS in frontend/dashboard.html.
const PLATFORM_GROUPS = {
  amazon:  ['amazon', 'acutas'],
  website: ['meta', 'google'],
};

// Expands a platform filter value (which may be a group key like "amazon"
// or "website", or a raw platform like "flipkart") into the list of raw
// platform values it should match in the database.
function expandPlatform(platform) {
  if (!platform) return null;
  const p = platform.toLowerCase();
  return PLATFORM_GROUPS[p] || [p];
}

// Apply RBAC to every route under /:client_slug
router.use('/:client_slug', rbacMiddleware);


// ═══════════════════════════════════════════════════════════════════
// DASHBOARD CONFIG
// Returns the client theme, name, logo, and which tabs are enabled.
// The frontend calls this once on load to build its UI state.
// ═══════════════════════════════════════════════════════════════════
router.get('/:client_slug/dashboard-config', (req, res) => {
  const { client, permissions, isAdmin, user } = req.semya;

  return res.json({
    client: {
      slug:    client.slug,
      name:    client.name,
      logoUrl: client.logo_url,
      theme:   client.theme,        // CSS variable overrides for dynamic theming
    },
    user: {
      role:    user.role,
      isAdmin,
    },
    // Only expose enabled state to clients; admins get full toggle metadata
    tabs: permissions,
  });
});


// ═══════════════════════════════════════════════════════════════════
// ADMIN — RENAME CLIENT
// Body: { name: string }
// ═══════════════════════════════════════════════════════════════════
router.patch('/:client_slug/admin/rename', async (req, res) => {
  if (!req.semya.isAdmin) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  const { name } = req.body;
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name (non-empty string) is required.' });
  }

  const { client } = req.semya;
  const { data, error } = await supabaseAdmin
    .from('clients')
    .update({ name: name.trim() })
    .eq('id', client.id)
    .select('slug, name')
    .single();

  if (error) return res.status(500).json({ error: 'Failed to rename client.' });
  return res.json({ ok: true, client: data });
});


// ═══════════════════════════════════════════════════════════════════
// ADMIN — UPDATE CLIENT APPEARANCE (logo + theme)
// Body: { logoUrl?, theme? }
// Separate from /admin/rename since logo/theme are a distinct concern
// (visual branding vs. the client's actual name). Previously these
// only lived in the admin's own browser localStorage — reloading on
// a different device or as a different admin showed the defaults
// again, and a client user never saw an admin's chosen branding at
// all. This persists them to the client's own row, so they're real
// and shared across everyone viewing that client's dashboard.
// ═══════════════════════════════════════════════════════════════════
router.patch('/:client_slug/admin/appearance', async (req, res) => {
  if (!req.semya.isAdmin) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  const { logoUrl, theme } = req.body || {};
  if (logoUrl === undefined && theme === undefined) {
    return res.status(400).json({ error: 'Provide at least one of logoUrl or theme.' });
  }

  const update = {};
  if (logoUrl !== undefined) update.logo_url = logoUrl;
  if (theme   !== undefined) update.theme    = theme;

  const { client } = req.semya;
  const { data, error } = await supabaseAdmin
    .from('clients')
    .update(update)
    .eq('id', client.id)
    .select('slug, logo_url, theme')
    .single();

  if (error) return res.status(500).json({ error: 'Failed to save client appearance: ' + error.message });
  return res.json({ ok: true, client: { slug: data.slug, logoUrl: data.logo_url, theme: data.theme } });
});


// ═══════════════════════════════════════════════════════════════════
// ADMIN — UPDATE TAB PERMISSIONS
// Body: { tab_key: string, is_enabled: boolean }
// ═══════════════════════════════════════════════════════════════════
router.patch('/:client_slug/admin/tab-permissions', async (req, res) => {
  if (!req.semya.isAdmin) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const { tab_key, is_enabled } = req.body;
  const { client, user } = req.semya;

  if (typeof tab_key !== 'string' || typeof is_enabled !== 'boolean') {
    return res.status(400).json({ error: 'tab_key (string) and is_enabled (boolean) are required.' });
  }

  const { error } = await supabaseAdmin
    .from('tab_permissions')
    .upsert(
      {
        client_id:  client.id,
        tab_key,
        is_enabled,
        updated_by: user.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'client_id,tab_key' }
    );

  if (error) {
    console.error('[tab-permissions] Upsert failed:', error.message);
    return res.status(500).json({ error: 'Failed to update permission.' });
  }

  return res.json({ ok: true, tab_key, is_enabled });
});


// ═══════════════════════════════════════════════════════════════════
// PLATFORM SALES — revenue summary across all platforms
// ═══════════════════════════════════════════════════════════════════
router.get(
  '/:client_slug/platform-sales',
  requireTab('platform_sales'),
  async (req, res) => {
    const { client } = req.semya;
    const { from, to, platform } = req.query;

    const applyDiscounts = req.query.applyDiscounts === 'true';

    // standard_discount is now a dedicated column — raw_extras no longer
    // needed for platform-sales. Only fraud-patterns route uses raw_extras.
    const selectCols = 'platform, order_date, standard_revenue, standard_units, standard_status, financial_status, standard_sku, standard_product_name, standard_order_id, standard_discount';

    const data = await fetchAllRows((from, to) => {
      let q = supabaseAdmin
        .from('revenue_data')
        .select(selectCols)
        .eq('client_id', client.id)
        .order('id')
        .range(from, to);
      // FIX: two separate .or() calls with the same PostgREST key causes
      // the second to silently overwrite the first — the FROM filter was
      // being completely ignored, returning all rows up to the TO date
      // regardless of the FROM date. Combined into one .or() with nested
      // AND so both bounds are enforced in a single filter parameter.
      if (req.query.from || req.query.to) {
        const from = req.query.from;
        const to   = req.query.to;
        if (from && to) {
          q = q.or(`and(order_date.gte.${from},order_date.lte.${to}),order_date.is.null`);
        } else if (from) {
          q = q.or(`order_date.gte.${from},order_date.is.null`);
        } else {
          q = q.or(`order_date.lte.${to},order_date.is.null`);
        }
      }
      if (platform)            q = q.in('platform', expandPlatform(platform));
      return q;
    }).catch(e => { throw e; });

    // `excludeStatuses` is an optional comma-separated list, e.g.
    // ?excludeStatuses=Cancelled,Pending — nothing is excluded unless
    // the user actively picks statuses to drop. This mirrors the old
    // dashboard's checkbox behaviour: all statuses count by default so
    // "Total Orders" reflects everything that was actually placed.
    const excludeStatuses = req.query.excludeStatuses
      ? new Set(req.query.excludeStatuses.split(',').map(s => s.trim()).filter(Boolean))
      : new Set();

    // Fulfillment status filter — from the new Fulfillment dropdown
    const excludeFulfillStatuses = req.query.excludeFulfillStatuses
      ? new Set(req.query.excludeFulfillStatuses.split(',').map(s => s.trim()).filter(Boolean))
      : new Set();

    // `category` is an optional filter that scopes the ENTIRE response
    // (KPIs, trend chart, platform split, top products) to a single
    // inferred product category — not just a display list. Uses the
    // same inferCategory() as Revenue by Category, so the filter and
    // Apply per-line discount (Lineitem discount from Shopify raw_extras)
    // when the user has toggled "Apply discounts" on. Must run BEFORE
    // the categoryFilter slice below — previously the slice happened first,
    // so dataForSummary captured pre-discount values and the toggle had no
    // effect when a category filter was also active.
    // Amazon/Flipkart/Blinkit already store net revenue — no adjustment.
    if (applyDiscounts) {
      for (const row of data) {
        const disc = Number(row.standard_discount || 0);
        if (disc > 0) row.standard_revenue = Math.max(0, (row.standard_revenue || 0) - disc);
      }
    }

    // the chart it's driven from always agree.
    const categoryFilter = req.query.category || null;
    const dataForSummary = categoryFilter
      ? data.filter(row => inferCategory(row.standard_product_name, row.standard_sku) === categoryFilter)
      : data;

    const summary = aggregatePlatformSales(dataForSummary, excludeStatuses, excludeFulfillStatuses);
    // Dropdown needs the FULL category list regardless of which one is
    // currently selected — computed from unfiltered `data`, not
    // dataForSummary, so the options never shrink to just the active one.
    if (categoryFilter) {
      const unfilteredSummary = aggregatePlatformSales(data, excludeStatuses, excludeFulfillStatuses);
      summary.availableCategories = unfilteredSummary.categories.map(c => c.category);
    } else {
      summary.availableCategories = summary.categories.map(c => c.category);
    }

    // ── REAL PREVIOUS PERIOD ──────────────────────────────────────────
    // Use a fast single-query aggregate instead of fetching all rows.
    const fromDate = req.query.from ? new Date(req.query.from) : null;
    const toDate   = req.query.to   ? new Date(req.query.to)   : null;

    if (fromDate && toDate) {
      const dayDiff    = Math.ceil((toDate - fromDate) / 86400000);
      const prevTo     = new Date(fromDate); prevTo.setDate(prevTo.getDate() - 1);
      const prevFrom   = new Date(prevTo);   prevFrom.setDate(prevFrom.getDate() - dayDiff);
      const prevFromStr = prevFrom.toISOString().slice(0, 10);
      const prevToStr   = prevTo.toISOString().slice(0, 10);

      // Fast aggregate — only fetch what we need for prev period delta
      const prevPlatformFilter = platform ? expandPlatform(platform) : null;
      let prevQ = supabaseAdmin
        .from('revenue_data')
        .select('standard_revenue, standard_units, standard_order_id, standard_status')
        .eq('client_id', client.id)
        .gte('order_date', prevFromStr)
        .lte('order_date', prevToStr)
        .neq('standard_status', 'Cancelled')
        .order('id'); // deterministic row order across paginated batches — without this
                      // Postgres makes no order guarantee, so the same row can appear
                      // on two pages or not at all, silently corrupting prevGrandTotal.
      if (prevPlatformFilter) prevQ = prevQ.in('platform', prevPlatformFilter);

      // Fetch all prev period rows (no limit — same as main query)
      let prevRows = [];
      let prevFrom2 = 0;
      const prevPageSize = 2000;
      while (true) {
        const { data: batch, error } = await prevQ.range(prevFrom2, prevFrom2 + prevPageSize - 1);
        if (error || !batch || batch.length === 0) break;
        prevRows = prevRows.concat(batch);
        if (batch.length < prevPageSize) break;
        prevFrom2 += prevPageSize;
      }
      const prevActive = (prevRows || []).filter(r => Number(r.standard_revenue) > 0);
      summary.prevGrandTotal = prevActive.reduce((s, r) => s + Number(r.standard_revenue), 0);
      summary.prevUnits      = prevActive.reduce((s, r) => s + Number(r.standard_units  || 0), 0);
      summary.prevOrders     = new Set(prevActive.map(r => r.standard_order_id).filter(Boolean)).size;
    } else {
      summary.prevGrandTotal = null;
      summary.prevUnits      = null;
      summary.prevOrders     = null;
    }

    // ── CANCELLED TOTALS ──────────────────────────────────────────────
    // Count cancelled orders and their gross value for the note
    // under the Total Orders card on Platform Sales.
    // Cancelled orders — count unique order IDs with Cancelled status
    const cancelledRows     = data.filter(r => r.standard_status === 'Cancelled');
    const cancelledOrderIds = new Set(cancelledRows.map(r => r.standard_order_id).filter(Boolean));
    summary.cancelledOrders  = cancelledOrderIds.size;
    summary.cancelledRevenue = 0; // shown in AI Insights Cancellation Tracker

    // Date-aligned ROAS — was previously computed on the frontend as
    // "this platform's ENTIRE selected-range revenue ÷ whatever
    // campaign spend happens to exist," which produced implausible
    // figures (confirmed in production: 64.4x for Meta) whenever spend
    // data has only been uploaded for a handful of recent days while
    // revenue spans months. Fixed here, server-side, to only count
    // revenue from the SAME dates that platform actually has spend
    // recorded for — a fair like-for-like ratio instead of months of
    // revenue divided by a few days of spend.
    const { data: campaignRowsForRoas } = await supabaseAdmin
      .from('campaign_data')
      .select('platform, campaign_date, standard_spend')
      .eq('client_id', client.id)
      .gte('campaign_date', req.query.from || '1900-01-01')
      .lte('campaign_date', req.query.to || '2999-12-31');

    const spendDatesByPlatform = {};
    const spendTotalByPlatform = {};
    for (const row of (campaignRowsForRoas || [])) {
      const p = row.platform;
      if (!spendDatesByPlatform[p]) spendDatesByPlatform[p] = new Set();
      if (row.campaign_date) spendDatesByPlatform[p].add(row.campaign_date);
      spendTotalByPlatform[p] = (spendTotalByPlatform[p] || 0) + (Number(row.standard_spend) || 0);
    }

    const revenueOnSpendDatesByPlatform = {};
    for (const row of dataForSummary) {
      const p = row.platform;
      const spendDates = spendDatesByPlatform[p];
      if (spendDates && row.order_date && spendDates.has(row.order_date)) {
        revenueOnSpendDatesByPlatform[p] = (revenueOnSpendDatesByPlatform[p] || 0) + (Number(row.standard_revenue) || 0);
      }
    }

    for (const p of summary.platforms) {
      const spend = spendTotalByPlatform[p.platform] || 0;
      const revenueOnSpendDates = revenueOnSpendDatesByPlatform[p.platform] || 0;
      p.spend = spend;
      // null (not 0) when there's no spend at all for this platform in
      // range — "no ROAS to show" is different from "ROAS is zero".
      p.roas = spend > 0 ? +(revenueOnSpendDates / spend).toFixed(2) : null;
    }

    return res.json(summary);
  }
);


// ═══════════════════════════════════════════════════════════════════
// SKU PERFORMANCE — per-SKU revenue, units, RoAS
// ═══════════════════════════════════════════════════════════════════
router.get(
  '/:client_slug/sku-performance',
  requireTab('sku_performance'),
  async (req, res) => {
    const { client } = req.semya;
    const { sku, platform, from, to } = req.query;

    // includeAllStatuses=true: used by AI Insights Cancellation Tracker
    // and High Risk cards — they need voided/refunded rows too.
    // When false (default), all statuses are returned; caller filters
    // via excludeStatuses as needed.
    const includeAllStatuses = req.query.includeAllStatuses === 'true';

    const [revenueRows, campaignRows] = await Promise.all([
      fetchAllRows((rangeFrom, rangeTo) => {
        let q = supabaseAdmin
          .from('revenue_data')
          .select('standard_sku, platform, standard_revenue, standard_units, standard_city, standard_state, order_date, standard_status, standard_product_name, standard_order_id, financial_status, risk_level, tags')
          .eq('client_id', client.id)
          .order('id')
          .range(rangeFrom, rangeTo);
        if (sku)      q = q.eq('standard_sku', sku);
        if (platform) q = q.in('platform', expandPlatform(platform));
        // FIX: combined into single .or() — see platform-sales fix above
        if (from || to) {
          if (from && to) {
            q = q.or(`and(order_date.gte.${from},order_date.lte.${to}),order_date.is.null`);
          } else if (from) {
            q = q.or(`order_date.gte.${from},order_date.is.null`);
          } else {
            q = q.or(`order_date.lte.${to},order_date.is.null`);
          }
        }
        return q;
      }),
      (() => {
        let cq = supabaseAdmin
          .from('campaign_data')
          .select('platform, campaign_date, standard_spend, standard_revenue, campaign_name')
          .eq('client_id', client.id);
        if (platform) cq = cq.in('platform', expandPlatform(platform));
        return cq.then(({ data, error }) => { if (error) throw new Error(error.message); return data || []; });
      })(),
    ]).catch(e => {
      console.error('[sku-performance]', e.message);
      return res.status(500).json({ error: 'Failed to fetch SKU data.' });
    });

    if (res.headersSent) return;

    // Backfill blank city/state from a sibling line-item row of the
    // same order — the same fix already applied in Geographic
    // Analysis (backfillLocationByOrder), just not wired in here
    // until now. Some platform exports (Shopify-shaped ones
    // especially — see the discount-allocation fix and its comments
    // for the same underlying export quirk) only populate shipping
    // details on ONE row per multi-item order, leaving every other
    // line item's city/state blank — which is exactly why "Unknown"
    // was showing up as a top city: those blank rows were being
    // counted as a real "Unknown" location instead of backfilled from
    // their own order's other line item. Then raw_extras is dropped
    // before the response goes out — only needed here for the
    // order-grouping itself, and can contain buyer name/phone/address
    // on platforms that expose that in unmapped columns.
    for (const r of revenueRows) {
      if (r.standard_state) r.standard_state = normaliseStateName(r.standard_state);
    }
    backfillLocationByOrder(revenueRows);
    // raw_extras not fetched for SKU performance — no cleanup needed

    // Same opt-in exclusion as /platform-sales — nothing dropped
    // unless the caller passes ?excludeStatuses=...
    const excludeStatuses = req.query.excludeStatuses
      ? new Set(req.query.excludeStatuses.split(',').map(s => s.trim()).filter(Boolean))
      : new Set();
    const filteredRevenue = excludeStatuses.size
      ? revenueRows.filter(r => !r.standard_status || !excludeStatuses.has(r.standard_status))
      : revenueRows;

    // ── Product → Campaign matching ─────────────────────────────
    // Ad platforms (Meta/Google/most Amazon exports) don't tag a
    // campaign with a SKU, so there's no direct join available. This
    // is a best-effort text match: infer the selected SKU's category
    // (same keyword logic as Revenue by Category), then flag any
    // campaign whose name contains one of that category's keywords.
    // Always returns the full campaign list too, so the frontend can
    // fall back to "show everything" if the match comes back empty —
    // never silently hides data behind a match that missed.
    let productCategory = null;
    let campaignsMatchedToProduct = [];
    if (sku) {
      const skuRow = filteredRevenue.find(r => r.standard_sku === sku);
      productCategory = inferCategory(skuRow?.standard_product_name, sku);
      const catEntry = CATEGORY_KEYWORDS.find(([cat]) => cat === productCategory);
      const keywords = catEntry ? catEntry[1] : [];
      if (keywords.length) {
        campaignsMatchedToProduct = campaignRows.filter(c => {
          const name = (c.campaign_name || '').toLowerCase();
          return keywords.some(kw => name.includes(kw));
        });
      }
    }

    return res.json({
      revenue:   filteredRevenue,
      campaigns: campaignRows,
      productCategory,
      campaignsMatchedToProduct,
    });
  }
);


// ═══════════════════════════════════════════════════════════════════
// CAMPAIGN INSIGHTS
//
// Previously returned raw campaign_data rows only, leaving the
// frontend to compute everything (or not — spend vs revenue, fulfilment
// channel split, and product breakdown weren't shown anywhere). Now
// returns three pieces in one response:
//   - campaigns:            raw rows, unchanged shape, for anyone still
//                            consuming the old response format
//   - platformSummary:      spend vs revenue vs ROAS per platform
//   - fulfillmentBreakdown: Amazon/Acutas FBA vs Merchant split
//                            (pulled from revenue_data, since fulfilment
//                            channel is a revenue-side field, not a
//                            campaign-side field)
//   - topProducts:          product-wise revenue for the platforms in
//                            this view, so Campaign Insights can show
//                            "which SKUs is this ad spend driving" next
//                            to the spend numbers
// ═══════════════════════════════════════════════════════════════════
router.get(
  '/:client_slug/campaign-insights',
  requireTab('campaign_insights'),
  async (req, res) => {
    const { client } = req.semya;
    const { from, to, platform } = req.query;
    const excludeStatuses = req.query.excludeStatuses
      ? new Set(req.query.excludeStatuses.split(',').map(s => s.trim()).filter(Boolean))
      : new Set();

    let query = supabaseAdmin
      .from('campaign_data')
      .select('*')
      .eq('client_id', client.id)
      .order('campaign_date', { ascending: false });

    // Undated campaign rows (campaign_date IS NULL) used to be included
    // via an "OR campaign_date IS NULL" fallback on BOTH the gte and lte
    // filters — which, combined, is equivalent to
    // "(date in range) OR (date is null)". That means any undated
    // campaign silently matched every possible date range, so if a
    // meaningful share of campaign_data rows have no campaign_date set,
    // picking a narrow range (or even a single day) still pulls in the
    // full all-time total for those rows — the date filter becomes a
    // no-op for exactly the rows that most need it to work. Now: when a
    // date filter is actually active, apply it strictly (undated rows
    // are excluded, since we genuinely don't know if they belong in the
    // selected window); only fall back to "everything" when no filter
    // is applied at all.
    if (from && to) query = query.gte('campaign_date', from).lte('campaign_date', to);
    else if (from)  query = query.gte('campaign_date', from);
    else if (to)    query = query.lte('campaign_date', to);
    if (platform) query = query.in('platform', expandPlatform(platform));

    const { data: campaigns, error } = await query;
    if (error) return res.status(500).json({ error: 'Failed to fetch campaigns.' });

    // Surface how many campaigns were excluded for having no date at
    // all, whenever a date filter is active — otherwise a narrow range
    // and a wide range can return suspiciously similar totals (both
    // scoped to the same small dated subset) with no visible
    // explanation for why. One cheap count query, only when needed.
    let undatedCampaignsExcluded = 0;
    if (from || to) {
      let undatedQ = supabaseAdmin
        .from('campaign_data')
        .select('id', { count: 'exact', head: true })
        .eq('client_id', client.id)
        .is('campaign_date', null);
      if (platform) undatedQ = undatedQ.in('platform', expandPlatform(platform));
      const { count } = await undatedQ;
      undatedCampaignsExcluded = count || 0;
    }

    // Pull matching revenue-side rows for the same window/platform so we
    // can compute fulfilment-channel split and product breakdown. This is
    // a second, smaller query rather than joining in SQL because
    // revenue_data and campaign_data aren't guaranteed to share a key —
    // platform + date range is the only reliable overlap.
    const revenueRows = await fetchAllRows((rangeFrom, rangeTo) => {
      let q = supabaseAdmin
        .from('revenue_data')
        .select('platform, standard_revenue, standard_units, standard_sku, standard_status, standard_fulfillment_channel, order_date, standard_order_id')
        .eq('client_id', client.id)
        .order('id')
        .range(rangeFrom, rangeTo);
      // FIX: combined into single .or() — see platform-sales fix above
      if (from || to) {
        if (from && to) {
          q = q.or(`and(order_date.gte.${from},order_date.lte.${to}),order_date.is.null`);
        } else if (from) {
          q = q.or(`order_date.gte.${from},order_date.is.null`);
        } else {
          q = q.or(`order_date.lte.${to},order_date.is.null`);
        }
      }
      if (platform) q = q.in('platform', expandPlatform(platform));
      return q;
    }).catch((e) => { throw e; });

    const revenueFiltered = excludeStatuses.size
      ? revenueRows.filter(r => !r.standard_status || !excludeStatuses.has(r.standard_status))
      : revenueRows;

    const insights = aggregateCampaignInsights(campaigns, revenueFiltered);

    return res.json({
      campaigns,
      undatedCampaignsExcluded,
      ...insights,
    });
  }
);

function aggregateCampaignInsights(campaignRows, revenueRows) {
  // ── Spend vs revenue vs ROAS, per platform ─────────────────────
  const byPlatform = {};
  // Track which dates actually have campaign spend data, per platform —
  // used below to scope revenue to the SAME period as spend, so ROAS
  // isn't comparing partial-period ad spend against a full date-range's
  // worth of revenue. If campaign data only covers 10 of 30 selected
  // days, revenue from the other 20 days shouldn't count toward this
  // platform's ROAS — that's not "free" revenue, it's revenue this ad
  // spend data literally can't speak to.
  const campaignDatesByPlatform = {};

  for (const row of campaignRows) {
    const p = row.platform;
    if (!byPlatform[p]) byPlatform[p] = { platform: p, spend: 0, campaignRevenue: 0 };
    byPlatform[p].spend           += Number(row.standard_spend)   || 0;
    byPlatform[p].campaignRevenue += Number(row.standard_revenue) || 0;
    if (row.campaign_date) {
      if (!campaignDatesByPlatform[p]) campaignDatesByPlatform[p] = new Set();
      campaignDatesByPlatform[p].add(row.campaign_date);
    }
  }

  // Actual (order-level) revenue per platform, from revenue_data —
  // more trustworthy than a campaign export's self-reported attributed
  // revenue, and what "revenue vs spend" should really compare against.
  // Scoped to campaign-covered dates only (see above) — a platform with
  // NO campaign dates recorded at all falls back to the full range,
  // since there's nothing to scope against; that platform just won't
  // get a meaningful ROAS (spend is 0, so roas comes out null anyway).
  for (const row of revenueRows) {
    const p = row.platform;
    if (!byPlatform[p]) byPlatform[p] = { platform: p, spend: 0, campaignRevenue: 0 };
    const coveredDates = campaignDatesByPlatform[p];
    const inCoverage = !coveredDates || coveredDates.size === 0 || coveredDates.has(row.order_date);
    if (inCoverage) {
      byPlatform[p].actualRevenue = (byPlatform[p].actualRevenue || 0) + (Number(row.standard_revenue) || 0);
    }
    // Full-period revenue tracked separately — still useful context,
    // just not what ROAS should be computed against.
    byPlatform[p].fullPeriodRevenue = (byPlatform[p].fullPeriodRevenue || 0) + (Number(row.standard_revenue) || 0);
  }
  const platformSummary = Object.values(byPlatform).map(p => ({
    ...p,
    actualRevenue: p.actualRevenue || 0,
    fullPeriodRevenue: p.fullPeriodRevenue || 0,
    campaignCoverageDays: campaignDatesByPlatform[p.platform]?.size || 0,
    roas:   p.spend > 0 ? +((p.actualRevenue || p.campaignRevenue) / p.spend).toFixed(2) : null,
    profit: (p.actualRevenue || p.campaignRevenue) - p.spend,
  }));

  const totalSpend   = platformSummary.reduce((s, p) => s + p.spend, 0);
  const totalRevenue = platformSummary.reduce((s, p) => s + (p.actualRevenue || p.campaignRevenue), 0);
  const totalFullPeriodRevenue = platformSummary.reduce((s, p) => s + p.fullPeriodRevenue, 0);

  // ── Fulfilment channel split (Amazon FBA vs Merchant) ──────────
  // Only meaningful for platforms whose export includes it — currently
  // Amazon/Acutas. Rows without the field used to all collapse into a
  // single shared "Not specified" bucket regardless of platform, which
  // made it look like a third of all orders had missing fulfilment
  // data. In reality Meta/Website/Flipkart/Blinkit never report this
  // field at all — it's not missing, it's simply not applicable to
  // them. Label those rows by their own platform instead, and reserve
  // "Not specified" for the genuine case: an Amazon/Acutas row whose
  // export happened to leave this field blank.
  const FULFILLMENT_AWARE_PLATFORMS = new Set(['amazon', 'acutas']);
  const byFulfillment = {};
  for (const row of revenueRows) {
    const isAware = FULFILLMENT_AWARE_PLATFORMS.has((row.platform || '').toLowerCase());
    const ch = row.standard_fulfillment_channel
      || (isAware ? 'Not specified' : (row.platform || 'Unknown platform'));
    if (!byFulfillment[ch]) byFulfillment[ch] = { channel: ch, revenue: 0, units: 0, orders: 0, _orderIds: new Set(), _rowsWithoutOrderId: 0 };
    byFulfillment[ch].revenue += Number(row.standard_revenue) || 0;
    byFulfillment[ch].units   += Number(row.standard_units)   || 0;
    if (row.standard_order_id) byFulfillment[ch]._orderIds.add(row.standard_order_id);
    else byFulfillment[ch]._rowsWithoutOrderId += 1;
  }
  const fulfillmentBreakdown = Object.values(byFulfillment).map(f => ({
    channel: f.channel, revenue: f.revenue, units: f.units,
    orders: f._orderIds.size + f._rowsWithoutOrderId,
  }));

  // ── Product-wise revenue, for the platforms in this view ───────
  const byProduct = {};
  for (const row of revenueRows) {
    // Use SKU as the primary key, fall back to product name when SKU
    // is null or blank. This is common for Shopify/Meta exports where
    // the Lineitem sku cell is empty for some orders but Lineitem name
    // is always populated — using the product name as a display key
    // is more useful than grouping everything into a single "No SKU"
    // bucket, which hid ₹60L+ of Meta revenue behind a meaningless
    // label and made the Top Products table almost useless for Meta.
    const displayKey = (row.standard_sku && row.standard_sku.trim())
      ? row.standard_sku.trim()
      : (row.standard_product_name && row.standard_product_name.trim())
        ? row.standard_product_name.trim()
        : 'Unknown product';
    const key = row.platform + '|' + displayKey;
    if (!byProduct[key]) byProduct[key] = { sku: displayKey, platform: row.platform, revenue: 0, units: 0 };
    byProduct[key].revenue += Number(row.standard_revenue) || 0;
    byProduct[key].units   += Number(row.standard_units)   || 0;
  }
  const topProducts = Object.values(byProduct).sort((a, b) => b.revenue - a.revenue).slice(0, 15);

  return {
    platformSummary,
    totalSpend,
    totalRevenue,
    totalFullPeriodRevenue,
    overallRoas: totalSpend > 0 ? +(totalRevenue / totalSpend).toFixed(2) : null,
    fulfillmentBreakdown,
    topProducts,
  };
}


// ═══════════════════════════════════════════════════════════════════
// GEOGRAPHIC ANALYSIS
// ═══════════════════════════════════════════════════════════════════
router.get(
  '/:client_slug/geographic',
  requireTab('geographic_analysis'),
  async (req, res) => {
    const { client } = req.semya;
    const { from, to, sku, platform } = req.query;

    const geoRows = await fetchAllRows((rangeFrom, rangeTo) => {
      let q = supabaseAdmin
        .from('revenue_data')
        .select('standard_city, standard_state, standard_revenue, standard_units, standard_sku, standard_status, platform, standard_order_id')
        .eq('client_id', client.id)
        .order('id')
        .range(rangeFrom, rangeTo);
      // FIX: combined into single .or() — see platform-sales fix above
      if (from || to) {
        if (from && to) {
          q = q.or(`and(order_date.gte.${from},order_date.lte.${to}),order_date.is.null`);
        } else if (from) {
          q = q.or(`order_date.gte.${from},order_date.is.null`);
        } else {
          q = q.or(`order_date.lte.${to},order_date.is.null`);
        }
      }
      if (sku)      q = q.eq('standard_sku', sku);
      if (platform) q = q.in('platform', expandPlatform(platform));
      return q;
    }).catch(e => { return res.status(500).json({ error: 'Failed to fetch geographic data.' }); });

    if (res.headersSent) return;

    // Normalise state spelling (existing data may have abbreviations or
    // inconsistent casing from before this normalisation existed) — do
    // this before the order-based backfill so sibling rows compare equal.
    for (const r of geoRows) {
      if (r.standard_state) r.standard_state = normaliseStateName(r.standard_state);
    }

    // Backfill blank city/state from a sibling line-item row of the
    // same order (some exports only populate shipping details on one
    // row per order). Then drop raw_extras — it's only needed here for
    // that grouping and shouldn't leave the server (it can contain
    // buyer name/phone/address for platforms that expose that).
    backfillLocationByOrder(geoRows);
    // raw_extras not fetched for geo — no cleanup needed

    const excludeStatusesGeo = req.query.excludeStatuses
      ? new Set(req.query.excludeStatuses.split(',').map(s => s.trim()).filter(Boolean))
      : new Set();
    const filteredGeo = excludeStatusesGeo.size
      ? geoRows.filter(r => !r.standard_status || !excludeStatusesGeo.has(r.standard_status))
      : geoRows;
    return res.json(filteredGeo);
  }
);


// ═══════════════════════════════════════════════════════════════════
// AI INSIGHTS  (data payload for the insight generator)
// ═══════════════════════════════════════════════════════════════════
router.get(
  '/:client_slug/ai-insights',
  requireTab('ai_insights'),
  async (req, res) => {
    const { client } = req.semya;
    const { sku, from, to } = req.query;

    // Pull revenue via fetchAllRows — the old Promise.all used a direct
    // supabaseAdmin call with no pagination, silently capping at 1000 rows.
    // Clients with more data got truncated AI insights with no error shown.
    let revenueRows, campaignRows;
    try {
      [revenueRows, campaignRows] = await Promise.all([
        fetchAllRows((rangeFrom, rangeTo) => {
          let q = supabaseAdmin
            .from('revenue_data')
            .select('standard_sku, platform, standard_revenue, standard_units, standard_city, order_date')
            .eq('client_id', client.id)
            .order('id')
            .range(rangeFrom, rangeTo);
          if (sku) q = q.eq('standard_sku', sku);
          // Single .or() for date range — same pattern used by every other route.
          if (from || to) {
            if (from && to) {
              q = q.or(`and(order_date.gte.${from},order_date.lte.${to}),order_date.is.null`);
            } else if (from) {
              q = q.or(`order_date.gte.${from},order_date.is.null`);
            } else {
              q = q.or(`order_date.lte.${to},order_date.is.null`);
            }
          }
          return q;
        }),
        (() => {
          let cq = supabaseAdmin
            .from('campaign_data')
            .select('platform, standard_spend, standard_revenue, standard_clicks, standard_impressions, campaign_date')
            .eq('client_id', client.id);
          // Apply date filter strictly — no "OR IS NULL" fallback (see campaign-insights fix).
          if (from && to) cq = cq.gte('campaign_date', from).lte('campaign_date', to);
          else if (from)  cq = cq.gte('campaign_date', from);
          else if (to)    cq = cq.lte('campaign_date', to);
          return cq.then(({ data, error }) => { if (error) throw new Error(error.message); return data || []; });
        })(),
      ]);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to fetch insight data.' });
    }

    return res.json({ revenue: revenueRows, campaigns: campaignRows });
  }
);


// ═══════════════════════════════════════════════════════════════════
// FRAUD / CANCELLATION-PATTERN DETECTION
//
// Flags buyer identities (matched by phone, or by name+pincode when
// phone isn't available) with either: (a) multiple different names
// ordering from the same contact details, or (b) an abnormally high
// cancel/return rate. Only covers platforms whose export actually
// includes buyer PII — Amazon/Acutas never do, so their rows are
// counted in `skippedNoIdentity` rather than silently mis-flagged.
// ═══════════════════════════════════════════════════════════════════
router.get(
  '/:client_slug/fraud-patterns',
  requireTab('ai_insights'),
  async (req, res) => {
    const { client } = req.semya;
    const { from, to } = req.query;

    // PERFORMANCE FIX: skip Amazon/Acutas at DB level (they never have
    // buyer PII so the fraud detector skips them anyway) — this cuts
    // ~40% of rows from the scan immediately. We still fetch full
    // raw_extras for the remaining platforms because extractIdentity()
    // needs 26 different possible key names across platforms and
    // trying to extract them individually via SQL operators is brittle
    // and easy to miss. The real speedup comes from excluding the
    // platforms with no PII, not from column projection.
    const rows = await fetchAllRows((rangeFrom, rangeTo) => {
      let q = supabaseAdmin
        .from('revenue_data')
        .select('platform, standard_status, standard_revenue, standard_sku, order_date, raw_extras')
        .eq('client_id', client.id)
        .not('platform', 'in', '(amazon,acutas)')
        .order('id')
        .range(rangeFrom, rangeTo);
      if (from || to) {
        if (from && to) {
          q = q.or(`and(order_date.gte.${from},order_date.lte.${to}),order_date.is.null`);
        } else if (from) {
          q = q.or(`order_date.gte.${from},order_date.is.null`);
        } else {
          q = q.or(`order_date.lte.${to},order_date.is.null`);
        }
      }
      return q;
    }).catch((e) => { return res.status(500).json({ error: 'Failed to fetch data for pattern detection: ' + e.message }); });

    if (res.headersSent) return;

    const result = detectSuspiciousPatterns(rows);
    return res.json(result);
  }
);


// ═══════════════════════════════════════════════════════════════════
// HELPER — platform sales aggregator
// ═══════════════════════════════════════════════════════════════════
// No longer a hardcoded server-side exclusion. Kept here only as the
// suggested preset the frontend can offer under a "Hide cancelled/
// returned" filter — the user opts in via ?excludeStatuses=... on each
// endpoint. Default behaviour (no param) now includes every status,
// matching the old dashboard's checkboxes-all-checked default.
const SUGGESTED_EXCLUDABLE_STATUSES = ['Cancelled','Pending','Unshipped','Shipped - Returned to Seller','Shipped - Returning to Seller'];

function aggregatePlatformSales(rows, excludeStatuses = new Set(), excludeFulfillStatuses = new Set()) {
  const byPlatform = {};
  const byDay      = {};
  const byWeek     = {};
  const byMonth    = {};
  const byYear     = {};
  const byCategory = {};
  const byProduct  = {};

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  for (const row of rows) {
    // Only skip a status if the caller explicitly asked to exclude it
    // (via ?excludeStatuses=...). Default is empty — every row counts,
    // matching the old dashboard where all status checkboxes start
    // checked. Cancelled/Pending/Returned rows stay visible by default
    // so the team can see the full picture, not just fulfilled orders.
    if (row.standard_status && excludeStatuses.has(row.standard_status)) continue;
    // Fulfillment status filter — exclude rows with specific fulfillment statuses
    if (excludeFulfillStatuses.size > 0 && row.standard_status && excludeFulfillStatuses.has(row.standard_status)) continue;
    // Sub-rows (extra line items) have no standard_status — only the main
    // order row gets one. Use this to identify and skip sub-rows for
    // order counts and units. Cancelled = voided/refunded orders.
    const isCancelled  = row.standard_status === 'Cancelled';
    // Main row = has revenue > 0. Sub-rows have been zeroed in the DB.
    // This is more reliable than checking standard_status because
    // fileIngestion forward-fills status to ALL rows of an order.
    const isMainRow    = Number(row.standard_revenue ?? 0) > 0;

    const p   = row.platform;
    const rev = Number(row.standard_revenue ?? 0);
    const u   = Number(row.standard_units   ?? 0);

    if (!byPlatform[p]) byPlatform[p] = { platform: p, totalRevenue: 0, totalUnits: 0, orderCount: 0, fulfilledCount: 0, _orderIds: new Set(), _fulfilledIds: new Set(), _rowsWithoutOrderId: 0 };
    byPlatform[p].totalRevenue += isCancelled ? 0 : rev;
    byPlatform[p].totalUnits   += (!isMainRow || isCancelled) ? 0 : u;
    // Count DISTINCT orders, not rows. An order with 2 line items (2
    // products) is 1 order, not 2 — previously this incremented once
    // per row, which is why order counts sat suspiciously close to
    // units-sold counts (both were really counting line-items). Falls
    // back to per-row counting only for rows with no order ID at all
    // (a platform whose export doesn't include one), rather than
    // silently dropping those rows from the count entirely.
    // Only count orders on main rows (have a status) that are not cancelled
    if (isMainRow && !isCancelled) {
      if (row.standard_order_id) {
        byPlatform[p]._orderIds.add(row.standard_order_id);
        // Track fulfilled orders separately
        // These are all statuses that mean the order was shipped/delivered
        const fs = (row.standard_status || '').toLowerCase();
        const FULFILLED_STATUSES = [
          'shipped', 'delivered', 'approved', 'shipping',
          'shipped - delivered to buyer', 'shipped - picked up',
          'shipped - out for delivery',
        ];
        if (FULFILLED_STATUSES.some(s => fs === s)) {
          byPlatform[p]._fulfilledIds.add(row.standard_order_id);
        }
      } else {
        byPlatform[p]._rowsWithoutOrderId += 1;
      }
    }

    // Time-bucketed aggregation — day, week, month, year all computed
    // in the same pass so the frontend can switch granularity instantly
    // without a re-fetch.
    if (row.order_date) {
      const d = new Date(row.order_date);
      const yr = d.getFullYear(), mo = d.getMonth();

      const dkey = row.order_date; // already YYYY-MM-DD
      if (!byDay[dkey]) byDay[dkey] = { rev: 0, sort: dkey };
      byDay[dkey].rev += rev;

      const wk = 'W' + Math.ceil(d.getDate()/7) + ' ' + MONTHS[mo] + " '" + String(yr).slice(2);
      const ws = yr * 10000 + mo * 100 + Math.ceil(d.getDate()/7);
      if (!byWeek[wk]) byWeek[wk] = { rev: 0, sort: ws };
      byWeek[wk].rev += rev;

      const mkey = MONTHS[mo] + " '" + String(yr).slice(2);
      const ms = yr * 100 + mo;
      if (!byMonth[mkey]) byMonth[mkey] = { rev: 0, sort: ms };
      byMonth[mkey].rev += rev;

      const ykey = String(yr);
      if (!byYear[ykey]) byYear[ykey] = { rev: 0, sort: yr };
      byYear[ykey].rev += rev;
    }

    // Top products — keyed by platform+SKU, not SKU alone. Two
    // different platforms can both have an unmapped/"Unknown" SKU;
    // keying by SKU alone would silently merge their revenue into a
    // single row attributed to whichever platform was seen first.
    const displaySku = (row.standard_sku && row.standard_sku.trim())
      ? row.standard_sku.trim()
      : (row.standard_product_name && row.standard_product_name.trim())
        ? row.standard_product_name.trim()
        : 'Unknown product';
    const prodKey = p + '|' + displaySku;
    if (!byProduct[prodKey]) byProduct[prodKey] = { sku: displaySku, platform: p, revenue: 0, units: 0 };
    byProduct[prodKey].revenue += isCancelled ? 0 : rev;
    byProduct[prodKey].units   += (!isMainRow || isCancelled) ? 0 : u;

    // Category — ported keyword inference from the old dashboard, run
    // against the product name (falls back to SKU internally if the
    // name is blank/unmatched). Grouped across all platforms, not
    // per-platform, since a category like "Castor Oil" is the same
    // product line regardless of which channel it sold through.
    //
    // Split "Uncategorized" into two honest buckets instead of one
    // misleading one: ad platforms like Meta report revenue at the
    // campaign level with NO product name or SKU at all — that's not
    // a classification failure, there's genuinely nothing to classify.
    // A real product name/SKU that just didn't match any keyword is a
    // different, fixable problem (the keyword list is missing a
    // product line) and shouldn't be hidden inside the same bucket.
    const hasProductSignal = !!(row.standard_product_name || (row.standard_sku && row.standard_sku.trim()));
    let category = inferCategory(row.standard_product_name, row.standard_sku);
    if (category === 'Uncategorized' && !hasProductSignal) {
      category = 'No Product Data (Ad Platforms)';
    }
    if (!byCategory[category]) byCategory[category] = { category, revenue: 0, units: 0 };
    byCategory[category].revenue += rev;
    byCategory[category].units   += u;
  }

  // Finalise distinct order counts (Set → number) and strip the
  // internal tracking fields — they're not part of the public shape.
  for (const p of Object.values(byPlatform)) {
    p.orderCount     = p._orderIds.size + p._rowsWithoutOrderId;
    p.fulfilledCount = p._fulfilledIds.size;
    delete p._orderIds;
    delete p._fulfilledIds;
    delete p._rowsWithoutOrderId;
  }

  // Sorted highest revenue first — previously this was whatever order
  // Object.values() happened to preserve, which is really just
  // "whichever platform's first row appeared earliest in the raw
  // query results." That's not a meaningful ordering for a "split"
  // view at all (it could put a 2.6% platform above a 3.2% one purely
  // by insertion accident) — sorted explicitly here so every consumer
  // of this endpoint gets a consistent, sensible order for free.
  const platforms  = Object.values(byPlatform).sort((a, b) => b.totalRevenue - a.totalRevenue);
  const grandTotal = platforms.reduce((s, p) => s + p.totalRevenue, 0);

  const bucketToArr = (bucket, labelKey) => Object.entries(bucket)
    .sort((a, b) => (a[1].sort > b[1].sort ? 1 : a[1].sort < b[1].sort ? -1 : 0))
    .map(([label, v]) => ({ [labelKey]: label, revenue: v.rev }));

  const daily   = bucketToArr(byDay,   'day').map(d => ({ ...d, week: d.day }));
  const weekly  = Object.entries(byWeek)
    .sort((a, b) => a[1].sort - b[1].sort)
    .map(([week, v]) => ({ week, revenue: v.rev }));
  const monthly = bucketToArr(byMonth, 'month').map(d => ({ ...d, week: d.month }));
  const yearly  = bucketToArr(byYear,  'year').map(d => ({ ...d, week: d.year }));

  const topProducts = Object.values(byProduct)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  const categories = Object.values(byCategory)
    .sort((a, b) => b.revenue - a.revenue);

  // Cancelled orders — count unique order IDs with Cancelled status
  // (already tracked in the main loop above, no second pass needed)
  const cancelledUniqueOrders = Object.values(byPlatform)
    .reduce((s, p) => s, 0); // placeholder — route fills this after calling

  return {
    grandTotal,
    prevGrandTotal: null,  // overwritten by caller
    cancelledRevenue: 0,   // overwritten by caller
    cancelledOrders:  0,   // overwritten by caller
    weekly,
    daily,
    monthly,
    yearly,
    topProducts,
    categories,
    platforms: platforms.map((p) => ({
      ...p,
      sharePercent: grandTotal > 0 ? +((p.totalRevenue / grandTotal) * 100).toFixed(1) : 0,
    })),
  };
}


export default router;
