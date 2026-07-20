// routes/uploadRouter.js
// ─────────────────────────────────────────────────────────────────
// POST /clients/:client_slug/upload
//
// Admin-only route. Receives a multipart file upload, validates it,
// then hands off to the ingestion pipeline.
//
// Mount in app.js:
//   import uploadRouter from './routes/uploadRouter.js';
//   app.use('/clients', uploadRouter);
// ─────────────────────────────────────────────────────────────────
import { Router }  from 'express';
import multer      from 'multer';
import { rbacMiddleware } from '../middleware/rbac.js';
import { ingestFile }     from '../ingestion/fileIngestion.js';

const router = Router({ mergeParams: true });

// ─── Multer — memory storage, 20MB cap ───────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
      'text/csv',
      'application/csv',
      'application/octet-stream',  // some clients send .xlsx as octet-stream
    ];
    const ext = file.originalname.split('.').pop().toLowerCase();
    if (allowed.includes(file.mimetype) || ext === 'xlsx' || ext === 'csv') {
      return cb(null, true);
    }
    cb(new Error('Only .xlsx and .csv files are accepted.'));
  },
});

// ─── POST /clients/:client_slug/upload ───────────────────────────
router.post(
  '/:client_slug/upload',
  rbacMiddleware,               // verifies JWT, resolves client
  (req, res, next) => {
    // Admin-only gate
    if (!req.semya.isAdmin) {
      return res.status(403).json({ error: 'Only admins can upload files.' });
    }
    return next();
  },
  upload.single('file'),        // expects form field named "file"
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file received. Send as multipart/form-data with field "file".' });
    }

    const { client, user } = req.semya;

    try {
      const result = await ingestFile({
        fileBuffer:   req.file.buffer,
        originalName: req.file.originalname,
        clientId:     client.id,
        uploadedBy:   user.id,
      });

      return res.json({
        ok:           true,
        uploadId:     result.uploadId,
        platform:     result.platform,
        dataType:     result.dataType,
        rowsIngested: result.rowCount,
        rowsSkipped:  result.skippedRows,
        message:      `${result.rowCount} rows ingested into ${result.dataType} table for platform '${result.platform}'.`,
      });

    } catch (err) {
      console.error('[upload] Ingestion failed:', err.message);
      return res.status(422).json({ error: err.message });
    }
  }
);

export default router;
