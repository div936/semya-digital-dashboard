// app.js
// ─────────────────────────────────────────────────────────────────
// Semya Digital — Express entry point
// ─────────────────────────────────────────────────────────────────
import 'dotenv/config';
import express        from 'express';
import cookieParser   from 'cookie-parser';
import cors           from 'cors';

import authRouter     from './routes/authRouter.js';
import targetsRouter  from './routes/targetsRouter.js';
import inventoryRouter from './routes/inventoryRouter.js';
import reconciliationRouter from './routes/reconciliationRouter.js';
import insightsRouter from './routes/insightsRouter.js';
import clientRouter   from './routes/clientRouter.js';
import uploadRouter      from './routes/uploadRouter.js';
import adminBackfillRouter from './routes/adminBackfillRouter.js';
import dataManagerRouter from './routes/dataManagerRouter.js';
import utmRouter         from './routes/utmRouter.js';
import projectionsRouter from './routes/projectionsRouter.js';
import platformSettingsRouter from './routes/platformSettingsRouter.js';
import shopifySyncRouter      from './routes/shopifySyncRouter.js';
import shopifyAuthRouter      from './routes/shopifyAuthRouter.js';
import aiSettingsRouter       from './routes/aiSettingsRouter.js';
import { startScheduler }     from './services/syncScheduler.js';

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Crash guards ───────────────────────────────────────────────
// A single bad request (e.g. an oversized/malformed upload) should
// never be able to take the entire server down for every other
// client. Log and keep running rather than letting the process die.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});

// ─── Middleware ───────────────────────────────────────────────────
app.use(cors({
  origin:      process.env.ALLOWED_ORIGINS?.split(',') ?? '*',
  credentials: true,
}));
// Default Express JSON limit is 100kb — too small for a base64-encoded
// logo image (base64 inflates file size by ~33%, so even a modest
// 75-100KB image file becomes 100KB+ as a data URL and gets silently
// rejected by Express itself before it ever reaches a route handler,
// showing up as "Failed to save" with no useful detail on the
// frontend). 5mb comfortably covers any reasonable logo upload while
// staying well short of anything that would meaningfully stress this
// low-traffic internal admin tool.
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

// ─── Routes ───────────────────────────────────────────────────────
//   GET   /platform-settings                  — public: admin/login-page branding
//   PATCH /platform-settings                  — admin only
//   POST /auth/login
//   POST /auth/logout
//   GET  /auth/me
//   /clients/:client_slug/dashboard-config    (GET)
//   /clients/:client_slug/platform-sales      (GET)
//   /clients/:client_slug/sku-performance     (GET)
//   /clients/:client_slug/campaign-insights   (GET)
//   /clients/:client_slug/geographic          (GET)
//   /clients/:client_slug/ai-insights         (GET)
//   /clients/:client_slug/admin/tab-permissions (PATCH) — admin only
//   /clients/:client_slug/upload              (POST)  — admin only
//   /clients/:client_slug/uploads             (GET)   — admin only: list upload history
//   /clients/:client_slug/uploads/:id         (DELETE)— admin only: delete one upload batch
//   /clients/:client_slug/data/range          (DELETE)— admin only: clear by date range
//   /clients/:client_slug/data/platform       (DELETE)— admin only: clear by platform
//   /clients/:client_slug/data/summary        (GET)   — admin only: row counts per platform
//   /clients/:client_slug/targets             (GET)
//   /clients/:client_slug/targets             (PUT)   — admin only
//   /clients/:client_slug/ai-insights          (GET)
//   /clients/:client_slug/ai-insights/generate (POST)  — admin only
app.use('/', platformSettingsRouter);
app.use('/auth',    authRouter);
// utmRouter is mounted BEFORE clientRouter: it has two intentionally
// public, unauthenticated endpoints (click/conversion tracking pings
// from anonymous storefront visitors) that must be matched before
// clientRouter's router.use('/:client_slug', rbacMiddleware) — which
// matches by path PREFIX, not exact route — has a chance to intercept
// and 401 them first.
app.use('/clients', utmRouter);
app.use('/clients', clientRouter);
app.use('/clients', uploadRouter);
app.use('/clients', adminBackfillRouter);
app.use('/clients', dataManagerRouter);
app.use('/clients', targetsRouter);
app.use('/clients', inventoryRouter);
app.use('/clients', reconciliationRouter);
app.use('/clients', insightsRouter);
app.use('/clients', aiSettingsRouter);
app.use('/clients', projectionsRouter);

app.use('/shopify', shopifySyncRouter);
app.use('/shopify', shopifyAuthRouter);

// ─── Start Shopify auto-sync (runs every 6 hours, also on boot) ───
startScheduler();

// ─── Health check ─────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, version: 'V40-ai-settings' }));

// ─── 404 ──────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Route not found.' }));

// ─── Global error handler ─────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[express]', err);
  res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`Semya Digital API running on :${PORT}`);
});

export default app;
