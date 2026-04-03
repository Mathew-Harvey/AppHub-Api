const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { validateId } = require('../middleware/auth');

const router = express.Router();

// GET /sandbox/:appId — serve the HTML app inside an iframe (from DB)
router.get('/:appId', validateId, async (req, res) => {
  try {
    // Accept token from query param (sandbox-specific) or cookie fallback
    const token = req.query.token || req.cookies?.token;
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
      'SELECT id, uploaded_by, visibility, file_content FROM apps WHERE id = $1 AND workspace_id = $2 AND is_active = true',
      [req.params.appId, user.workspaceId]
    );
    if (result.rows.length === 0) {
      return res.status(404).send('<html><body><h2>App not found</h2></body></html>');
    }

    const app = result.rows[0];

    if (!app.file_content) {
      return res.status(404).send('<html><body><h2>App file not available</h2><p>This app was uploaded before database storage was enabled. Please re-upload it.</p></body></html>');
    }

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

    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy',
      `default-src 'self' 'unsafe-inline' 'unsafe-eval' https: data: blob:; ` +
      `connect-src 'self' https: wss: ws: data: blob:; ` +
      `media-src 'self' https: data: blob: mediastream:; ` +
      `frame-ancestors ${clientUrl}`
    );
    res.setHeader('X-Frame-Options', `ALLOW-FROM ${clientUrl}`);
    res.removeHeader('Origin-Agent-Cluster');
    res.setHeader('Permissions-Policy', 'clipboard-write=*, clipboard-read=*');
    res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');

    res.send(app.file_content);
  } catch (err) {
    console.error('Sandbox error:', { appId: req.params.appId, message: err.message, stack: err.stack });
    res.status(500).send('<html><body><h2>Error loading app</h2><p>An internal error occurred. Check server logs for details.</p></body></html>');
  }
});

module.exports = router;
