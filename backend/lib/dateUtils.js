// lib/dateUtils.js
// ─────────────────────────────────────────────────────────────────
// THE BUG THIS FIXES:
//
// Every "get the calendar date" call across this codebase used to do
// `date.toISOString().split('T')[0]` — but toISOString() ALWAYS
// converts to UTC first. This business operates in India (IST,
// UTC+5:30), and platform exports carry real timestamps — Amazon's
// purchase-date in UTC, Shopify/Meta's "Created at" in IST with a
// +05:30 offset. Converting either to a UTC calendar day is wrong for
// this business:
//
//   - An order placed at 00:15 IST on Aug 2 (a customer buying just
//     after midnight, India time) is genuinely an Aug 2 order to
//     everyone involved — the business, the customer, the SKU
//     inventory day. But 00:15 IST is 18:45 UTC on Aug 1, so the old
//     UTC-truncating code silently filed it as an Aug 1 order.
//   - The same bug hit "today" itself: `new Date().toISOString()...`
//     computed the server's UTC calendar day, not India's. For the
//     first ~5.5 hours of every IST calendar day (00:00–05:30 IST),
//     the UTC clock is still on the PREVIOUS day — so Daily Targets
//     (and anything else defaulting to "today") silently defaulted
//     to yesterday's date during that window.
//
// Both of these were live in production, not hypothetical — see the
// deploy notes for the specific Daily Targets report that surfaced it.
//
// Fix: always resolve calendar dates in Asia/Kolkata explicitly,
// regardless of what timezone the server process itself happens to
// be running in. Use these helpers everywhere a calendar-day string
// is derived from a Date or timestamp — never call
// `.toISOString().split('T')[0]` directly again.
// ─────────────────────────────────────────────────────────────────

const IST_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric', month: '2-digit', day: '2-digit',
});

// Converts a Date object (or anything `new Date(x)` accepts) to a
// 'YYYY-MM-DD' string representing its calendar date IN INDIA TIME —
// not the server's local time, not UTC. Returns null for an
// unparseable input, same contract the old code had.
export function toISTDateString(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return null;
  // en-CA locale formats as YYYY-MM-DD directly — no string surgery needed.
  return IST_DATE_FMT.format(d);
}

// Shorthand for "what calendar date is it in India right now" — used
// everywhere something used to default to `new Date().toISOString()...`
export function todayIST() {
  return toISTDateString(new Date());
}
