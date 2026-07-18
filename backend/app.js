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
import insightsRouter from './routes/insightsRouter.js';
import clientRouter   from './routes/clientRouter.js';
import uploadRouter   from './routes/uploadRouter.js';

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────
app.use(cors({
  origin:      process.env.ALLOWED_ORIGINS?.split(',') ?? '*',
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// ─── Routes ───────────────────────────────────────────────────────
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
//   /clients/:client_slug/targets             (GET)
//   /clients/:client_slug/targets             (PUT)   — admin only
//   /clients/:client_slug/ai-insights          (GET)
//   /clients/:client_slug/ai-insights/generate (POST)  — admin only
app.use('/auth',    authRouter);
app.use('/clients', clientRouter);
app.use('/clients', uploadRouter);
app.use('/clients', targetsRouter);
app.use('/clients', insightsRouter);

// ─── Health check ─────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

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
