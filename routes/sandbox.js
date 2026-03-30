const express = require('express');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { validateId } = require('../middleware/auth');

const router = express.Router();

// GET /sandbox/:appId — serve the HTML app inside an iframe
router.get('/:appId', validateId, async (req, res) => {
  try {
    const token = req.cookies?.token;
    if (!token) {
      return res.status(401).send('<html><body><h2>Not authenticated</h2><p>Please log in to view this app.</p></body></html>');
    }

    let user;
    try {
      user = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).send('<html><body><h2>Session expired</h2><p>Please log in again.</p></body></html>');
    }

    const result = await pool.query(
      'SELECT * FROM apps WHERE id = $1 AND workspace_id = $2 AND is_active = true',
      [req.params.appId, user.workspaceId]
    );
    if (result.rows.length === 0) {
      return res.status(404).send('<html><body><h2>App not found</h2></body></html>');
    }

    const app = result.rows[0];

    // Visibility checks
    if (app.visibility === 'private' && app.uploaded_by !== user.id) {
      return res.status(403).send('<html><body><h2>Access denied</h2></body></html>');
    }

    if (app.visibility === 'specific' && app.uploaded_by !== user.id) {
      const shareCheck = await pool.query(
        'SELECT 1 FROM app_shares WHERE app_id = $1 AND user_id = $2',
        [app.id, user.id]
      );
      if (shareCheck.rows.length === 0) {
        return res.status(403).send('<html><body><h2>Access denied</h2></body></html>');
      }
    }

    // Resolve and validate file path
    const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
    const filePath = path.resolve(path.join(uploadDir, app.file_path));
    if (!filePath.startsWith(uploadDir)) {
      return res.status(403).send('<html><body><h2>Access denied</h2></body></html>');
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).send('<html><body><h2>App file not found</h2></body></html>');
    }

    const htmlContent = fs.readFileSync(filePath, 'utf-8');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self' https: data: blob:",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com",
      "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com data:",
      "img-src 'self' https: data: blob:",
      "connect-src 'self' https:",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; '));

    res.send(htmlContent);
  } catch (err) {
    console.error('Sandbox error:', err);
    res.status(500).send('<html><body><h2>Error loading app</h2></body></html>');
  }
});

module.exports = router;
