// lib/dateUtils.js
// ─────────────────────────────────────────────────────────────────
// This file solves TWO different date problems, deliberately kept
// separate because they have different correct answers:
//
// 1. "What is today's real-world date, right now?" — toISTDateString()
//    / todayIST(). This is genuinely timezone-sensitive: the server
//    process's own clock/timezone shouldn't decide what day it is
//    for an India-based business. Use for date-picker defaults etc.
//
// 2. "What calendar date does this uploaded row belong to?" —
//    extractLiteralDate(). This is NOT a timezone conversion problem
//    — read the comment on that function for the full story, but in
//    short: an earlier version of this file DID try to convert every
//    raw file timestamp through Asia/Kolkata, on the reasonable-
//    sounding theory that a UTC timestamp should be reinterpreted in
//    India's timezone. That was wrong — cross-checked directly
//    against an uploaded Amazon file, it silently underreported a
//    day's revenue by ₹1,390 relative to the business's own expected
//    number, because converting Amazon's genuinely-UTC timestamps
//    into IST rolled some orders into the previous calendar day. The
//    business — and Amazon Seller Central's own daily reports — read
//    the date exactly as the file states it, not through a timezone
//    lens. extractLiteralDate() does that: no conversion, just reads
//    the calendar date as written.
// ─────────────────────────────────────────────────────────────────

const IST_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric', month: '2-digit', day: '2-digit',
});

// Converts a Date object (or anything `new Date(x)` accepts) to a
// 'YYYY-MM-DD' string representing its calendar date IN INDIA TIME —
// not the server's local time, not UTC. Returns null for an
// unparseable input, same contract the old code had.
//
// USE THIS FOR: "what is the real-world calendar date right now" —
// e.g. todayIST() below, for a default date-picker value. That's a
// genuinely timezone-sensitive question about the current moment.
//
// DO NOT use this for parsing a date OUT OF an uploaded file's raw
// timestamp column — see extractLiteralDate() instead, and the
// comment there for why these are different problems with different
// correct answers.
export function toISTDateString(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return null;
  // en-CA locale formats as YYYY-MM-DD directly — no string surgery needed.
  return IST_DATE_FMT.format(d);
}

// Extracts the calendar date exactly as written in a raw export
// timestamp — no timezone conversion at all.
//
// THE STORY: an earlier version of this function converted every raw
// timestamp through Asia/Kolkata, on the theory that a UTC timestamp
// (e.g. Amazon's `purchase-date`, genuinely UTC per Amazon's own
// spec) should be reinterpreted in India's timezone since that's
// where the business operates. That reasoning was self-consistent,
// but wrong in practice: cross-checked directly against an uploaded
// Amazon file, the IST-converted total for a day came out ₹15,625 →
// ₹14,235 — LOWER than the business's own expected number, because
// converting genuinely-UTC timestamps into IST rolls some late-UTC-day
// orders into the previous calendar day from Amazon's own UTC-day
// reporting convention. The business (and Amazon Seller Central's own
// per-day reporting) expects the date to be read exactly as the file
// states it, not reinterpreted through a timezone lens.
//
// This also turns out to be automatically correct for IST-native
// sources too (e.g. Shopify/Meta's "Created at", which already
// carries an explicit +05:30 offset) — the calendar date written in
// that string IS already the IST date, so reading it literally is
// exactly right there too, no conversion needed either way.
//
// Matches on a leading YYYY-MM-DD (covers every real export format
// seen so far: Amazon's ISO 'purchase-date', Shopify/Meta's
// 'Created at'). Falls back to a best-effort Date parse for anything
// unusual (e.g. the "July 16, 2026" preamble-date case in
// fileIngestion.js), which is a rarer path this specific bug report
// doesn't concern.
export function extractLiteralDate(input) {
  if (input == null || input === '') return null;
  const str = String(input).trim();
  const m = str.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(str);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];
}

// Shorthand for "what calendar date is it in India right now" — used
// everywhere something used to default to `new Date().toISOString()...`
export function todayIST() {
  return toISTDateString(new Date());
}
