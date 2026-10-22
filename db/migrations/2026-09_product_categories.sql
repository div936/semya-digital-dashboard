-- ─────────────────────────────────────────────────────────────────
-- 2026-09_product_categories.sql
--
-- Creates per-client product category tables and migrates all
-- existing Neat Everyday hardcoded keywords into the DB.
-- Safe to re-run: all INSERTs use ON CONFLICT DO NOTHING.
-- ─────────────────────────────────────────────────────────────────

-- ── 1. Confirmed per-client category rules ────────────────────────
CREATE TABLE IF NOT EXISTS client_product_categories (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  category     TEXT NOT NULL,
  keywords     TEXT[] NOT NULL DEFAULT '{}',
  sku_prefixes TEXT[] NOT NULL DEFAULT '{}',
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, category)
);

CREATE INDEX IF NOT EXISTS idx_client_product_categories_client
  ON client_product_categories (client_id);

-- ── 2. Auto-suggested categories awaiting admin review ────────────
CREATE TABLE IF NOT EXISTS client_category_suggestions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  product_name   TEXT NOT NULL,
  sku            TEXT,
  suggested_cat  TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','accepted','dismissed')),
  upload_id      UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, product_name)
);

CREATE INDEX IF NOT EXISTS idx_client_category_suggestions_client_status
  ON client_category_suggestions (client_id, status);

-- RLS: clients can only read their own rows; admins bypass via service role
ALTER TABLE client_product_categories   ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_category_suggestions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "client_categories_isolation"   ON client_product_categories;
DROP POLICY IF EXISTS "client_suggestions_isolation"  ON client_category_suggestions;

-- RLS: client-role users can only see their own client's rows.
-- Admin users (client_id IS NULL in users table) bypass via service role key.
-- Your schema stores the user→client mapping as a client_id column on the
-- users table (not a separate user_clients join table).
CREATE POLICY "client_categories_isolation" ON client_product_categories
  FOR ALL USING (
    client_id IN (
      SELECT client_id FROM users
      WHERE id = auth.uid()
        AND client_id IS NOT NULL
    )
  );

CREATE POLICY "client_suggestions_isolation" ON client_category_suggestions
  FOR ALL USING (
    client_id IN (
      SELECT client_id FROM users
      WHERE id = auth.uid()
        AND client_id IS NOT NULL
    )
  );

-- ── 3. Migrate Neat Everyday hardcoded keywords → DB ─────────────
-- Neat Everyday client_id: b5bdce75-9b69-47ef-a1e7-bc3c09612ef6
-- All keyword/sku_prefix arrays are merged by category so each
-- category gets one row with both its name-match keywords and its
-- SKU-prefix keywords combined.

DO $$
DECLARE
  ne_id UUID := 'b5bdce75-9b69-47ef-a1e7-bc3c09612ef6';
BEGIN

  -- Helper: upsert a category row merging keywords + sku_prefixes
  -- (ON CONFLICT preserves the existing row; safe to re-run)

  INSERT INTO client_product_categories (client_id, category, keywords, sku_prefixes, sort_order) VALUES
    (ne_id, 'Castor & Senna Capsules', ARRAY['castromix','castor & senna','castor and senna'],  ARRAY['cm-b','cm-j','cm-mb'],                        1),
    (ne_id, 'Castor Oil',              ARRAY['castor oil','erand oil','arandi'],                 ARRAY['co-200ml','co-500ml','co-b-','co-pack','fba-co','nt-castor'], 2),
    (ne_id, 'Coconut Oil',             ARRAY['coconut oil'],                                     ARRAY['exvrgncocnt'],                                3),
    (ne_id, 'Mustard Oil',             ARRAY['mustard oil'],                                     ARRAY['ylmustoil'],                                  4),
    (ne_id, 'Almond Oil',              ARRAY['almond oil','badam oil'],                          ARRAY['almndoil'],                                   5),
    (ne_id, 'Black Sesame Oil',        ARRAY['black sesame','til oil'],                          ARRAY['blksesmoil'],                                 6),
    (ne_id, 'Sesame Oil',              ARRAY['sesame oil'],                                      ARRAY[]::TEXT[],                                     7),
    (ne_id, 'Olive Oil',               ARRAY['olive oil'],                                       ARRAY[]::TEXT[],                                     8),
    (ne_id, 'Walnut Oil',              ARRAY['walnut oil','akhrot'],                              ARRAY['wlntoil'],                                    9),
    (ne_id, 'Pistachio Oil',           ARRAY['pistachio oil'],                                   ARRAY['pstachoil'],                                  10),
    (ne_id, 'Wheat Germ Oil',          ARRAY['wheat germ'],                                      ARRAY['whtgemoil','wgo-b'],                          11),
    (ne_id, 'Garlic Oil',              ARRAY['garlic oil'],                                      ARRAY['garlic','go-b'],                              12),
    (ne_id, 'Neem Seed Oil',           ARRAY['neem seed oil','neem oil'],                        ARRAY['neem','nso-b'],                               13),
    (ne_id, 'Kalonji / Black Seed Oil',ARRAY['kalonji','black seed oil','nigella'],              ARRAY['kalnji','klo-b'],                             14),
    (ne_id, 'Fenugreek Oil',           ARRAY['fenugreek','methi'],                               ARRAY['fengrk','fo-b'],                              15),
    (ne_id, 'Flaxseed Oil',            ARRAY['flaxseed','flax seed'],                            ARRAY['flxseed','fso-b'],                            16),
    (ne_id, 'Evening Primrose Oil',    ARRAY['evening primrose','primrose oil'],                  ARRAY['prmrose','pro-b'],                            17),
    (ne_id, 'Omega 3-6-9',             ARRAY['omega 3-6-9','omega-3-6-9','omega 3 6 9','vegan omega'], ARRAY['omega-369'],                            18),
    (ne_id, 'Aloe Vera Gel',           ARRAY['aloe vera'],                                       ARRAY['aloevera','ag-t'],                            19),
    (ne_id, 'Rose Water',              ARRAY['rose water','gulab jal','pushkar rose'],            ARRAY['prw-'],                                       20),
    (ne_id, 'Immunity Booster',        ARRAY['immunity booster','immunity combo','immunty'],      ARRAY['immunty','imb-b','ib-tg'],                    21),
    (ne_id, 'Brahmi Capsules',         ARRAY['brahmi'],                                          ARRAY[]::TEXT[],                                     22),
    (ne_id, 'Ashwagandha Capsules',    ARRAY['ashwagandha'],                                     ARRAY[]::TEXT[],                                     23),
    (ne_id, 'Triphala Capsules',       ARRAY['triphala'],                                        ARRAY[]::TEXT[],                                     24),
    (ne_id, 'Turmeric Capsules',       ARRAY['turmeric & a2','turmeric oil'],                    ARRAY[]::TEXT[],                                     25),
    (ne_id, 'Hair Care',               ARRAY['hair & scalp','hairfall rescue','hair growth oil','kesh amrit','anti-dandruff','overnight hair','hair strength'], ARRAY[]::TEXT[], 26),
    (ne_id, 'Combo / Gift Set',        ARRAY['combo','bliss box','glow aura','poshak shakti','wellness power','skin & detox','hormonal balance','gut health','active life','diy lip'], ARRAY[]::TEXT[], 27)
  ON CONFLICT (client_id, category) DO NOTHING;

END $$;

-- Verify
SELECT category, array_length(keywords,1) as kw_count, array_length(sku_prefixes,1) as sku_count
FROM client_product_categories
WHERE client_id = 'b5bdce75-9b69-47ef-a1e7-bc3c09612ef6'
ORDER BY sort_order;
