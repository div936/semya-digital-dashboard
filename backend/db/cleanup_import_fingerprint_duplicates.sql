-- Cleanup: remove imported rows that duplicate an already-existing
-- normal-upload row.
--
-- ROOT CAUSE (confirmed against real production data, not guessed):
-- normal Amazon/Acutas file uploads frequently have NO usable
-- standard_order_id at all — they de-dup on order_item_id, or fall to
-- the composite tier when even that's missing. But every row imported
-- from the old dashboard DOES have an order_id, since that's the only
-- ID its API provides. Two rows for the exact same real sale therefore
-- hash completely differently under row_hash and never collide via
-- the upsert — not because the upsert is broken (it isn't — verified
-- directly: zero duplicate row_hash values, zero duplicate
-- (order_id, sku) pairs anywhere in the table), but because row_hash
-- was never a matchable key between these two specific data sources
-- for rows without a usable order ID on the upload side.
--
-- This mirrors the exact fix already applied in reconciliationRouter.js's
-- import endpoint (see the long comment there) — matching on a content
-- fingerprint (SKU + date + revenue + units) instead of order ID, since
-- that doesn't depend on either side having a usable order ID.
--
-- SAFE BY CONSTRUCTION: only ever deletes rows tagged
-- raw_extras->>'imported_from' = 'old_dashboard' that have a matching
-- fingerprint on a DIFFERENT, non-imported row. Never touches a normal
-- upload's own data, and never deletes an imported row that's
-- genuinely unique (no matching fingerprint found) — those are real,
-- legitimately-missing data that the import was supposed to add.
-- ─────────────────────────────────────────────────────────────────

-- STEP 1 — Preview only. Run this first and look at the numbers
-- before deleting anything.
select
  count(*)                    as duplicate_imported_rows,
  sum(a.standard_revenue)     as inflated_revenue,
  array_agg(distinct a.platform) as affected_platforms
from revenue_data a
where a.raw_extras->>'imported_from' = 'old_dashboard'
  and exists (
    select 1 from revenue_data b
    where b.client_id = a.client_id
      and b.standard_sku = a.standard_sku
      and b.order_date = a.order_date
      and abs(coalesce(b.standard_revenue, 0) - coalesce(a.standard_revenue, 0)) < 0.01
      and coalesce(b.standard_units, 0) = coalesce(a.standard_units, 0)
      and (b.raw_extras->>'imported_from' is distinct from 'old_dashboard')
  );

-- STEP 2 — The actual delete. Only run this after step 1's numbers
-- look right (the inflated_revenue figure should be in the same
-- ballpark as the gap you were seeing between the two dashboards —
-- around ₹32L based on the numbers discussed).
delete from revenue_data a
where a.raw_extras->>'imported_from' = 'old_dashboard'
  and exists (
    select 1 from revenue_data b
    where b.client_id = a.client_id
      and b.standard_sku = a.standard_sku
      and b.order_date = a.order_date
      and abs(coalesce(b.standard_revenue, 0) - coalesce(a.standard_revenue, 0)) < 0.01
      and coalesce(b.standard_units, 0) = coalesce(a.standard_units, 0)
      and (b.raw_extras->>'imported_from' is distinct from 'old_dashboard')
  );

-- STEP 3 — Confirm afterward: should return 0.
select count(*) as remaining_duplicates
from revenue_data a
where a.raw_extras->>'imported_from' = 'old_dashboard'
  and exists (
    select 1 from revenue_data b
    where b.client_id = a.client_id
      and b.standard_sku = a.standard_sku
      and b.order_date = a.order_date
      and abs(coalesce(b.standard_revenue, 0) - coalesce(a.standard_revenue, 0)) < 0.01
      and coalesce(b.standard_units, 0) = coalesce(a.standard_units, 0)
      and (b.raw_extras->>'imported_from' is distinct from 'old_dashboard')
  );
