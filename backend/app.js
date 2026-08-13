// app.js
import 'dotenv/config';
import express        from 'express';
import cookieParser   from 'cookie-parser';
import cors           from 'cors';

import authRouter            from './routes/authRouter.js';
import targetsRouter         from './routes/targetsRouter.js';
import inventoryRouter       from './routes/inventoryRouter.js';
import reconciliationRouter  from './routes/reconciliationRouter.js';
import insightsRouter        from './routes/insightsRouter.js';
import clientRouter          from './routes/clientRouter.js';
import uploadRouter          from './routes/uploadRouter.js';
import adminBackfillRouter   from './routes/adminBackfillRouter.js';
import dataManagerRouter     from './routes/dataManagerRouter.js';
import utmRouter             from './routes/utmRouter.js';
import projectionsRouter     from './routes/projectionsRouter.js';
import platformSettingsRouter from './routes/platformSettingsRouter.js';
import shopifySyncRouter     from './routes/shopifySyncRouter.js';
import { startScheduler }    from './services/syncScheduler.js';

const app  = express();
const PORT = process.env.PORT || 3000;

process.on('uncaughtException',  (err) => { console.error('[uncaughtException]',  err); });
process.on('unhandledRejection', (err) => { console.error('[unhandledRejection]', err); });

app.use(cors({
  origin:      process.env.ALLOWED_ORIGINS?.split(',') ?? '*',
  credentials: true,
}));
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

app.use('/',        platformSettingsRouter);
app.use('/auth',    authRouter);
app.use('/clients', utmRouter);
app.use('/clients', clientRouter);
app.use('/clients', uploadRouter);
app.use('/clients', adminBackfillRouter);
app.use('/clients', dataManagerRouter);
app.use('/clients', targetsRouter);
app.use('/clients', inventoryRouter);
app.use('/clients', reconciliationRouter);
app.use('/clients', insightsRouter);
app.use('/clients', projectionsRouter);
app.use('/shopify', shopifySyncRouter);

// Start Shopify auto-sync (runs every 6 hours, also fires once on boot)
startScheduler();

app.get('/health', (_req, res) => res.json({ ok: true, version: 'V39-shopify-sync' }));

app.use((_req, res) => res.status(404).json({ error: 'Route not found.' }));

app.use((err, _req, res, _next) => {
  console.error('[express]', err);
  res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`Semya Digital API running on :${PORT}`);
});

export default app;
