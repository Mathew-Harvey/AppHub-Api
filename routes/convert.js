const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { processUpload } = require('../services/fileProcessor');
const { convert } = require('../services/converter');

const router = express.Router();

const ACCEPTED_EXTENSIONS = /\.(zip|jsx|tsx|vue|svelte|html|htm|css|js|ts|json|md|py)$/i;
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB for zips

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_SIZE, files: 50 },
  fileFilter: (_req, file, cb) => {
    if (ACCEPTED_EXTENSIONS.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.originalname}`));
    }
  },
});

const convertLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skip: () => process.env.NODE_ENV === 'test',
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Rate limit exceeded. Please try again later.' },
});

let pool = null;
try {
  pool = require('../config/db');
} catch {
  // DB not available — logging will be skipped
}

async function logConversion(logData) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO conversion_logs
        (input_files, input_tokens_est, output_tokens_est, tier_used, model_used, cost_estimate_usd, success, validation_errors, processing_time_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        logData.inputFiles,
        logData.inputTokens,
        logData.outputTokens,
        logData.tier,
        logData.model,
        logData.cost,
        logData.success,
        logData.errors ? JSON.stringify(logData.errors) : null,
        logData.processingTimeMs,
      ]
    );
  } catch (err) {
    console.error('Failed to log conversion:', err.message);
  }
}

router.post('/', convertLimiter, (req, res, next) => {
  upload.array('file', 50)(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
    }
    if (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files uploaded' });
    }

    let manifestData;
    try {
      manifestData = processUpload(req.files);
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }

    const { manifest, fileList, tokenEstimate } = manifestData;

    const result = await convert(manifest, fileList);

    // Log the conversion asynchronously
    if (result._log) {
      logConversion({
        inputFiles: fileList.length,
        inputTokens: tokenEstimate,
        outputTokens: result._log.outputTokens,
        tier: result._log.tier,
        model: result._log.model,
        cost: result._log.cost,
        success: result.success,
        errors: result._log.errors,
        processingTimeMs: result.metadata.processing_time_ms,
      }).catch(() => {});
    }

    const { _log, ...response } = result;
    res.json(response);
  } catch (err) {
    console.error('Convert endpoint error:', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error during conversion',
    });
  }
});

module.exports = router;
