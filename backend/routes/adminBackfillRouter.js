// routes/adminBackfillRouter.js
// ─────────────────────────────────────────────────────────────────
// Admin-only, one-time maintenance endpoints — currently just the
// standard_order_id backfill. Exists specifically because Render's
// free tier has no Shell access (Starter plan or above only), so the
// CLI script in scripts/backfillOrderIds.js can't be run directly on
// a free-tier deploy. This route runs the exact same logic over HTTP.
//
// Safe to call more than once — see backfillOrderIds.js for why.
//
// Mount in app.js:
//   import adminBackfillRouter from './routes/adminBackfillRouter.js';
//   app.use('/clients', adminBackfillRouter);
// ─────────────────────────────────────────────────────────────────
import { Router } from 'express';
import { rbacMiddleware } from '../middleware/rbac.js';
import { backfillOrderIds } from '../scripts/backfillOrderIds.js';

const router = Router({ mergeParams: true });

router.post(
  '/:client_slug/admin/backfill-order-ids',
  rbacMiddleware,
  async (req, res) => {
    if (!req.semya.isAdmin) {
      return res.status(403).json({ error: 'Admin access required.' });
    }

    // This can take a while for a large table (paginated, 1000 rows at
    // a time) — collect log lines to return in the response rather than
    // streaming, since a simple curl/browser request won't easily
    // handle a long-lived stream. For a very large table this request
    // may take a couple of minutes; that's expected, not a hang.
    const logLines = [];
    const log = (line) => logLines.push(line);

    try {
      const summary = await backfillOrderIds({ log });
      return res.json({
        ok: true,
        summary,
        log: logLines,
        message: `Backfill complete. ${summary.totalUpdated} of ${summary.totalScanned} scanned rows were updated with a recovered order ID.`,
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: err.message,
        log: logLines,
      });
    }
  }
);

export default router;
