// routes/inventoryRouter.js
// ─────────────────────────────────────────────────────────────────
// GET    /clients/:client_slug/inventory/warehouses
// POST   /clients/:client_slug/inventory/warehouses
// PATCH  /clients/:client_slug/inventory/warehouses/:id
// DELETE /clients/:client_slug/inventory/warehouses/:id
//
// GET    /clients/:client_slug/inventory/platform-map
// PUT    /clients/:client_slug/inventory/platform-map
//
// GET    /clients/:client_slug/inventory/stock
//   Now returns daysRemainingEstimate, reorderByDate, and
//   leadTimeDays for every SKU row, not just alert-threshold ones.
//   Velocity is computed per-warehouse using the warehouse's city
//   field matched against standard_city in revenue_data (trailing
//   14 days). A warehouse with no city set returns null velocity
//   so the UI can show a "city not configured" warning.
//
// PATCH  /clients/:client_slug/inventory/stock
// POST   /clients/:client_slug/inventory/stock/bulk-upload
// PATCH  /clients/:client_slug/inventory/stock/lead-time   (new)
//   Body: { warehouseId, sku, leadTimeDays }
//
// GET    /clients/:client_slug/inventory/alerts
//   Simplified — now just filters the enriched /stock result.
// ─────────────────────────────────────────────────────────────────
import { Router } from 'express';
import crypto from 'crypto';
import multer from 'multer';
import xlsx from 'xlsx';
import { rbacMiddleware, requireTab } from '../middleware/rbac.js';
import { supabaseAdmin } from '../lib/supabase.js';

const router = Router({ mergeParams: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = file.originalname.split('.').pop().toLowerCase();
    if (['xlsx', 'xls', 'csv'].includes(ext)) return cb(null, true);
    cb(new Error('Only .xlsx, .xls, or .csv files are accepted.'));
  },
});

// ═══════════════════════════════════════════════════════════════════
// VELOCITY HELPER
// Computes trailing-14-day units sold per day for a set of SKUs,
// grouped by city. Each warehouse's city field is used as the
// lookup key against standard_city in revenue_data.
//
// Returns a Map keyed by "warehouseId||sku" → { unitsPerDay, city }
// A warehouse with no city set maps to null (no velocity available).
// ═══════════════════════════════════════════════════════════════════
async function computeVelocity(clientId, warehouses, skus) {
  const velocityMap = new Map(); // key: "warehouseId||sku" → unitsPerDay

  // Warehouses without a city get null velocity immediately
  const citiedWarehouses = warehouses.filter(w => w.city && w.city.trim());
  if (!citiedWarehouses.length || !skus.length) return velocityMap;

  const since = new Date(Date.now() - 14 * 86400000).toISOString().split('T')[0];
  const cities = [...new Set(citiedWarehouses.map(w => w.city.trim()))];
  const skuSet = new Set(skus); // for fast membership check

  // Fetch all revenue rows for these cities in the last 14 days.
  // Deliberately NOT filtering by SKU here — passing 400+ SKUs in
  // a Supabase .in() filter blows the URL length limit (PostgREST
  // encodes each value into the query string). Fetching by city only
  // is safe because the city index keeps it fast, and we filter to
  // the SKUs we care about in-memory below.
  const { data: salesRows, error } = await supabaseAdmin
    .from('revenue_data')
    .select('standard_city, standard_sku, standard_units, standard_status')
    .eq('client_id', clientId)
    .in('standard_city', cities)
    .gte('order_date', since)
    .neq('standard_status', 'Cancelled')
    .neq('standard_status', 'Returned');

  if (error) {
    console.error('[computeVelocity] revenue_data query failed:', error.message);
    return velocityMap; // return empty map — callers treat missing keys as null velocity
  }

  // Aggregate units sold per city+sku (only SKUs we actually care about)
  const citySkuUnits = new Map(); // "city||sku" → totalUnits
  for (const row of (salesRows || [])) {
    const city = (row.standard_city || '').trim();
    const sku  = row.standard_sku;
    if (!city || !sku || !skuSet.has(sku)) continue;
    const key = city + '||' + sku;
    citySkuUnits.set(key, (citySkuUnits.get(key) || 0) + (Number(row.standard_units) || 0));
  }

  // Map back to warehouseId||sku
  for (const w of citiedWarehouses) {
    const city = w.city.trim();
    for (const sku of skus) {
      const units = citySkuUnits.get(city + '||' + sku) || 0;
      velocityMap.set(w.id + '||' + sku, units / 14); // units per day
    }
  }

  return velocityMap;
}

// Compute reorder-by date: today + daysRemaining - leadTimeDays
function reorderByDate(daysRemaining, leadTimeDays) {
  if (daysRemaining == null || leadTimeDays == null) return null;
  const daysUntilReorder = daysRemaining - leadTimeDays;
  if (daysUntilReorder <= 0) return 'today'; // already past reorder point
  const d = new Date();
  d.setDate(d.getDate() + daysUntilReorder);
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

// ═══════════════════════════════════════════════════════════════════
// WAREHOUSES
// ═══════════════════════════════════════════════════════════════════
router.get('/:client_slug/inventory/warehouses', rbacMiddleware, requireTab('inventory'), async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('warehouses')
    .select('id, name, location, city, is_default, is_active, created_at')
    .eq('client_id', req.semya.client.id)
    .order('is_default', { ascending: false })
    .order('name');
  if (error) return res.status(500).json({ error: 'Failed to load warehouses: ' + error.message });
  return res.json(data || []);
});

router.post('/:client_slug/inventory/warehouses', rbacMiddleware, async (req, res) => {
  if (!req.semya.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  const { name, location, city } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Warehouse name is required.' });

  const { data, error } = await supabaseAdmin
    .from('warehouses')
    .insert({
      client_id: req.semya.client.id,
      name: name.trim(),
      location: location || null,
      city: city ? city.trim() : null,
    })
    .select('id, name, location, city, is_default, is_active')
    .single();
  if (error) return res.status(500).json({ error: 'Failed to create warehouse: ' + error.message });
  return res.json(data);
});

router.patch('/:client_slug/inventory/warehouses/:id', rbacMiddleware, async (req, res) => {
  if (!req.semya.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  const { name, location, city, isActive, isDefault } = req.body || {};
  const { client } = req.semya;

  if (isDefault === true) {
    const { error: clearErr } = await supabaseAdmin
      .from('warehouses').update({ is_default: false })
      .eq('client_id', client.id).eq('is_default', true);
    if (clearErr) return res.status(500).json({ error: 'Failed to update default warehouse: ' + clearErr.message });
  }

  const update = {};
  if (name !== undefined)      update.name = name.trim();
  if (location !== undefined)  update.location = location;
  if (city !== undefined)      update.city = city ? city.trim() : null;
  if (isActive !== undefined)  update.is_active = !!isActive;
  if (isDefault !== undefined) update.is_default = !!isDefault;

  const { data, error } = await supabaseAdmin
    .from('warehouses').update(update)
    .eq('id', req.params.id).eq('client_id', client.id)
    .select('id, name, location, city, is_default, is_active').single();
  if (error) return res.status(500).json({ error: 'Failed to update warehouse: ' + error.message });
  return res.json(data);
});

router.delete('/:client_slug/inventory/warehouses/:id', rbacMiddleware, async (req, res) => {
  if (!req.semya.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  const { client } = req.semya;

  const [{ count: mapCount }, { count: stockCount }] = await Promise.all([
    supabaseAdmin.from('platform_warehouse_map').select('id', { count: 'exact', head: true }).eq('warehouse_id', req.params.id),
    supabaseAdmin.from('inventory_stock').select('id', { count: 'exact', head: true }).eq('warehouse_id', req.params.id),
  ]);
  if ((mapCount || 0) > 0) return res.status(400).json({ error: 'This warehouse is still mapped to one or more platforms — remove those mappings first.' });
  if ((stockCount || 0) > 0) return res.status(400).json({ error: 'This warehouse still has stock records — clear its stock first.' });

  const { error } = await supabaseAdmin.from('warehouses').delete().eq('id', req.params.id).eq('client_id', client.id);
  if (error) return res.status(500).json({ error: 'Failed to delete warehouse: ' + error.message });
  return res.json({ ok: true });
});


// ═══════════════════════════════════════════════════════════════════
// PLATFORM → WAREHOUSE MAPPING
// ═══════════════════════════════════════════════════════════════════
router.get('/:client_slug/inventory/platform-map', rbacMiddleware, requireTab('inventory'), async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('platform_warehouse_map')
    .select('platform, warehouse_id, warehouses(name)')
    .eq('client_id', req.semya.client.id);
  if (error) return res.status(500).json({ error: 'Failed to load platform mapping: ' + error.message });
  return res.json(data || []);
});

router.put('/:client_slug/inventory/platform-map', rbacMiddleware, async (req, res) => {
  if (!req.semya.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  const { platform, warehouseId } = req.body || {};
  if (!platform) return res.status(400).json({ error: 'platform is required.' });
  const { client } = req.semya;

  if (warehouseId === null) {
    const { error } = await supabaseAdmin.from('platform_warehouse_map')
      .delete().eq('client_id', client.id).eq('platform', platform);
    if (error) return res.status(500).json({ error: 'Failed to clear mapping: ' + error.message });
    return res.json({ ok: true, platform, warehouseId: null });
  }

  const { error } = await supabaseAdmin.from('platform_warehouse_map')
    .upsert({ client_id: client.id, platform, warehouse_id: warehouseId }, { onConflict: 'client_id,platform' });
  if (error) return res.status(500).json({ error: 'Failed to save mapping: ' + error.message });
  return res.json({ ok: true, platform, warehouseId });
});


// ═══════════════════════════════════════════════════════════════════
// STOCK LEVELS — enriched with per-city velocity + Days in Hand
//
// Returns every SKU row with:
//   daysRemainingEstimate  — null if warehouse has no city or no
//                            recent sales history for this SKU
//   reorderByDate          — YYYY-MM-DD or 'today' or null
//   leadTimeDays           — from inventory_stock.lead_time_days
//   warehouseCity          — from warehouses.city (for display)
//   cityConfigured         — false if warehouse has no city set
//                            (UI shows yellow warning)
// ═══════════════════════════════════════════════════════════════════
router.get('/:client_slug/inventory/stock', rbacMiddleware, requireTab('inventory'), async (req, res) => {
  const { warehouseId, sku } = req.query;
  const { client } = req.semya;

  let q = supabaseAdmin
    .from('inventory_stock')
    .select('id, warehouse_id, standard_sku, quantity_on_hand, low_stock_threshold, lead_time_days, updated_at, warehouses(id, name, city)')
    .eq('client_id', client.id)
    .order('standard_sku');
  if (warehouseId) q = q.eq('warehouse_id', warehouseId);
  if (sku)         q = q.eq('standard_sku', sku);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: 'Failed to load stock: ' + error.message });
  if (!data?.length) return res.json([]);

  // Fetch all warehouses for this client so velocity covers all of them
  const { data: allWarehouses } = await supabaseAdmin
    .from('warehouses')
    .select('id, name, city')
    .eq('client_id', client.id);

  const skus = [...new Set(data.map(r => r.standard_sku))];
  const velocityMap = await computeVelocity(client.id, allWarehouses || [], skus);

  const today = new Date().toISOString().split('T')[0];

  const enriched = data.map(row => {
    const wh = row.warehouses || {};
    const cityConfigured = !!(wh.city && wh.city.trim());
    const velKey = row.warehouse_id + '||' + row.standard_sku;
    const unitsPerDay = velocityMap.has(velKey) ? velocityMap.get(velKey) : null;

    let daysRemainingEstimate = null;
    let reorderBy = null;

    if (cityConfigured && unitsPerDay != null) {
      if (unitsPerDay > 0) {
        daysRemainingEstimate = Math.round(row.quantity_on_hand / unitsPerDay);
        reorderBy = reorderByDate(daysRemainingEstimate, row.lead_time_days || 0);
      } else {
        // City is set, no sales in last 14 days — stock exists but no
        // demand signal. Show null days (—) rather than "infinity".
        daysRemainingEstimate = null;
        reorderBy = null;
      }
    }

    return {
      id:                    row.id,
      warehouseId:           row.warehouse_id,
      warehouseName:         wh.name || '—',
      warehouseCity:         wh.city || null,
      cityConfigured,
      sku:                   row.standard_sku,
      quantityOnHand:        row.quantity_on_hand,
      lowStockThreshold:     row.low_stock_threshold,
      leadTimeDays:          row.lead_time_days || 0,
      daysRemainingEstimate,
      reorderByDate:         reorderBy,
      updatedAt:             row.updated_at,
    };
  });

  return res.json(enriched);
});

router.patch('/:client_slug/inventory/stock', rbacMiddleware, async (req, res) => {
  if (!req.semya.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  const { warehouseId, sku, quantityOnHand, lowStockThreshold } = req.body || {};
  if (!warehouseId || !sku) return res.status(400).json({ error: 'warehouseId and sku are required.' });
  const { client } = req.semya;

  const { data: existing } = await supabaseAdmin
    .from('inventory_stock')
    .select('quantity_on_hand')
    .eq('client_id', client.id).eq('warehouse_id', warehouseId).eq('standard_sku', sku)
    .single();

  const update = { client_id: client.id, warehouse_id: warehouseId, standard_sku: sku, updated_at: new Date().toISOString() };
  if (lowStockThreshold !== undefined) update.low_stock_threshold = Number(lowStockThreshold) || 0;

  if (quantityOnHand !== undefined) {
    update.quantity_on_hand = Number(quantityOnHand) || 0;
    const previousQty = existing?.quantity_on_hand ?? 0;
    const delta = update.quantity_on_hand - previousQty;
    if (delta !== 0) {
      await recordMovement({
        clientId: client.id, warehouseId, sku,
        qtyDelta: delta, reason: 'manual_adjustment',
        sourceRowHash: crypto.randomUUID(),
      });
    }
  }

  const { data, error } = await supabaseAdmin
    .from('inventory_stock')
    .upsert(update, { onConflict: 'client_id,warehouse_id,standard_sku' })
    .select('id, warehouse_id, standard_sku, quantity_on_hand, low_stock_threshold, lead_time_days, updated_at')
    .single();
  if (error) return res.status(500).json({ error: 'Failed to update stock: ' + error.message });
  return res.json(data);
});

// ── Lead time per SKU per warehouse — separate PATCH so the inline
// table input can save without touching quantity or threshold.
router.patch('/:client_slug/inventory/stock/lead-time', rbacMiddleware, async (req, res) => {
  if (!req.semya.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  const { warehouseId, sku, leadTimeDays } = req.body || {};
  if (!warehouseId || !sku) return res.status(400).json({ error: 'warehouseId and sku are required.' });
  if (leadTimeDays === undefined || isNaN(Number(leadTimeDays))) {
    return res.status(400).json({ error: 'leadTimeDays must be a number.' });
  }
  const { client } = req.semya;

  const { error } = await supabaseAdmin
    .from('inventory_stock')
    .update({ lead_time_days: Math.max(0, Number(leadTimeDays)), updated_at: new Date().toISOString() })
    .eq('client_id', client.id).eq('warehouse_id', warehouseId).eq('standard_sku', sku);
  if (error) return res.status(500).json({ error: 'Failed to save lead time: ' + error.message });
  return res.json({ ok: true });
});


// ═══════════════════════════════════════════════════════════════════
// BULK STOCK UPLOAD
// ═══════════════════════════════════════════════════════════════════
const STOCK_COLUMN_ALIASES = {
  sku:       ['sku', 'product sku', 'item sku'],
  warehouse: ['warehouse', 'warehouse name'],
  quantity:  ['quantity', 'qty', 'qty on hand', 'quantity on hand', 'stock', 'on hand'],
  threshold: ['low stock threshold', 'alert below', 'threshold', 'reorder level', 'reorder point'],
  brand:     ['brand', 'brand name'],
};

function resolveStockColumn(header, field) {
  const normalised = header.trim().toLowerCase();
  return STOCK_COLUMN_ALIASES[field].includes(normalised);
}

router.post(
  '/:client_slug/inventory/stock/bulk-upload',
  rbacMiddleware,
  (req, res, next) => {
    if (!req.semya.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
    return next();
  },
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      return next();
    });
  },
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file received.' });
    const { client } = req.semya;

    let rawRows;
    try {
      const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      rawRows = xlsx.utils.sheet_to_json(sheet, { defval: '' });
    } catch (e) {
      return res.status(400).json({ error: 'Could not read this file — is it a valid .xlsx or .csv? (' + e.message + ')' });
    }
    if (!rawRows.length) return res.status(400).json({ error: 'File has no data rows.' });

    const headers = Object.keys(rawRows[0]);
    const colMap = {};
    for (const field of Object.keys(STOCK_COLUMN_ALIASES)) {
      colMap[field] = headers.find(h => resolveStockColumn(h, field)) || null;
    }
    if (!colMap.sku || !colMap.quantity) {
      return res.status(400).json({ error: 'Could not find SKU and Quantity columns in this file. Found headers: ' + headers.join(', ') });
    }

    // Brand validation
    const { data: clientRow } = await supabaseAdmin
      .from('clients').select('name, registered_brands').eq('id', client.id).single();
    const explicitBrands = (clientRow?.registered_brands || []).map(b => b.trim().toLowerCase()).filter(Boolean);
    const clientNameBrand = (clientRow?.name || '').trim().toLowerCase();
    const registeredBrands = explicitBrands.length ? explicitBrands : clientNameBrand ? [clientNameBrand] : [];

    if (colMap.brand && registeredBrands.length) {
      const fileBrands = [...new Set(rawRows.map(r => String(r[colMap.brand] || '').trim()).filter(Boolean))];
      const mismatched = fileBrands.filter(b => !registeredBrands.includes(b.toLowerCase()));
      if (mismatched.length) {
        const { data: brandOwner } = await supabaseAdmin
          .from('clients')
          .select('name, slug')
          .or(
            mismatched.map(b => `name.ilike.${b}`).join(',') +
            (mismatched.length ? ',' : '') +
            `registered_brands.cs.{${mismatched.join(',')}}`
          )
          .neq('id', client.id)
          .limit(1)
          .maybeSingle();
        const suggestion = brandOwner
          ? ` This file looks like it belongs to the "${brandOwner.name}" client instead.`
          : '';
        return res.status(400).json({
          error: `This file's brand (${mismatched.join(', ')}) doesn't match this client ("${clientRow.name}").${suggestion} Please upload this file under the correct client account.`,
        });
      }
    }

    // Warehouse resolution
    const { data: warehouses } = await supabaseAdmin
      .from('warehouses').select('id, name, is_default').eq('client_id', client.id);
    const warehouseByName = new Map((warehouses || []).map(w => [w.name.trim().toLowerCase(), w.id]));
    const defaultWarehouseId = (warehouses || []).find(w => w.is_default)?.id || null;

    if (!colMap.warehouse && !defaultWarehouseId) {
      return res.status(400).json({ error: 'This file has no Warehouse column and no default warehouse is configured.' });
    }

    const { data: existingStock } = await supabaseAdmin
      .from('inventory_stock').select('warehouse_id, standard_sku').eq('client_id', client.id);
    const existingKeys = new Set((existingStock || []).map(r => r.warehouse_id + '||' + r.standard_sku));

    const skipped = [];
    let inserted = 0, skippedAsExisting = 0;

    for (let i = 0; i < rawRows.length; i++) {
      const row = rawRows[i];
      const sku = String(row[colMap.sku] || '').trim();
      const warehouseName = colMap.warehouse ? String(row[colMap.warehouse] || '').trim() : '';
      const qtyRaw = row[colMap.quantity];
      const thresholdRaw = colMap.threshold ? row[colMap.threshold] : undefined;

      if (!sku || qtyRaw === '' || qtyRaw === undefined) {
        skipped.push({ row: i + 2, warehouse: warehouseName || '(default)', reason: 'missing SKU or quantity' });
        continue;
      }
      const warehouseId = warehouseName ? warehouseByName.get(warehouseName.toLowerCase()) : defaultWarehouseId;
      if (!warehouseId) {
        skipped.push({ row: i + 2, warehouse: warehouseName || '(default)', reason: warehouseName ? 'no warehouse with this exact name' : 'no default warehouse configured' });
        continue;
      }
      const qty = Number(qtyRaw);
      if (isNaN(qty)) {
        skipped.push({ row: i + 2, warehouse: warehouseName, reason: 'quantity is not a number' });
        continue;
      }
      if (existingKeys.has(warehouseId + '||' + sku)) {
        skippedAsExisting++;
        continue;
      }

      const insertRow = {
        client_id: client.id,
        warehouse_id: warehouseId,
        standard_sku: sku,
        quantity_on_hand: qty,
        updated_at: new Date().toISOString(),
      };
      if (thresholdRaw !== undefined && thresholdRaw !== '' && !isNaN(Number(thresholdRaw))) {
        insertRow.low_stock_threshold = Number(thresholdRaw);
      }

      const { error: insertErr } = await supabaseAdmin
        .from('inventory_stock').upsert(insertRow, { onConflict: 'client_id,warehouse_id,standard_sku' });
      if (insertErr) {
        skipped.push({ row: i + 2, warehouse: warehouseName, reason: 'database error: ' + insertErr.message });
        continue;
      }

      if (qty !== 0) {
        await recordMovement({
          clientId: client.id, warehouseId, sku,
          qtyDelta: qty, reason: 'manual_adjustment',
          sourceRowHash: crypto.randomUUID(),
        }).catch(() => {});
      }

      existingKeys.add(warehouseId + '||' + sku);
      inserted++;
    }

    return res.json({ ok: true, inserted, skippedAsExisting, skipped, totalRows: rawRows.length });
  }
);


// ═══════════════════════════════════════════════════════════════════
// ALERTS — filters the enriched /stock response, no separate velocity
// calc needed since /stock already computes everything.
// ═══════════════════════════════════════════════════════════════════
router.get('/:client_slug/inventory/alerts', rbacMiddleware, requireTab('inventory'), async (req, res) => {
  const { client } = req.semya;

  // Re-use the same enrichment logic as /stock by fetching directly
  const { data: stockRows, error: stockErr } = await supabaseAdmin
    .from('inventory_stock')
    .select('id, warehouse_id, standard_sku, quantity_on_hand, low_stock_threshold, lead_time_days, updated_at, warehouses(id, name, city)')
    .eq('client_id', client.id);
  if (stockErr) return res.status(500).json({ error: 'Failed to load stock: ' + stockErr.message });
  if (!stockRows?.length) return res.json([]);

  // Only process rows at or below threshold
  const alertRows = stockRows.filter(r => r.quantity_on_hand <= r.low_stock_threshold);
  if (!alertRows.length) return res.json([]);

  const { data: allWarehouses } = await supabaseAdmin
    .from('warehouses').select('id, name, city').eq('client_id', client.id);

  const skus = [...new Set(alertRows.map(r => r.standard_sku))];
  const velocityMap = await computeVelocity(client.id, allWarehouses || [], skus);

  const alerts = alertRows.map(row => {
    const wh = row.warehouses || {};
    const cityConfigured = !!(wh.city && wh.city.trim());
    const velKey = row.warehouse_id + '||' + row.standard_sku;
    const unitsPerDay = velocityMap.has(velKey) ? velocityMap.get(velKey) : null;

    let daysRemainingEstimate = null;
    let reorderBy = null;
    if (cityConfigured && unitsPerDay != null && unitsPerDay > 0) {
      daysRemainingEstimate = Math.round(row.quantity_on_hand / unitsPerDay);
      reorderBy = reorderByDate(daysRemainingEstimate, row.lead_time_days || 0);
    }

    return {
      warehouseId:           row.warehouse_id,
      warehouseName:         wh.name || 'Unknown',
      warehouseCity:         wh.city || null,
      cityConfigured,
      sku:                   row.standard_sku,
      quantityOnHand:        row.quantity_on_hand,
      lowStockThreshold:     row.low_stock_threshold,
      leadTimeDays:          row.lead_time_days || 0,
      daysRemainingEstimate,
      reorderByDate:         reorderBy,
    };
  }).sort((a, b) => (a.daysRemainingEstimate ?? Infinity) - (b.daysRemainingEstimate ?? Infinity));

  return res.json(alerts);
});


// ═══════════════════════════════════════════════════════════════════
// SHARED — records a stock movement AND applies it to quantity_on_hand
// ═══════════════════════════════════════════════════════════════════
export async function recordMovement({ clientId, warehouseId, sku, qtyDelta, reason, platform = null, sourceRowHash }) {
  const { error: insertErr } = await supabaseAdmin
    .from('inventory_movements')
    .insert({
      client_id: clientId, warehouse_id: warehouseId, standard_sku: sku,
      qty_delta: qtyDelta, reason, platform, source_row_hash: sourceRowHash,
    });

  if (insertErr) {
    if (insertErr.code === '23505') return false;
    throw new Error('Failed to record inventory movement: ' + insertErr.message);
  }

  const { data: existing } = await supabaseAdmin
    .from('inventory_stock')
    .select('quantity_on_hand')
    .eq('client_id', clientId).eq('warehouse_id', warehouseId).eq('standard_sku', sku)
    .single();

  const newQty = (existing?.quantity_on_hand ?? 0) + qtyDelta;
  const { error: upsertErr } = await supabaseAdmin
    .from('inventory_stock')
    .upsert(
      { client_id: clientId, warehouse_id: warehouseId, standard_sku: sku, quantity_on_hand: newQty, updated_at: new Date().toISOString() },
      { onConflict: 'client_id,warehouse_id,standard_sku', ignoreDuplicates: false }
    );
  if (upsertErr) throw new Error('Failed to update stock after movement: ' + upsertErr.message);

  return true;
}

export default router;
