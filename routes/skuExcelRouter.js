// routes/skuExcelRouter.js
// ─────────────────────────────────────────────────────────────────
// POST /clients/:client_slug/projections/from-excel
//
// Accepts an Inventory_SKU.xlsx upload, parses the columns,
// computes revenue / COGS / ad-spend / profit projections,
// and returns a response in the same shape as projectionsRouter
// so the same frontend render functions work.
//
// Column mapping (from Inventory_SKU.xlsx format):
//   SKU                    → sku identifier
//   NAME                   → product display name
//   ASIN                   → Amazon ASIN
//   Proj. Rev Per DAY      → daily revenue (primary source)
//   Current Vol            → daily units sold (fallback for revenue)
//   Deal Price Amazon      → selling price per unit
//   % PRICESettlement      → gross-margin % (after Amazon fees, returns)
//   Profit                 → daily gross profit BEFORE ad spend
//   Ads Current            → daily ad spend (₹)
//   FBA                    → FBA stock units
//   Flex Stock             → warehouse stock units
//   DOH                    → days of inventory on hand
//   Inventory Status       → e.g. "Sufficient Stock", "Low Stock"
//   Target ROAS / TACOS    → ad targets
//   Names                  → team member (optional filter)
// ─────────────────────────────────────────────────────────────────
import { Router } from 'express';
import multer from 'multer';
import XLSX from 'xlsx';

const router = Router({ mergeParams: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (_req, file, cb) => {
    const ext = file.originalname.split('.').pop().toLowerCase();
    if (['xlsx', 'xls'].includes(ext)) return cb(null, true);
    cb(new Error('Only .xlsx / .xls files are accepted.'));
  },
});

// ── Column aliases (handles minor header variations) ──────────────
const col = (row, ...keys) => {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
  }
  return undefined;
};

const num = (v, fallback = 0) => {
  const n = parseFloat(v);
  return isNaN(n) ? fallback : n;
};

// ─────────────────────────────────────────────────────────────────
// POST /clients/:client_slug/projections/from-excel
// ─────────────────────────────────────────────────────────────────
router.post('/:client_slug/projections/from-excel', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    // Parse workbook
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const sheetName = wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });

    if (!rows.length) return res.status(400).json({ error: 'Excel file is empty or unreadable.' });

    // ── Per-SKU metrics (daily basis) ────────────────────────────
    const skuMetrics = [];
    const unpricedSkus = [];

    for (const row of rows) {
      const sku  = col(row, 'SKU');
      const name = col(row, 'NAME', 'Name');
      const asin = col(row, 'ASIN');

      if (!sku) continue; // skip header-continuation or empty rows

      const price        = num(col(row, 'Deal Price Amazon', 'Deal Price'));
      const settlePct    = num(col(row, '% PRICESettlement', '%PRICESettlement', 'Settlement %'));
      const currentVol   = num(col(row, 'Current Vol', 'CurrentVol'));
      const revPerDay    = num(col(row, 'Proj. Rev Per DAY', 'Proj Rev Per DAY', 'Proj.Rev Per DAY'))
                          || (currentVol * price);  // fallback: units × price
      const grossProfitDay = num(col(row, 'Profit'))
                          || (revPerDay * settlePct); // fallback: rev × margin%
      const adSpendDay   = num(col(row, 'Ads Current', 'Ads_Current', 'ADS CURRENT'));
      const netProfitDay = grossProfitDay - adSpendDay;
      const cogsDay      = revPerDay - grossProfitDay;

      // Flag unpriced SKUs (no selling price and no revenue)
      if (!price && revPerDay === 0) {
        unpricedSkus.push({ sku, name: name || sku, asin });
        continue;
      }

      skuMetrics.push({
        sku,
        name:            name   || sku,
        asin:            asin   || '',
        price,
        settlePct,
        currentVol,
        fbaStock:        num(col(row, 'FBA')),
        flexStock:       num(col(row, 'Flex Stock', 'FlexStock', 'Warehouse')),
        doh:             num(col(row, 'DOH')),
        inventoryStatus: col(row, 'Inventory Status', 'InventoryStatus') || 'Unknown',
        targetROAS:      num(col(row, 'Target ROAS', 'ROAS target', 'ROAS Target'), null),
        targetACOS:      num(col(row, 'Target ACOS', 'TACOS target', 'ACOS Target'), null),
        teamMember:      col(row, 'Names', 'Name') || '',
        nextSteps:       col(row, 'NeXt steps', 'Next steps', 'NextSteps') || '',
        // daily financials
        revPerDay,
        cogsDay,
        adSpendDay,
        grossProfitDay,
        netProfitDay,
        // monthly (×30)
        revenue:         revPerDay    * 30,
        cogs:            cogsDay      * 30,
        adSpend:         adSpendDay   * 30,
        grossProfit:     grossProfitDay * 30,
        profit:          netProfitDay  * 30,
      });
    }

    if (!skuMetrics.length) {
      return res.status(400).json({ error: 'No valid SKU rows found. Check column headers match the expected format.' });
    }

    // ── Aggregate totals (monthly) ────────────────────────────────
    const totals = skuMetrics.reduce((acc, s) => {
      acc.revenue    += s.revenue;
      acc.cogs       += s.cogs;
      acc.adSpend    += s.adSpend;
      acc.grossProfit+= s.grossProfit;
      acc.profit     += s.profit;
      return acc;
    }, { revenue: 0, cogs: 0, adSpend: 0, grossProfit: 0, profit: 0, returnLoss: 0 });

    // ── Synthetic monthly series (current run-rate) ───────────────
    const today  = new Date();
    const period = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const series = [{
      period,
      revenue:  totals.revenue,
      cogs:     totals.cogs,
      adSpend:  totals.adSpend,
      profit:   totals.profit,
    }];

    // ── Platform P&L (detect platform from ASIN prefix) ──────────
    const platformMap = {};
    for (const s of skuMetrics) {
      // Amazon ASINs start with B0 or B0G etc.
      const platform = s.asin && /^B0/i.test(s.asin) ? 'Amazon' : 'Other';
      if (!platformMap[platform]) platformMap[platform] = { platform, revenue: 0, cogs: 0, adSpend: 0, profit: 0 };
      platformMap[platform].revenue  += s.revenue;
      platformMap[platform].cogs     += s.cogs;
      platformMap[platform].adSpend  += s.adSpend;
      platformMap[platform].profit   += s.profit;
    }
    const platformPL = Object.values(platformMap);

    // ── Projection summary ────────────────────────────────────────
    const isProfitable   = totals.profit > 0;
    const avgMarginPct   = totals.revenue > 0 ? (totals.grossProfit / totals.revenue) : 0;
    const monthsToBreak  = isProfitable ? 0 : null; // can't compute without historical trend

    const projection = {
      isProfitableNow: isProfitable,
      linear: {
        trending: isProfitable ? 'up' : 'down',
        breakevenPeriodsFromNow: monthsToBreak,
        slope: null,
      },
      growthRate: {
        breakevenPeriodsFromNow: null,
      },
    };

    res.json({
      source: 'excel',           // signals frontend to show "From Excel" badge
      fileName: req.file.originalname,
      rowsParsed: skuMetrics.length,
      totals,
      series,
      projection,
      unpricedSkus,
      platformPL,
      skuDetails: skuMetrics,  // used by SKU break-even tab
    });
  } catch (e) {
    console.error('[projections/from-excel]', e);
    res.status(500).json({ error: 'Failed to parse Excel: ' + e.message });
  }
});

export default router;
