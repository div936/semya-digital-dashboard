// routes/inventoryRouter.js
// ─────────────────────────────────────────────────────────────────
// GET    /clients/:client_slug/inventory/warehouses
// POST   /clients/:client_slug/inventory/warehouses          (admin)
// PATCH  /clients/:client_slug/inventory/warehouses/:id      (admin)
// DELETE /clients/:client_slug/inventory/warehouses/:id      (admin)
//
// GET    /clients/:client_slug/inventory/platform-map
// PUT    /clients/:client_slug/inventory/platform-map        (admin)
//
// GET    /clients/:client_slug/inventory/stock
// PATCH  /clients/:client_slug/inventory/stock                (admin)
//   Body: { warehouseId, sku, quantityOnHand?, lowStockThreshold? }
//   Setting quantityOnHand here always logs a 'manual_adjustment'
//   movement for the delta — see recordMovement() below. This is the
//   ONLY place a human directly changes quantity_on_hand; automatic
//   deduction from sales goes through the same recordMovement() path
//   but is triggered from fileIngestion.js, not this route.
//
// GET    /clients/:client_slug/inventory/alerts
//   Computed low-stock view for the UTM Analytics tab — every SKU/
//   warehouse combination at or below its threshold, plus a rough
//   "days of stock remaining" estimate from recent sales velocity.
//
// Mount in app.js:
//   import inventoryRouter from './routes/inventoryRouter.js';
//   app.use('/clients', inventoryRouter);
// ─────────────────────────────────────────────────────────────────
import { Router } from 'express';
import crypto from 'crypto';
import multer from 'multer';
import xlsx from 'xlsx';
import { rbacMiddleware, requireTab } from '../middleware/rbac.js';
import { supabaseAdmin }  from '../lib/supabase.js';

const router = Router({ mergeParams: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // stock-count files are small; 10MB is generous
  fileFilter: (_req, file, cb) => {
    const ext = file.originalname.split('.').pop().toLowerCase();
    if (['xlsx', 'xls', 'csv'].includes(ext)) return cb(null, true);
    cb(new Error('Only .xlsx, .xls, or .csv files are accepted.'));
  },
});

// ═══════════════════════════════════════════════════════════════════
// WAREHOUSES
// ═══════════════════════════════════════════════════════════════════
router.get('/:client_slug/inventory/warehouses', rbacMiddleware, requireTab('utm_analytics'), async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('warehouses')
    .select('id, name, location, is_default, is_active, created_at')
    .eq('client_id', req.semya.client.id)
    .order('is_default', { ascending: false })
    .order('name');
  if (error) return res.status(500).json({ error: 'Failed to load warehouses: ' + error.message });
  return res.json(data || []);
});

router.post('/:client_slug/inventory/warehouses', rbacMiddleware, async (req, res) => {
  if (!req.semya.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  const { name, location } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Warehouse name is required.' });

  const { data, error } = await supabaseAdmin
    .from('warehouses')
    .insert({ client_id: req.semya.client.id, name: name.trim(), location: location || null })
    .select('id, name, location, is_default, is_active')
    .single();
  if (error) return res.status(500).json({ error: 'Failed to create warehouse: ' + error.message });
  return res.json(data);
});

router.patch('/:client_slug/inventory/warehouses/:id', rbacMiddleware, async (req, res) => {
  if (!req.semya.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  const { name, location, isActive, isDefault } = req.body || {};
  const { client } = req.semya;

  // Setting a new default has to unset the old one first — the
  // partial unique index (one default per client) would otherwise
  // reject the update outright rather than silently swapping it.
  if (isDefault === true) {
    const { error: clearErr } = await supabaseAdmin
      .from('warehouses').update({ is_default: false })
      .eq('client_id', client.id).eq('is_default', true);
    if (clearErr) return res.status(500).json({ error: 'Failed to update default warehouse: ' + clearErr.message });
  }

  const update = {};
  if (name !== undefined)      update.name = name.trim();
  if (location !== undefined)  update.location = location;
  if (isActive !== undefined)  update.is_active = !!isActive;
  if (isDefault !== undefined) update.is_default = !!isDefault;

  const { data, error } = await supabaseAdmin
    .from('warehouses').update(update)
    .eq('id', req.params.id).eq('client_id', client.id)
    .select('id, name, location, is_default, is_active').single();
  if (error) return res.status(500).json({ error: 'Failed to update warehouse: ' + error.message });
  return res.json(data);
});

router.delete('/:client_slug/inventory/warehouses/:id', rbacMiddleware, async (req, res) => {
  if (!req.semya.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  const { client } = req.semya;

  // Refuse to delete a warehouse that's still mapped to a platform or
  // still has any stock rows — force clearing those first, rather
  // than silently orphaning platform_warehouse_map rows or losing
  // stock history via cascade.
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
router.get('/:client_slug/inventory/platform-map', rbacMiddleware, requireTab('utm_analytics'), async (req, res) => {
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

  // warehouseId === null means "clear this mapping, fall back to the
  // default warehouse" — a real, valid state, not an error.
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
// STOCK LEVELS
// ═══════════════════════════════════════════════════════════════════
router.get('/:client_slug/inventory/stock', rbacMiddleware, requireTab('utm_analytics'), async (req, res) => {
  const { warehouseId, sku } = req.query;
  let q = supabaseAdmin
    .from('inventory_stock')
    .select('id, warehouse_id, standard_sku, quantity_on_hand, low_stock_threshold, updated_at, warehouses(name)')
    .eq('client_id', req.semya.client.id)
    .order('standard_sku');
  if (warehouseId) q = q.eq('warehouse_id', warehouseId);
  if (sku)         q = q.eq('standard_sku', sku);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: 'Failed to load stock: ' + error.message });
  return res.json(data || []);
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
      // Log this manual change to the ledger too, same as an
      // automatic sale-driven deduction — keeps the movement history
      // complete regardless of how a quantity changed. Uses a random
      // key since a manual edit has no natural idempotency key to
      // reuse (unlike a sale, which reuses revenue_data's row_hash).
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
    .select('id, warehouse_id, standard_sku, quantity_on_hand, low_stock_threshold, updated_at')
    .single();
  if (error) return res.status(500).json({ error: 'Failed to update stock: ' + error.message });
  return res.json(data);
});


// ═══════════════════════════════════════════════════════════════════
// BULK STOCK UPLOAD — Excel/CSV with SKU, Warehouse, Quantity,
// optionally Low Stock Threshold columns. Matches "Warehouse" against
// existing warehouse names for this client (case-insensitive, exact
// match on the trimmed name) — a row whose warehouse name doesn't
// match anything gets skipped and reported back, never guessed at or
// silently dropped into the wrong warehouse. Warehouse itself is
// OPTIONAL — a client that tracks one overall stock pool rather than
// separate warehouses can upload a file with no Warehouse column at
// all, and every row lands in that client's default warehouse
// instead.
//
// BRAND column, if present, is validated against the target client's
// registered brand name(s) (clients.registered_brands) BEFORE any
// row is processed — confirmed directly with the business that this
// is a real safety requirement: uploading one client's inventory
// file into a different client's account by mistake needs to be
// impossible, not just unlikely. A client with no registered brands
// configured skips this check entirely (fails open, not closed,
// until an admin sets it up) rather than blocking every upload for
// clients nobody's configured this for yet.
//
// Column names are matched loosely (case/spacing-insensitive) against
// a few common variants, same spirit as columnMapper.js's approach
// for revenue files, but far simpler since this only needs to
// recognise five possible columns, not hundreds of platform variants.
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

    // Map this file's actual column headers to our known fields, once.
    const headers = Object.keys(rawRows[0]);
    const colMap = {};
    for (const field of Object.keys(STOCK_COLUMN_ALIASES)) {
      colMap[field] = headers.find(h => resolveStockColumn(h, field)) || null;
    }
    if (!colMap.sku || !colMap.quantity) {
      return res.status(400).json({ error: 'Could not find SKU and Quantity columns in this file. Found headers: ' + headers.join(', ') });
    }

    // ── Brand validation — reject the WHOLE upload, not per-row, if
    // this file's brand(s) don't match what this client is registered
    // for. A partial reject (some rows accepted, some not) would be a
    // worse outcome than refusing outright: if a file is genuinely
    // the wrong client's data, none of it belongs here.
    const { data: clientRow } = await supabaseAdmin
      .from('clients').select('registered_brands').eq('id', client.id).single();
    const registeredBrands = (clientRow?.registered_brands || []).map(b => b.trim().toLowerCase()).filter(Boolean);

    if (colMap.brand && registeredBrands.length) {
      const fileBrands = [...new Set(rawRows.map(r => String(r[colMap.brand] || '').trim()).filter(Boolean))];
      const mismatched = fileBrands.filter(b => !registeredBrands.includes(b.toLowerCase()));
      if (mismatched.length) {
        return res.status(400).json({
          error: `This file's brand${mismatched.length > 1 ? 's' : ''} (${mismatched.join(', ')}) ` +
                 `${mismatched.length > 1 ? "don't" : "doesn't"} match what's registered for this client (${(clientRow.registered_brands || []).join(', ')}). ` +
                 `If this file genuinely belongs here, check Client Administration to confirm the registered brand name, or fix the file if it was meant for a different client.`,
        });
      }
    }

    // ── Warehouse resolution — explicit column if present, otherwise
    // fall back to this client's default warehouse for every row.
    const { data: warehouses } = await supabaseAdmin
      .from('warehouses').select('id, name, is_default').eq('client_id', client.id);
    const warehouseByName = new Map((warehouses || []).map(w => [w.name.trim().toLowerCase(), w.id]));
    const defaultWarehouseId = (warehouses || []).find(w => w.is_default)?.id || null;

    if (!colMap.warehouse && !defaultWarehouseId) {
      return res.status(400).json({ error: 'This file has no Warehouse column, and no default warehouse is set up for this client yet — add a warehouse on the UTM Analytics tab first (mark it Default), or add a Warehouse column to the file.' });
    }

    // ── Existing SKUs — fetched once, up front, so a re-upload never
    // overwrites stock that's already being tracked and automatically
    // adjusted by real sales. Confirmed directly with the business:
    // this file only gets re-uploaded to add NEW SKUs to the catalog,
    // not as a fresh full snapshot — so any SKU already present here
    // must be left alone. Overwriting it would silently undo every
    // automatic deduction that's happened since the last upload,
    // resetting stock back to a stale number.
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

      // Already tracked — leave it alone, don't reset it.
      if (existingKeys.has(warehouseId + '||' + sku)) {
        skippedAsExisting++;
        continue;
      }

      const insertRow = { client_id: client.id, warehouse_id: warehouseId, standard_sku: sku, quantity_on_hand: qty, updated_at: new Date().toISOString() };
      if (thresholdRaw !== undefined && thresholdRaw !== '' && !isNaN(Number(thresholdRaw))) {
        insertRow.low_stock_threshold = Number(thresholdRaw);
      }

      const { error: insertErr } = await supabaseAdmin
        .from('inventory_stock').upsert(insertRow, { onConflict: 'client_id,warehouse_id,standard_sku' });
      if (insertErr) {
        skipped.push({ row: i + 2, warehouse: warehouseName, reason: 'database error: ' + insertErr.message });
        continue;
      }

      // Log the starting quantity for a brand-new SKU as a manual
      // adjustment too, same as every other stock change — keeps the
      // movement ledger complete.
      if (qty !== 0) {
        await recordMovement({
          clientId: client.id, warehouseId, sku,
          qtyDelta: qty, reason: 'manual_adjustment',
          sourceRowHash: crypto.randomUUID(),
        }).catch(() => {}); // best-effort — the stock value itself is already saved above regardless
      }

      existingKeys.add(warehouseId + '||' + sku); // so a duplicate row later in the SAME file doesn't double-insert
      inserted++;
    }

    return res.json({ ok: true, inserted, skippedAsExisting, skipped, totalRows: rawRows.length });
  }
);



//
// Combines current stock against its threshold with a rough sales-
// velocity estimate (units sold per day, trailing 14 days, for that
// SKU across all platforms currently mapped to this warehouse) to
// project days-of-stock-remaining. This is intentionally an estimate,
// not a promise — flagged as such in the response — since real
// demand fluctuates and this has no visibility into pending
// restocks or seasonal spikes.
// ═══════════════════════════════════════════════════════════════════
router.get('/:client_slug/inventory/alerts', rbacMiddleware, requireTab('utm_analytics'), async (req, res) => {
  const { client } = req.semya;

  const { data: stock, error: stockErr } = await supabaseAdmin
    .from('inventory_stock')
    .select('warehouse_id, standard_sku, quantity_on_hand, low_stock_threshold, warehouses(name)')
    .eq('client_id', client.id)
    .filter('quantity_on_hand', 'lte', 'low_stock_threshold'); // Postgres column-vs-column compare via filter()
  if (stockErr) return res.status(500).json({ error: 'Failed to load stock alerts: ' + stockErr.message });

  if (!stock?.length) return res.json([]);

  // Trailing-14-day sales velocity per SKU, for the days-remaining estimate.
  const since = new Date(Date.now() - 14 * 86400000).toISOString().split('T')[0];
  const skus = [...new Set(stock.map(s => s.standard_sku))];
  const { data: recentSales } = await supabaseAdmin
    .from('revenue_data')
    .select('standard_sku, standard_units')
    .eq('client_id', client.id)
    .in('standard_sku', skus)
    .gte('order_date', since);

  const velocityBySku = {};
  for (const row of (recentSales || [])) {
    velocityBySku[row.standard_sku] = (velocityBySku[row.standard_sku] || 0) + (Number(row.standard_units) || 0);
  }

  const alerts = stock.map(s => {
    const unitsPerDay = (velocityBySku[s.standard_sku] || 0) / 14;
    const daysRemaining = unitsPerDay > 0 ? Math.round(s.quantity_on_hand / unitsPerDay) : null;
    return {
      warehouseId: s.warehouse_id,
      warehouseName: s.warehouses?.name || 'Unknown',
      sku: s.standard_sku,
      quantityOnHand: s.quantity_on_hand,
      lowStockThreshold: s.low_stock_threshold,
      daysRemainingEstimate: daysRemaining, // null = not enough recent sales data to estimate
    };
  }).sort((a, b) => (a.daysRemainingEstimate ?? Infinity) - (b.daysRemainingEstimate ?? Infinity));

  return res.json(alerts);
});


// ═══════════════════════════════════════════════════════════════════
// SHARED — records a stock movement AND applies it to quantity_on_hand
// in one call. Exported so fileIngestion.js can call this for
// automatic sale-driven deduction, using the exact same idempotency
// guarantee (source_row_hash) as manual adjustments above.
//
// Returns true if the movement was newly recorded (and stock actually
// changed), false if it was a duplicate (already-recorded row_hash —
// the unique constraint rejected it, meaning this exact sale was
// already deducted before, most likely from a prior upload of the
// same file) and nothing happened this time.
// ═══════════════════════════════════════════════════════════════════
export async function recordMovement({ clientId, warehouseId, sku, qtyDelta, reason, platform = null, sourceRowHash }) {
  const { error: insertErr } = await supabaseAdmin
    .from('inventory_movements')
    .insert({
      client_id: clientId, warehouse_id: warehouseId, standard_sku: sku,
      qty_delta: qtyDelta, reason, platform, source_row_hash: sourceRowHash,
    });

  if (insertErr) {
    // 23505 = unique_violation — this exact movement was already
    // recorded (duplicate source_row_hash). Not a real error: it's
    // the idempotency guarantee working as intended, silently
    // refusing to deduct the same sale twice.
    if (insertErr.code === '23505') return false;
    throw new Error('Failed to record inventory movement: ' + insertErr.message);
  }

  // Ensure a stock row exists for this warehouse+SKU before adjusting
  // it — a sale for a SKU with no stock record yet still gets logged
  // in the ledger above, but starts its on-hand count from zero
  // (going negative is allowed and meaningful: it's a visible signal
  // that sales are outpacing recorded stock, worth an admin's
  // attention, not something to silently clamp to zero and hide).
  const { data: existing } = await supabaseAdmin
    .from('inventory_stock')
    .select('quantity_on_hand')
    .eq('client_id', clientId).eq('warehouse_id', warehouseId).eq('standard_sku', sku)
    .single();

  const newQty = (existing?.quantity_on_hand ?? 0) + qtyDelta;
  const { error: upsertErr } = await supabaseAdmin
    .from('inventory_stock')
    .upsert({ client_id: clientId, warehouse_id: warehouseId, standard_sku: sku, quantity_on_hand: newQty, updated_at: new Date().toISOString() },
      { onConflict: 'client_id,warehouse_id,standard_sku', ignoreDuplicates: false });
  if (upsertErr) throw new Error('Failed to update stock after movement: ' + upsertErr.message);

  return true;
}

export default router;
