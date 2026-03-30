const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const { auth, validateId } = require('../middleware/auth');
const { detectFileType, validateHtmlFile } = require('../services/fileDetection');

const router = express.Router();

const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Upload limit reached, please try again later' }
});

// Multer config — files stored per workspace
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const uploadDir = process.env.UPLOAD_DIR || './uploads';
    const workspaceDir = path.join(uploadDir, req.user.workspaceId);
    fs.mkdirSync(workspaceDir, { recursive: true });
    cb(null, workspaceDir);
  },
  filename(req, file, cb) {
    cb(null, `${uuidv4()}${path.extname(file.originalname)}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024 }
});

function formatApp(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    visibility: row.visibility,
    originalFilename: row.original_filename,
    fileSize: row.file_size,
    uploadedBy: row.uploaded_by_name || null,
    uploadedByEmail: row.uploaded_by_email || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// POST /api/apps/check — validate file type before upload
router.post('/check', auth, (req, res) => {
  const { filename } = req.body;
  if (!filename) {
    return res.status(400).json({ error: 'Filename is required' });
  }
  res.json(detectFileType(filename));
});

// POST /api/apps/upload — upload an HTML app
router.post('/upload', auth, uploadLimiter, upload.single('appFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { name, description, icon, visibility, sharedWith } = req.body;

    if (!name || !name.trim()) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'App name is required' });
    }

    const fileCheck = detectFileType(req.file.originalname);
    if (!fileCheck.supported) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({
        error: 'Unsupported file type',
        detected: fileCheck.detected,
        conversionPrompt: fileCheck.conversionPrompt
      });
    }

    const validation = validateHtmlFile(req.file.path);
    const relativePath = path.relative(process.env.UPLOAD_DIR || './uploads', req.file.path);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        `INSERT INTO apps (workspace_id, uploaded_by, name, description, icon, file_path, original_filename, file_size, visibility)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          req.user.workspaceId,
          req.user.id,
          name.trim(),
          description?.trim() || null,
          icon || '📱',
          relativePath,
          req.file.originalname,
          req.file.size,
          visibility || 'team'
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

      // Fetch with uploader info for consistent response shape
      const full = await pool.query(
        `SELECT a.*, u.display_name AS uploaded_by_name, u.email AS uploaded_by_email
         FROM apps a LEFT JOIN users u ON a.uploaded_by = u.id
         WHERE a.id = $1`,
        [app.id]
      );

      res.status(201).json({ app: formatApp(full.rows[0]), validation });
    } catch (err) {
      await client.query('ROLLBACK');
      // Clean up orphaned file on DB failure
      try { fs.unlinkSync(req.file.path); } catch {}
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// GET /api/apps — list all visible apps for current user
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT a.id, a.name, a.description, a.icon, a.visibility,
              a.original_filename, a.file_size, a.created_at, a.updated_at,
              u.display_name AS uploaded_by_name, u.email AS uploaded_by_email
       FROM apps a
       LEFT JOIN users u ON a.uploaded_by = u.id
       LEFT JOIN app_shares s ON a.id = s.app_id AND s.user_id = $2
       WHERE a.workspace_id = $1
         AND a.is_active = true
         AND (
           a.visibility = 'team'
           OR (a.visibility = 'private' AND a.uploaded_by = $2)
           OR (a.visibility = 'specific' AND s.user_id IS NOT NULL)
           OR a.uploaded_by = $2
         )
       ORDER BY a.created_at DESC`,
      [req.user.workspaceId, req.user.id]
    );

    res.json({ apps: result.rows.map(formatApp) });
  } catch (err) {
    console.error('List apps error:', err);
    res.status(500).json({ error: 'Failed to list apps' });
  }
});

// GET /api/apps/:id — get single app details
router.get('/:id', auth, validateId, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.*, u.display_name AS uploaded_by_name, u.email AS uploaded_by_email
       FROM apps a
       LEFT JOIN users u ON a.uploaded_by = u.id
       WHERE a.id = $1 AND a.workspace_id = $2 AND a.is_active = true`,
      [req.params.id, req.user.workspaceId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'App not found' });
    }

    const app = result.rows[0];

    if (app.visibility === 'private' && app.uploaded_by !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (app.visibility === 'specific' && app.uploaded_by !== req.user.id) {
      const shareCheck = await pool.query(
        'SELECT 1 FROM app_shares WHERE app_id = $1 AND user_id = $2',
        [app.id, req.user.id]
      );
      if (shareCheck.rows.length === 0) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    let sharedWith = [];
    if (app.visibility === 'specific') {
      const shares = await pool.query(
        `SELECT u.id, u.display_name, u.email
         FROM app_shares s JOIN users u ON s.user_id = u.id
         WHERE s.app_id = $1`,
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

// PUT /api/apps/:id — update app metadata
router.put('/:id', auth, validateId, async (req, res) => {
  const { name, description, icon, visibility, sharedWith } = req.body;

  try {
    const existing = await pool.query(
      'SELECT * FROM apps WHERE id = $1 AND workspace_id = $2 AND is_active = true',
      [req.params.id, req.user.workspaceId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'App not found' });
    }
    if (existing.rows[0].uploaded_by !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only the uploader or admin can edit this app' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE apps SET
          name = COALESCE($1, name),
          description = COALESCE($2, description),
          icon = COALESCE($3, icon),
          visibility = COALESCE($4, visibility),
          updated_at = NOW()
         WHERE id = $5`,
        [name?.trim() || null, description?.trim(), icon, visibility, req.params.id]
      );

      if (visibility === 'specific' && sharedWith) {
        await client.query('DELETE FROM app_shares WHERE app_id = $1', [req.params.id]);
        for (const userId of sharedWith) {
          await client.query(
            'INSERT INTO app_shares (app_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [req.params.id, userId]
          );
        }
      }

      await client.query('COMMIT');

      const updated = await pool.query(
        `SELECT a.*, u.display_name AS uploaded_by_name, u.email AS uploaded_by_email
         FROM apps a LEFT JOIN users u ON a.uploaded_by = u.id
         WHERE a.id = $1`,
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

// DELETE /api/apps/:id — soft delete an app
router.delete('/:id', auth, validateId, async (req, res) => {
  try {
    const existing = await pool.query(
      'SELECT * FROM apps WHERE id = $1 AND workspace_id = $2 AND is_active = true',
      [req.params.id, req.user.workspaceId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'App not found' });
    }
    if (existing.rows[0].uploaded_by !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only the uploader or admin can delete this app' });
    }

    await pool.query(
      'UPDATE apps SET is_active = false, updated_at = NOW() WHERE id = $1',
      [req.params.id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('Delete app error:', err);
    res.status(500).json({ error: 'Failed to delete app' });
  }
});

module.exports = router;
