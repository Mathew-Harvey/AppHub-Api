const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const pool = require('../config/db');
const { auth, adminOnly, validateId } = require('../middleware/auth');
const { detectFileType, validateHtmlContent } = require('../services/fileDetection');
const { convertToHtml, checkConversionQuota, incrementConversionCount, fixHtmlErrors } = require('../services/aiConvert');
const { validateHtmlErrors } = require('../services/htmlValidator');
const { enforceAppLimit, requirePaidAI } = require('../middleware/subscription');
const { getPlan } = require('../config/plans');
const { DEMO_APPS } = require('../config/demoApps');

const router = express.Router();

const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Upload limit reached, please try again later' }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024 }
});

function formatApp(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    visibility: row.visibility,
    sortOrder: row.sort_order,
    pendingDelete: row.pending_delete || false,
    isDemo: row.is_demo || false,
    demoCategory: row.demo_category || null,
    originalFilename: row.original_filename,
    fileSize: row.file_size,
    uploadedBy: row.uploaded_by_name || null,
    uploadedByEmail: row.uploaded_by_email || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// GET /api/apps/stats
router.get('/stats', auth, async (req, res) => {
  try {
    const counts = await pool.query(
      `SELECT
        COUNT(*) AS total_apps,
        COUNT(*) FILTER (WHERE is_demo = false) AS user_apps,
        COUNT(*) FILTER (WHERE is_demo = true) AS demo_apps,
        COUNT(DISTINCT uploaded_by) AS total_builders,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days' AND is_demo = false) AS new_this_week
       FROM apps
       WHERE workspace_id = $1 AND is_active = true AND pending_delete = false`,
      [req.user.workspaceId]
    );

    const recent = await pool.query(
      `SELECT a.name AS app_name, a.icon AS app_icon, a.created_at,
              u.display_name AS uploaded_by
       FROM apps a
       LEFT JOIN users u ON a.uploaded_by = u.id
       WHERE a.workspace_id = $1 AND a.is_active = true AND a.pending_delete = false
       ORDER BY a.created_at DESC
       LIMIT 10`,
      [req.user.workspaceId]
    );

    const pendingCount = await pool.query(
      'SELECT COUNT(*) AS count FROM apps WHERE workspace_id = $1 AND is_active = true AND pending_delete = true',
      [req.user.workspaceId]
    );

    const row = counts.rows[0];
    res.json({
      totalApps: parseInt(row.total_apps),
      userApps: parseInt(row.user_apps),
      demoApps: parseInt(row.demo_apps),
      totalBuilders: parseInt(row.total_builders),
      newThisWeek: parseInt(row.new_this_week),
      pendingDeletions: parseInt(pendingCount.rows[0].count),
      recentActivity: recent.rows.map(r => ({
        appName: r.app_name,
        appIcon: r.app_icon,
        uploadedBy: r.uploaded_by,
        createdAt: r.created_at
      }))
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// POST /api/apps/check
router.post('/check', auth, (req, res) => {
  const { filename } = req.body;
  if (!filename) {
    return res.status(400).json({ error: 'Filename is required' });
  }
  res.json(detectFileType(filename));
});

// Clean up old conversion jobs every 10 minutes (skip in test)
if (process.env.NODE_ENV !== 'test') setInterval(async () => {
  try {
    await pool.query("DELETE FROM conversion_jobs WHERE created_at < NOW() - INTERVAL '30 minutes'");
  } catch {}
}, 10 * 60 * 1000);

// POST /api/apps/convert — start AI conversion job (pro only, rate limited)
router.post('/convert', auth, requirePaidAI, upload.single('appFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const quota = await checkConversionQuota(pool, req.user.workspaceId);
    if (!quota.allowed) {
      return res.status(429).json({
        error: 'Monthly conversion limit reached',
        used: quota.used,
        limit: quota.limit
      });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'AI conversion is not configured' });
    }

    // Create job in DB, return immediately
    const jobResult = await pool.query(
      'INSERT INTO conversion_jobs (workspace_id, user_id, original_filename) VALUES ($1, $2, $3) RETURNING id',
      [req.user.workspaceId, req.user.id, req.file.originalname]
    );
    const jobId = jobResult.rows[0].id;

    // Run conversion in background
    convertToHtml(req.file.originalname, req.file.buffer)
      .then(async (html) => {
        await pool.query(
          "UPDATE conversion_jobs SET status = 'done', html = $1 WHERE id = $2",
          [html, jobId]
        );
        await incrementConversionCount(pool, req.user.workspaceId);
      })
      .catch(async (err) => {
        console.error('Convert error:', err);
        await pool.query(
          "UPDATE conversion_jobs SET status = 'failed', error = 'AI conversion failed. Please try again or convert manually.' WHERE id = $1",
          [jobId]
        );
      });

    res.json({ jobId });
  } catch (err) {
    console.error('Convert error:', err);
    res.status(500).json({ error: 'Failed to start conversion' });
  }
});

// GET /api/apps/convert/:jobId — poll conversion status
router.get('/convert/:jobId', auth, async (req, res) => {
  try {
    const job = await pool.query(
      'SELECT id, status, html, error, original_filename FROM conversion_jobs WHERE id = $1',
      [req.params.jobId]
    );
    if (job.rows.length === 0) {
      return res.status(404).json({ error: 'Conversion job not found' });
    }

    const row = job.rows[0];
    if (row.status === 'processing') {
      return res.json({ status: 'processing' });
    }
    if (row.status === 'failed') {
      await pool.query('DELETE FROM conversion_jobs WHERE id = $1', [row.id]);
      return res.json({ status: 'failed', error: row.error });
    }

    // Done — return HTML and clean up
    await pool.query('DELETE FROM conversion_jobs WHERE id = $1', [row.id]);
    res.json({ status: 'done', html: row.html, originalFilename: row.original_filename });
  } catch (err) {
    console.error('Poll convert error:', err);
    res.status(500).json({ error: 'Failed to check conversion status' });
  }
});

// PUT /api/apps/reorder
router.put('/reorder', auth, async (req, res) => {
  const { appIds } = req.body;
  if (!Array.isArray(appIds) || appIds.length === 0) {
    return res.status(400).json({ error: 'appIds array is required' });
  }

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < appIds.length; i++) {
        await client.query(
          'UPDATE apps SET sort_order = $1 WHERE id = $2 AND workspace_id = $3',
          [i, appIds[i], req.user.workspaceId]
        );
      }
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Reorder error:', err);
    res.status(500).json({ error: 'Failed to reorder apps' });
  }
});

// GET /api/apps/pending-deletions — admin only
router.get('/pending-deletions', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.*, u.display_name AS uploaded_by_name, u.email AS uploaded_by_email,
              r.display_name AS requested_by_name
       FROM apps a
       LEFT JOIN users u ON a.uploaded_by = u.id
       LEFT JOIN users r ON a.delete_requested_by = r.id
       WHERE a.workspace_id = $1 AND a.is_active = true AND a.pending_delete = true
       ORDER BY a.updated_at DESC`,
      [req.user.workspaceId]
    );
    res.json({
      apps: result.rows.map(row => ({
        ...formatApp(row),
        requestedBy: row.requested_by_name || null
      }))
    });
  } catch (err) {
    console.error('Pending deletions error:', err);
    res.status(500).json({ error: 'Failed to get pending deletions' });
  }
});

// POST /api/apps/:id/approve-deletion — admin only
router.post('/:id/approve-deletion', auth, adminOnly, validateId, async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE apps SET is_active = false, updated_at = NOW() WHERE id = $1 AND workspace_id = $2 AND pending_delete = true RETURNING id',
      [req.params.id, req.user.workspaceId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No pending deletion found' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Approve deletion error:', err);
    res.status(500).json({ error: 'Failed to approve deletion' });
  }
});

// POST /api/apps/:id/reject-deletion — admin only
router.post('/:id/reject-deletion', auth, adminOnly, validateId, async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE apps SET pending_delete = false, delete_requested_by = NULL, updated_at = NOW() WHERE id = $1 AND workspace_id = $2 AND pending_delete = true RETURNING id',
      [req.params.id, req.user.workspaceId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No pending deletion found' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Reject deletion error:', err);
    res.status(500).json({ error: 'Failed to reject deletion' });
  }
});

// POST /api/apps/upload
router.post('/upload', auth, uploadLimiter, enforceAppLimit, upload.single('appFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { name, description, icon, visibility, sharedWith } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'App name is required' });
    }
    if (name.length > 100) {
      return res.status(400).json({ error: 'App name must be 100 characters or less' });
    }
    if (description && description.length > 500) {
      return res.status(400).json({ error: 'Description must be 500 characters or less' });
    }

    const fileCheck = detectFileType(req.file.originalname);
    if (!fileCheck.supported) {
      return res.status(400).json({
        error: 'Unsupported file type',
        detected: fileCheck.detected,
        conversionPrompt: fileCheck.conversionPrompt
      });
    }

    let fileContent = req.file.buffer.toString('utf-8');
    const validation = validateHtmlContent(fileContent, req.file.size);

    // Validate for JS errors (syntax errors, TDZ issues)
    const codeErrors = validateHtmlErrors(fileContent);
    const blockingErrors = codeErrors.filter(e => e.type !== 'tdz_warning');
    let autoFixed = false;
    let fixedErrors = [];

    if (blockingErrors.length > 0) {
      const ws = await pool.query('SELECT plan FROM workspaces WHERE id = $1', [req.user.workspaceId]);
      const planKey = ws.rows[0]?.plan || 'free';
      const planDef = getPlan(planKey);
      const bypassPlan = process.env.DEV_BYPASS_PLAN === 'true';

      if (!planDef.aiConversions && !bypassPlan) {
        return res.status(422).json({
          error: 'code_errors',
          message: 'Your HTML file contains JavaScript errors. Upgrade to Team or higher to have errors automatically fixed by AI during upload.',
          errors: codeErrors,
          upgradeRequired: true
        });
      }

      if (process.env.ANTHROPIC_API_KEY) {
        try {
          fileContent = await fixHtmlErrors(fileContent, codeErrors);
          autoFixed = true;
          fixedErrors = codeErrors;
        } catch (fixErr) {
          console.error('AI auto-fix failed, saving original:', fixErr.message);
        }
      }
    }

    const maxOrder = await pool.query(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM apps WHERE workspace_id = $1 AND is_active = true',
      [req.user.workspaceId]
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        `INSERT INTO apps (workspace_id, uploaded_by, name, description, icon, file_content, original_filename, file_size, sort_order, visibility)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          req.user.workspaceId, req.user.id, name.trim(), description?.trim() || null,
          icon || '📱', fileContent, req.file.originalname, req.file.size,
          maxOrder.rows[0].next_order, visibility || 'team'
        ]
      );

      const app = result.rows[0];

      if (visibility === 'specific' && sharedWith) {
        const userIds = JSON.parse(sharedWith);
        for (const userId of userIds) {
          await client.query(
            'INSERT INTO app_shares (app_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [app.id, userId]
          );
        }
      }

      await client.query('COMMIT');

      const full = await pool.query(
        `SELECT a.*, u.display_name AS uploaded_by_name, u.email AS uploaded_by_email
         FROM apps a LEFT JOIN users u ON a.uploaded_by = u.id WHERE a.id = $1`,
        [app.id]
      );

      res.status(201).json({ app: formatApp(full.rows[0]), validation, autoFixed, fixedErrors });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// GET /api/apps — list visible apps (excludes pending deletions)
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT a.id, a.name, a.description, a.icon, a.visibility,
              a.original_filename, a.file_size, a.sort_order, a.pending_delete,
              a.is_demo, a.demo_category, a.created_at, a.updated_at,
              u.display_name AS uploaded_by_name, u.email AS uploaded_by_email
       FROM apps a
       LEFT JOIN users u ON a.uploaded_by = u.id
       LEFT JOIN app_shares s ON a.id = s.app_id AND s.user_id = $2
       WHERE a.workspace_id = $1
         AND a.is_active = true
         AND a.pending_delete = false
         AND (
           a.visibility = 'team'
           OR (a.visibility = 'private' AND a.uploaded_by = $2)
           OR (a.visibility = 'specific' AND s.user_id IS NOT NULL)
           OR a.uploaded_by = $2
         )
       ORDER BY a.is_demo ASC, a.sort_order ASC, a.created_at DESC`,
      [req.user.workspaceId, req.user.id]
    );
    res.json({ apps: result.rows.map(formatApp) });
  } catch (err) {
    console.error('List apps error:', err);
    res.status(500).json({ error: 'Failed to list apps' });
  }
});

// GET /api/apps/:id
router.get('/:id', auth, validateId, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.*, u.display_name AS uploaded_by_name, u.email AS uploaded_by_email
       FROM apps a LEFT JOIN users u ON a.uploaded_by = u.id
       WHERE a.id = $1 AND a.workspace_id = $2 AND a.is_active = true`,
      [req.params.id, req.user.workspaceId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'App not found' });

    const app = result.rows[0];
    if (app.visibility === 'private' && app.uploaded_by !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (app.visibility === 'specific' && app.uploaded_by !== req.user.id) {
      const shareCheck = await pool.query('SELECT 1 FROM app_shares WHERE app_id = $1 AND user_id = $2', [app.id, req.user.id]);
      if (shareCheck.rows.length === 0) return res.status(403).json({ error: 'Access denied' });
    }

    let sharedWith = [];
    if (app.visibility === 'specific') {
      const shares = await pool.query(
        'SELECT u.id, u.display_name, u.email FROM app_shares s JOIN users u ON s.user_id = u.id WHERE s.app_id = $1',
        [app.id]
      );
      sharedWith = shares.rows;
    }

    res.json({ app: { ...formatApp(app), sharedWith } });
  } catch (err) {
    console.error('Get app error:', err);
    res.status(500).json({ error: 'Failed to get app' });
  }
});

// GET /api/apps/:id/source — download app HTML source
router.get('/:id/source', auth, validateId, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT a.*, u.email AS uploaded_by_email FROM apps a LEFT JOIN users u ON a.uploaded_by = u.id WHERE a.id = $1 AND a.workspace_id = $2 AND a.is_active = true',
      [req.params.id, req.user.workspaceId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'App not found' });
    const app = result.rows[0];
    if (app.uploaded_by !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only the uploader or admin can download source' });
    }
    const filename = app.original_filename || `${app.name.replace(/[^a-zA-Z0-9]/g, '_')}.html`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(app.file_content);
  } catch (err) {
    console.error('Download source error:', err);
    res.status(500).json({ error: 'Failed to download source' });
  }
});

// PUT /api/apps/:id — update metadata
router.put('/:id', auth, validateId, async (req, res) => {
  const { name, description, icon, visibility, sharedWith } = req.body;
  if (name && name.length > 100) {
    return res.status(400).json({ error: 'App name must be 100 characters or less' });
  }
  if (description && description.length > 500) {
    return res.status(400).json({ error: 'Description must be 500 characters or less' });
  }
  try {
    const existing = await pool.query('SELECT * FROM apps WHERE id = $1 AND workspace_id = $2 AND is_active = true', [req.params.id, req.user.workspaceId]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'App not found' });
    if (existing.rows[0].uploaded_by !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only the uploader or admin can edit this app' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE apps SET name = COALESCE($1, name), description = COALESCE($2, description),
         icon = COALESCE($3, icon), visibility = COALESCE($4, visibility), updated_at = NOW() WHERE id = $5`,
        [name?.trim() || null, description?.trim(), icon, visibility, req.params.id]
      );
      if (visibility === 'specific' && sharedWith) {
        await client.query('DELETE FROM app_shares WHERE app_id = $1', [req.params.id]);
        for (const userId of sharedWith) {
          await client.query('INSERT INTO app_shares (app_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, userId]);
        }
      }
      await client.query('COMMIT');
      const updated = await pool.query(
        'SELECT a.*, u.display_name AS uploaded_by_name, u.email AS uploaded_by_email FROM apps a LEFT JOIN users u ON a.uploaded_by = u.id WHERE a.id = $1',
        [req.params.id]
      );
      res.json({ app: formatApp(updated.rows[0]) });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Update app error:', err);
    res.status(500).json({ error: 'Failed to update app' });
  }
});

// PUT /api/apps/:id/file — replace HTML file
router.put('/:id/file', auth, validateId, upload.single('appFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const existing = await pool.query('SELECT * FROM apps WHERE id = $1 AND workspace_id = $2 AND is_active = true', [req.params.id, req.user.workspaceId]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'App not found' });
    if (existing.rows[0].uploaded_by !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only the uploader or admin can update this app' });
    }

    const fileCheck = detectFileType(req.file.originalname);
    if (!fileCheck.supported) {
      return res.status(400).json({ error: 'Unsupported file type', detected: fileCheck.detected, conversionPrompt: fileCheck.conversionPrompt });
    }

    let fileContent = req.file.buffer.toString('utf-8');

    const codeErrors = validateHtmlErrors(fileContent);
    const blockingErrors = codeErrors.filter(e => e.type !== 'tdz_warning');
    let autoFixed = false;
    let fixedErrors = [];

    if (blockingErrors.length > 0) {
      const ws = await pool.query('SELECT plan FROM workspaces WHERE id = $1', [req.user.workspaceId]);
      const planKey = ws.rows[0]?.plan || 'free';
      const planDef = getPlan(planKey);
      const bypassPlan = process.env.DEV_BYPASS_PLAN === 'true';

      if (!planDef.aiConversions && !bypassPlan) {
        return res.status(422).json({
          error: 'code_errors',
          message: 'Your HTML file contains JavaScript errors. Upgrade to Team or higher to have errors automatically fixed by AI during upload.',
          errors: codeErrors,
          upgradeRequired: true
        });
      }

      if (process.env.ANTHROPIC_API_KEY) {
        try {
          fileContent = await fixHtmlErrors(fileContent, codeErrors);
          autoFixed = true;
          fixedErrors = codeErrors;
        } catch (fixErr) {
          console.error('AI auto-fix failed, saving original:', fixErr.message);
        }
      }
    }

    await pool.query(
      'UPDATE apps SET file_content = $1, original_filename = $2, file_size = $3, updated_at = NOW() WHERE id = $4',
      [fileContent, req.file.originalname, req.file.size, req.params.id]
    );

    const full = await pool.query(
      'SELECT a.*, u.display_name AS uploaded_by_name, u.email AS uploaded_by_email FROM apps a LEFT JOIN users u ON a.uploaded_by = u.id WHERE a.id = $1',
      [req.params.id]
    );
    res.json({ app: formatApp(full.rows[0]), autoFixed, fixedErrors });
  } catch (err) {
    console.error('Update file error:', err);
    res.status(500).json({ error: 'Failed to update app file' });
  }
});

// POST /api/apps/dismiss-demos — dismiss all demo apps for this workspace (any user)
router.post('/dismiss-demos', auth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE apps SET is_active = false, updated_at = NOW() WHERE workspace_id = $1 AND is_demo = true AND is_active = true',
      [req.user.workspaceId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Dismiss demos error:', err);
    res.status(500).json({ error: 'Failed to dismiss demo apps' });
  }
});

// POST /api/apps/restore-demos — re-seed demo apps (idempotent)
router.post('/restore-demos', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Reactivate any previously dismissed demos
    await client.query(
      'UPDATE apps SET is_active = true, updated_at = NOW() WHERE workspace_id = $1 AND is_demo = true AND is_active = false',
      [req.user.workspaceId]
    );

    // Seed any demos that don't exist at all yet (new demos added after workspace was created)
    const existing = await client.query(
      'SELECT original_filename FROM apps WHERE workspace_id = $1 AND is_demo = true',
      [req.user.workspaceId]
    );
    const existingFiles = new Set(existing.rows.map(r => r.original_filename));

    const maxOrder = await client.query(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM apps WHERE workspace_id = $1 AND is_active = true',
      [req.user.workspaceId]
    );
    let sortOrder = maxOrder.rows[0].next_order;

    for (const app of DEMO_APPS) {
      if (existingFiles.has(app.original_filename)) continue;
      const content = app.file_content;
      await client.query(
        `INSERT INTO apps (workspace_id, uploaded_by, name, description, icon,
          file_content, original_filename, file_size, sort_order, visibility, is_demo, demo_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'team', true, $10)`,
        [
          req.user.workspaceId, req.user.id, app.name, app.description, app.icon,
          content, app.original_filename, Buffer.byteLength(content, 'utf-8'), sortOrder++,
          app.demoCategory || null
        ]
      );
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Restore demos error:', err);
    res.status(500).json({ error: 'Failed to restore demo apps' });
  } finally {
    client.release();
  }
});

// DELETE /api/apps/:id — admin: immediate. member: pending approval. Demo apps: anyone can dismiss.
router.delete('/:id', auth, validateId, async (req, res) => {
  try {
    const existing = await pool.query(
      'SELECT * FROM apps WHERE id = $1 AND workspace_id = $2 AND is_active = true AND pending_delete = false',
      [req.params.id, req.user.workspaceId]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'App not found' });

    // Demo apps can be dismissed by anyone
    if (existing.rows[0].is_demo) {
      await pool.query('UPDATE apps SET is_active = false, updated_at = NOW() WHERE id = $1', [req.params.id]);
      return res.json({ ok: true, pending: false });
    }

    if (existing.rows[0].uploaded_by !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only the uploader or admin can delete this app' });
    }

    if (req.user.role === 'admin') {
      await pool.query('UPDATE apps SET is_active = false, updated_at = NOW() WHERE id = $1', [req.params.id]);
      res.json({ ok: true, pending: false });
    } else {
      await pool.query(
        'UPDATE apps SET pending_delete = true, delete_requested_by = $1, updated_at = NOW() WHERE id = $2',
        [req.user.id, req.params.id]
      );
      res.json({ ok: true, pending: true });
    }
  } catch (err) {
    console.error('Delete app error:', err);
    res.status(500).json({ error: 'Failed to delete app' });
  }
});

module.exports = router;
