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
    // this file's brand doesn't match this client.
    //
    // Brand name = client name (e.g. "Daluci" file → Daluci client).
    // Valid brands for a client are built from two sources, in priority:
    //   1. clients.registered_brands — explicit overrides set in admin
    //   2. clients.name — the client's own name, always valid as a brand
    // This means brand→client mapping is automatic with zero config:
    // uploading a "Daluci" branded file into the Neat Everyday client
    // is rejected outright because "Daluci" ≠ "Neat Everyday".
    const { data: clientRow } = await supabaseAdmin
      .from('clients').select('name, registered_brands').eq('id', client.id).single();
    // Build the allowed brand list: explicit overrides + client name itself
    const explicitBrands = (clientRow?.registered_brands || []).map(b => b.trim().toLowerCase()).filter(Boolean);
    const clientNameBrand = (clientRow?.name || '').trim().toLowerCase();
    const registeredBrands = explicitBrands.length
      ? explicitBrands
      : clientNameBrand ? [clientNameBrand] : [];

    if (colMap.brand && registeredBrands.length) {
      const fileBrands = [...new Set(rawRows.map(r => String(r[colMap.brand] || '').trim()).filter(Boolean))];
      const mismatched = fileBrands.filter(b => !registeredBrands.includes(b.toLowerCase()));
      if (mismatched.length) {
        // Check if this brand belongs to a different client — give a
        // helpful error pointing to the right client if so.
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
          error: `This file's brand (${mismatched.join(', ')}) doesn't match this client ("${clientRow.name}").${suggestion} ` +
                 `Please upload this file under the correct client account.`,
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
      return res.status(400).json({ error: 'This file has no Warehouse column and no default warehouse is configured. Add a Warehouse column to your file with the warehouse name (e.g. the state/location name), then add that warehouse under UTM Analytics first.' });
    }

    // ── Existing SKUs — two cases:
    //
    // 1. SKU is positive (or zero) and already tracked → leave it alone.
    //    Re-uploading a stock file must never overwrite a quantity that's
    //    been correctly maintained by automatic sale deductions.
    //
    // 2. SKU is NEGATIVE → it was auto-created by a sale deduction before
    //    any stock was ever seeded. The negative value is how many units
    //    were sold before we knew the starting count. When the admin now
    //    uploads the real starting quantity, the correct final number is:
    //      uploaded_qty + current_negative  (e.g. 100 + (-5) = 95)
    //    We do this by recording a manual_adjustment movement for the
    //    uploaded quantity — recordMovement adds it on top of whatever
    //    is already there, so the negative is automatically resolved.
    const { data: existingStock } = await supabaseAdmin
      .from('inventory_stock').select('warehouse_id, standard_sku, quantity_on_hand').eq('client_id', client.id);
    // Map of "warehouseId||sku" → current quantity_on_hand
    const existingMap = new Map((existingStock || []).map(r => [r.warehouse_id + '||' + r.standard_sku, r.quantity_on_hand]));

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

      const existingQty = existingMap.has(warehouseId + '||' + sku)
        ? existingMap.get(warehouseId + '||' + sku)
        : undefined;

      if (existingQty !== undefined && existingQty >= 0) {
        // Case 1: SKU already has a real (non-negative) stock count —
        // leave it alone. Overwriting would undo all sale deductions
        // that have happened since the last stock upload.
        skippedAsExisting++;
        continue;
      }

      if (existingQty !== undefined && existingQty < 0) {
        // Case 2: SKU went negative from sale deductions before stock
        // was ever seeded. Apply the uploaded qty as a manual_adjustment
        // movement on top of the negative — recordMovement adds the
        // delta to whatever is already there, so the result is correct:
        //   e.g. current = -5, uploaded = 100 → final = 95
        if (thresholdRaw !== undefined && thresholdRaw !== '' && !isNaN(Number(thresholdRaw))) {
          await supabaseAdmin.from('inventory_stock')
            .update({ low_stock_threshold: Number(thresholdRaw), updated_at: new Date().toISOString() })
            .eq('client_id', client.id).eq('warehouse_id', warehouseId).eq('standard_sku', sku);
        }
        await recordMovement({
          clientId: client.id, warehouseId, sku,
          qtyDelta: qty, reason: 'manual_adjustment',
          sourceRowHash: crypto.randomUUID(),
        }).catch(() => {});
        existingMap.set(warehouseId + '||' + sku, existingQty + qty);
        inserted++;
        continue;
      }

      // Case 3: Brand-new SKU — insert it fresh.
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

      // Log the starting quantity in the movement ledger too.
      if (qty !== 0) {
        await recordMovement({
          clientId: client.id, warehouseId, sku,
          qtyDelta: qty, reason: 'manual_adjustment',
          sourceRowHash: crypto.randomUUID(),
        }).catch(() => {});
      }

      existingMap.set(warehouseId + '||' + sku, qty); // guard against duplicates in the same file
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

  // Column-vs-column comparison (quantity_on_hand <= low_stock_threshold)
  // cannot use Supabase's .filter() — the third arg is treated as a
  // literal string, not a column name, causing a Postgres type cast
  // error and a 500. Fetch all stock rows and filter in JS instead;
  // the inventory_stock table per client is small (hundreds of rows).
  const { data: allStock, error: stockErr } = await supabaseAdmin
    .from('inventory_stock')
    .select('warehouse_id, standard_sku, quantity_on_hand, low_stock_threshold, warehouses(name)')
    .eq('client_id', client.id);
  const stock = (allStock || []).filter(s => s.quantity_on_hand <= s.low_stock_threshold);
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
