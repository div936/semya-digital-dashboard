-- db/inventory_schema.sql
-- ─────────────────────────────────────────────────────────────────
-- INVENTORY MANAGEMENT
--
-- Built around a request to tie UTM/sales tracking to real warehouse
-- stock: every sale should decrement the right warehouse's quantity
-- for that SKU, and admins should be able to set a low-stock trigger
-- that surfaces an alert before a SKU actually runs out.
--
-- FOUR TABLES, each solving one specific part of this:
--
--   warehouses            — the physical (or 3PL/FBA) locations stock
--                            can sit in. One is marked is_default —
--                            where a sale lands if nothing more
--                            specific is configured for its platform.
--
--   platform_warehouse_map — which warehouse a sale on a given
--                            platform should deduct from (e.g. Amazon
--                            FBA orders might fulfill from an "Amazon
--                            FC" warehouse, Website orders from a
--                            "Main Warehouse"). Falls back to the
--                            default warehouse if a platform has no
--                            explicit mapping.
--
--   inventory_stock        — current on-hand quantity per SKU per
--                            warehouse, plus a low-stock threshold
--                            (in units) that triggers an alert.
--
--   inventory_movements     — an append-only ledger of every stock
--                            change (a sale, or a manual admin
--                            adjustment). THIS IS WHAT MAKES
--                            AUTOMATIC DEDUCTION SAFE TO RUN ON EVERY
--                            UPLOAD: it's keyed uniquely on
--                            source_row_hash (the same row_hash
--                            already computed for de-duplicating
--                            revenue_data — see fileIngestion.js).
--                            Re-uploading a file that's already been
--                            processed tries to insert the same
--                            movement row again, which the unique
--                            constraint silently rejects — so a sale
--                            can NEVER be deducted twice, no matter
--                            how many times its source file gets
--                            re-uploaded. Manual adjustments use a
--                            generated random source_row_hash instead
--                            of a real one, since they're one-off by
--                            nature and have no natural idempotency
--                            key to reuse.
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS warehouses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  location    TEXT,                          -- free-text city/region, optional
  is_default  BOOLEAN NOT NULL DEFAULT FALSE, -- where unmapped platforms' sales deduct from
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, name)
);

-- Only one default warehouse per client — enforced with a partial
-- unique index rather than a CHECK constraint, since CHECK can't see
-- across rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_warehouses_one_default
  ON warehouses (client_id) WHERE is_default = TRUE;


CREATE TABLE IF NOT EXISTS platform_warehouse_map (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  platform     TEXT NOT NULL,   -- 'amazon' | 'acutas' | 'flipkart' | 'blinkit' | 'meta' | 'google'
  warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  UNIQUE (client_id, platform)
);


CREATE TABLE IF NOT EXISTS inventory_stock (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  warehouse_id        UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  standard_sku        TEXT NOT NULL,
  quantity_on_hand    INTEGER NOT NULL DEFAULT 0,
  low_stock_threshold INTEGER NOT NULL DEFAULT 10,  -- alert fires at or below this quantity
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, warehouse_id, standard_sku)
);

CREATE INDEX IF NOT EXISTS idx_inventory_stock_client ON inventory_stock (client_id);
CREATE INDEX IF NOT EXISTS idx_inventory_stock_sku     ON inventory_stock (client_id, standard_sku);


CREATE TABLE IF NOT EXISTS inventory_movements (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  warehouse_id     UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  standard_sku     TEXT NOT NULL,
  qty_delta        INTEGER NOT NULL,   -- negative for a sale/deduction, positive for a restock/adjustment
  reason           TEXT NOT NULL DEFAULT 'sale' CHECK (reason IN ('sale', 'manual_adjustment', 'restock')),
  platform         TEXT,               -- which platform's sale caused this, null for manual movements
  source_row_hash  TEXT NOT NULL,      -- revenue_data.row_hash for a sale; a random uuid string for manual moves
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, source_row_hash)  -- THE idempotency guarantee — see file header
);

CREATE INDEX IF NOT EXISTS idx_inventory_movements_sku ON inventory_movements (client_id, standard_sku, created_at DESC);


-- Seed a single default "Main Warehouse" per existing client, so
-- there's always somewhere for a sale to deduct from immediately
-- after this migration runs, before anyone's configured anything.
INSERT INTO warehouses (client_id, name, is_default, is_active)
SELECT id, 'Main Warehouse', TRUE, TRUE FROM clients
ON CONFLICT (client_id, name) DO NOTHING;
