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

// ─── Multer — memory storage, 60MB cap ───────────────────────────
// Raised from 20MB after a 24.5MB Shopify-style export (Meta_File.csv,
// ~176k rows) was rejected. 60MB gives headroom for continued growth;
// see note in fileIngestion.js about large-file ingestion time.
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 60 * 1024 * 1024 },
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
  (req, res, next) => {
    // Wrap multer so size/type errors get a specific, human-readable message
    // instead of the generic "File too large".
    upload.single('file')(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large — the maximum upload size is 60MB. Please split the file or contact support to raise this limit.' });
      }
      return res.status(400).json({ error: err.message || 'Upload failed.' });
    });
  },
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file received. Send as multipart/form-data with field "file".' });
    }

    const { client, user } = req.semya;

    // For large files (>5000 rows), respond immediately and process in
    // the background — avoids Render's 30s gateway timeout on free tier.
    // The upload record is created first (status='processing'), then
    // updated to 'success' or 'error' once ingestion completes.
    // The frontend polls /uploads/:id to get the final status.
    const fileBuffer   = req.file.buffer;
    const originalName = req.file.originalname;
    const clientId     = client.id;
    const uploadedBy   = user.id;

    // Quick row estimate from file size to decide sync vs async
    const fileSizeKb = fileBuffer.length / 1024;
    const useAsync   = fileSizeKb > 500; // files > 500KB go async

    if (!useAsync) {
      // Small file — process synchronously as before
      try {
        const result = await ingestFile({ fileBuffer, originalName, clientId, uploadedBy });
        return res.json({
          ok: true, async: false,
          uploadId: result.uploadId, platform: result.platform,
          dataType: result.dataType, rowsIngested: result.rowCount,
          rowsSkipped: result.skippedRows,
          usedFallbackMapping: result.usedFallbackMapping || false,
          message: result.usedFallbackMapping
            ? `⚠ ${result.rowCount} rows ingested using auto-detected column mapping. Please spot-check data for '${result.platform}'.`
            : `${result.rowCount} rows ingested for platform '${result.platform}'.`,
        });
      } catch (err) {
        console.error('[upload] Ingestion failed:', err.message);
        return res.status(422).json({ error: err.message });
      }
    }

    // Large file — respond immediately, process in background
    // First create a placeholder upload record so we have an ID to return
    const { data: placeholder } = await (await import('../lib/supabase.js')).supabaseAdmin
      .from('uploads')
      .insert({
        client_id: clientId, uploaded_by: uploadedBy,
        original_name: originalName, status: 'processing',
        detected_platform: null, detected_data_type: null,
      })
      .select('id').single();

    const uploadId = placeholder?.id;

    // Return immediately — frontend will poll for completion
    res.json({
      ok: true, async: true, uploadId,
      message: 'Large file detected — processing in background. Check upload history for status.',
    });

    // Process in background (after response is sent)
    setImmediate(async () => {
      try {
        await ingestFile({ fileBuffer, originalName, clientId, uploadedBy, existingUploadId: uploadId });
        console.log(`[upload] Background ingestion complete for ${originalName}`);
      } catch (err) {
        console.error(`[upload] Background ingestion failed for ${originalName}:`, err.message);
        // Update the upload record to error state
        const { supabaseAdmin } = await import('../lib/supabase.js');
        await supabaseAdmin.from('uploads')
          .update({ status: 'error', error_message: err.message })
          .eq('id', uploadId);
      }
    });
  }
);

export default router;
