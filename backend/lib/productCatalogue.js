// lib/productCatalogue.js
// ─────────────────────────────────────────────────────────────────
// PRODUCT CATALOGUE — automatic upsert after every file ingestion
// or Shopify API sync.
//
// Builds a deduplicated product list per client from revenue_data rows.
// Each unique (client_id, sku) pair gets one row in the `products` table.
// Products are attributed to the platform that first reported them,
// and their display_name is updated whenever a better (non-null) name
// is seen in a newer file.
//
// Campaign files don't contribute product names (they have campaign_name
// but no SKU or product title). Only revenue rows are used.
//
// Called as fire-and-forget after every successful ingestion — a failure
// here is logged but never fails the upload itself.
// ─────────────────────────────────────────────────────────────────
import { supabaseAdmin } from './supabase.js';

const CHUNK_SIZE = 500;

// ─────────────────────────────────────────────────────────────────
// upsertProductCatalogue
//
// rows: normalised revenue_data rows (must already have client_id,
//       platform, standard_sku, standard_product_name)
// clientId: UUID of the owning client
// ─────────────────────────────────────────────────────────────────
export async function upsertProductCatalogue(rows, clientId) {
  // Only revenue rows with a real SKU contribute to the catalogue
  const skuRows = rows.filter(r => r.standard_sku && String(r.standard_sku).trim());
  if (!skuRows.length) return { upserted: 0 };

  // Deduplicate within this batch: keep the best name per SKU
  const bySkuMap = new Map();
  for (const row of skuRows) {
    const sku  = String(row.standard_sku).trim();
    const name = row.standard_product_name ? String(row.standard_product_name).trim() : null;
    const plat = row.platform || 'unknown';
    const date = row.order_date || null;

    if (!bySkuMap.has(sku)) {
      bySkuMap.set(sku, { sku, name, platform: plat, first_seen: date, last_seen: date });
    } else {
      const existing = bySkuMap.get(sku);
      // Prefer a non-null name
      if (!existing.name && name) existing.name = name;
      // Track date range
      if (date) {
        if (!existing.first_seen || date < existing.first_seen) existing.first_seen = date;
        if (!existing.last_seen  || date > existing.last_seen)  existing.last_seen  = date;
      }
    }
  }

  // Build upsert payload
  const catalogueRows = [...bySkuMap.values()].map(p => ({
    client_id:    clientId,
    sku:          p.sku,
    display_name: p.name,
    platform:     p.platform,
    first_seen:   p.first_seen,
    last_seen:    p.last_seen,
  }));

  // Chunk and upsert — conflict on (client_id, sku)
  // On conflict: update display_name only if new value is not null,
  // always update last_seen to the latest date seen.
  let upserted = 0;
  for (let i = 0; i < catalogueRows.length; i += CHUNK_SIZE) {
    const chunk = catalogueRows.slice(i, i + CHUNK_SIZE);
    const { error } = await supabaseAdmin
      .from('products')
      .upsert(chunk, {
        onConflict: 'client_id,sku',
        // ignoreDuplicates: false so we DO update last_seen on re-upload
      });
    if (error) {
      // If products table doesn't exist yet (migration not run), warn but don't fail
      if (error.message.includes('does not exist') || error.code === '42P01') {
        console.warn('[products] products table not found — run db/products_migration.sql first');
        return { upserted: 0 };
      }
      throw new Error('[products] upsert failed: ' + error.message);
    }
    upserted += chunk.length;
  }

  console.log(`[products] upserted ${upserted} product(s) for client ${clientId}`);
  return { upserted };
}
