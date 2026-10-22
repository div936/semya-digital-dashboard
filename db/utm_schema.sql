-- db/utm_schema.sql
-- ─────────────────────────────────────────────────────────────────
-- UTM TRACKING
--
-- Client-scoped port of the click/conversion tracking system used on
-- the previous single-tenant dashboard (same table shapes, same two-
-- snippet architecture: Snippet A captures the click on landing and
-- writes it into Shopify cart attributes; Snippet B, a Shopify
-- Customer Event Pixel, reads those attributes at checkout and pings
-- the conversion). Every table gets a client_id here since one Semya
-- deployment serves multiple clients/stores, unlike the original.
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS utm_clicks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  utm_source   TEXT,
  utm_medium   TEXT,
  utm_campaign TEXT,
  utm_term     TEXT,
  utm_content  TEXT,
  page         TEXT,
  clicked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_hash      TEXT              -- SHA-256, truncated — never store raw IPs
);

CREATE TABLE IF NOT EXISTS utm_conversions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  utm_source      TEXT,
  utm_medium      TEXT,
  utm_campaign    TEXT,
  utm_term        TEXT,
  utm_content     TEXT,
  order_id        TEXT,
  revenue         NUMERIC(12,2) DEFAULT 0,
  type            TEXT NOT NULL DEFAULT 'direct',  -- 'direct' | 'assisted_conversion'
  days_to_convert INTEGER,
  first_seen      TIMESTAMPTZ,
  converted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS utm_saved_links (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  campaign    TEXT,
  source      TEXT,
  medium      TEXT,
  saved_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_utm_clicks_client        ON utm_clicks (client_id, clicked_at DESC);
CREATE INDEX IF NOT EXISTS idx_utm_clicks_campaign       ON utm_clicks (client_id, utm_campaign);
CREATE INDEX IF NOT EXISTS idx_utm_conv_client           ON utm_conversions (client_id, converted_at DESC);
CREATE INDEX IF NOT EXISTS idx_utm_conv_campaign         ON utm_conversions (client_id, utm_campaign);
CREATE INDEX IF NOT EXISTS idx_utm_saved_links_client    ON utm_saved_links (client_id, saved_at DESC);


-- ═══════════════════════════════════════════════════════════════════
-- GA4 (prep only — see routes/utmRouter.js and Settings UI)
--
-- Semya cannot read data back out of Google Analytics itself (that
-- requires a separate OAuth connection to the GA4 Data API, which is
-- out of scope here). This column just stores the client's GA4
-- Measurement ID so the dashboard can generate a ready-to-install
-- gtag.js snippet ("Snippet C") that mirrors the same UTM events into
-- their own GA4 property in parallel — so if/when a GA4 connection is
-- built later, the tracking pixel is already live and already
-- collecting history instead of starting from zero.
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE clients ADD COLUMN IF NOT EXISTS ga4_measurement_id TEXT;
