const express = require('express');
const rateLimit = require('express-rate-limit');
const pool = require('../config/db');
const { auth, validateId } = require('../middleware/auth');
const { requireAppBuilder, checkTokenBudget, enforceAppLimit } = require('../middleware/subscription');
const {
  buildApp,
  reviseApp,
  getTokenUsage,
  assessComplexity
} = require('../services/appBuilder');

const router = express.Router();

const builderLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'Builder rate limit reached. Please try again later.' }
});

const VALID_APP_TYPES = ['game', 'tool', 'dashboard', 'form', 'calculator', 'landing-page', 'other'];
const VALID_COMPLEXITIES = ['simple', 'moderate', 'complex'];
const VALID_COLOR_SCHEMES = ['dark', 'light', 'colorful', 'minimal'];
const VALID_LAYOUTS = ['centered', 'sidebar', 'fullscreen', 'dashboard-grid'];
const VALID_FONTS = ['modern', 'classic', 'playful', 'monospace'];
const MAX_FEATURES = 20;

function validateSessionInput(body) {
  const errors = [];

  if (!body.name || !body.name.trim()) errors.push('App name is required');
  if (body.name && body.name.length > 100) errors.push('App name must be 100 characters or less');
  if (body.description && body.description.length > 2000) errors.push('Description must be 2000 characters or less');
  if (body.appType && !VALID_APP_TYPES.includes(body.appType)) errors.push(`Invalid app type. Must be one of: ${VALID_APP_TYPES.join(', ')}`);
  if (body.complexity && !VALID_COMPLEXITIES.includes(body.complexity)) errors.push(`Invalid complexity. Must be one of: ${VALID_COMPLEXITIES.join(', ')}`);

  if (body.features) {
    if (!Array.isArray(body.features)) errors.push('Features must be an array');
    else if (body.features.length > MAX_FEATURES) errors.push(`Maximum ${MAX_FEATURES} features allowed`);
    else if (body.features.some(f => typeof f !== 'string' || f.length > 300)) errors.push('Each feature must be a string of 300 characters or less');
  }

  if (body.stylePreferences && typeof body.stylePreferences === 'object') {
    const sp = body.stylePreferences;
    if (sp.colorScheme && !VALID_COLOR_SCHEMES.includes(sp.colorScheme)) errors.push('Invalid color scheme');
    if (sp.layoutStyle && !VALID_LAYOUTS.includes(sp.layoutStyle)) errors.push('Invalid layout style');
    if (sp.fontStyle && !VALID_FONTS.includes(sp.fontStyle)) errors.push('Invalid font style');
  }

  if (body.targetAudience && body.targetAudience.length > 255) errors.push('Target audience must be 255 characters or less');
  if (body.additionalNotes && body.additionalNotes.length > 2000) errors.push('Additional notes must be 2000 characters or less');

  return errors;
}

function formatSession(row) {
  return {
    id: row.id,
    appType: row.app_type,
    name: row.name,
    description: row.description,
    features: row.features,
    stylePreferences: row.style_preferences,
    complexity: row.complexity,
    targetAudience: row.target_audience,
    additionalNotes: row.additional_notes,
    status: row.status,
    hasHtml: !!row.current_html,
    revisionCount: row.revision_count,
    totalTokensUsed: row.total_tokens_used,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// Cleanup old builder jobs every 10 minutes
if (process.env.NODE_ENV !== 'test') setInterval(async () => {
  try {
    await pool.query("DELETE FROM builder_jobs WHERE created_at < NOW() - INTERVAL '1 hour'");
  } catch {}
}, 10 * 60 * 1000);

// ─── POST /api/builder/sessions — create a new builder session ───────────────

router.post('/sessions', auth, requireAppBuilder, async (req, res) => {
  try {
    const errors = validateSessionInput(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }

    const {
      appType, name, description, features, stylePreferences,
      complexity, targetAudience, additionalNotes
    } = req.body;

    const result = await pool.query(
      `INSERT INTO builder_sessions
        (workspace_id, user_id, app_type, name, description, features, style_preferences, complexity, target_audience, additional_notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        req.user.workspaceId, req.user.id,
        appType || 'other', name.trim(), description?.trim() || null,
        JSON.stringify(features || []), JSON.stringify(stylePreferences || {}),
        complexity || 'moderate', targetAudience?.trim() || null, additionalNotes?.trim() || null
      ]
    );

    const session = result.rows[0];
    const complexityResult = assessComplexity(session);
    const usage = await getTokenUsage(req.user.workspaceId);

    res.status(201).json({
      session: formatSession(session),
      complexityWarning: complexityResult.warning,
      complexityLevel: complexityResult.level,
      usage
    });
  } catch (err) {
    console.error('Create session error:', err);
    res.status(500).json({ error: 'Failed to create builder session' });
  }
});

// ─── GET /api/builder/sessions — list user's sessions ────────────────────────

router.get('/sessions', auth, requireAppBuilder, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM builder_sessions
       WHERE workspace_id = $1 AND user_id = $2
       ORDER BY updated_at DESC
       LIMIT 50`,
      [req.user.workspaceId, req.user.id]
    );

    res.json({ sessions: result.rows.map(formatSession) });
  } catch (err) {
    console.error('List sessions error:', err);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// ─── GET /api/builder/sessions/:id — get session detail ──────────────────────

router.get('/sessions/:id', auth, validateId, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM builder_sessions WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.user.workspaceId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Session not found' });

    const session = result.rows[0];
    res.json({
      session: {
        ...formatSession(session),
        currentHtml: session.current_html
      }
    });
  } catch (err) {
    console.error('Get session error:', err);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

// ─── POST /api/builder/sessions/:id/generate — start async generation ────────

router.post('/sessions/:id/generate', auth, requireAppBuilder, checkTokenBudget, builderLimiter, validateId, async (req, res) => {
  try {
    const session = await pool.query(
      'SELECT * FROM builder_sessions WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.user.workspaceId]
    );
    if (session.rows.length === 0) return res.status(404).json({ error: 'Session not found' });

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'AI builder is not configured' });
    }

    const sess = session.rows[0];
    if (sess.status === 'generating') {
      return res.status(409).json({ error: 'A generation is already in progress for this session' });
    }

    await pool.query(
      "UPDATE builder_sessions SET status = 'generating', updated_at = NOW() WHERE id = $1",
      [sess.id]
    );

    const jobResult = await pool.query(
      `INSERT INTO builder_jobs (session_id, workspace_id, user_id, job_type)
       VALUES ($1, $2, $3, 'generate') RETURNING id`,
      [sess.id, req.user.workspaceId, req.user.id]
    );
    const jobId = jobResult.rows[0].id;

    // Run generation in background — tokens are tracked incrementally by the service
    buildApp(sess, { jobId, workspaceId: req.user.workspaceId })
      .then(async (result) => {
        await pool.query(
          `UPDATE builder_jobs SET status = 'done', html = $1, review_notes = $2 WHERE id = $3`,
          [result.html, JSON.stringify(result.reviewNotes), jobId]
        );
        await pool.query(
          `UPDATE builder_sessions SET status = 'done', current_html = $1, updated_at = NOW() WHERE id = $2`,
          [result.html, sess.id]
        );
      })
      .catch(async (err) => {
        console.error('Builder generate error:', err);
        await pool.query(
          "UPDATE builder_jobs SET status = 'failed', error = $1 WHERE id = $2",
          [err.message || 'Generation failed', jobId]
        );
        await pool.query(
          "UPDATE builder_sessions SET status = 'draft', updated_at = NOW() WHERE id = $1",
          [sess.id]
        );
      });

    res.json({ jobId });
  } catch (err) {
    console.error('Generate error:', err);
    res.status(500).json({ error: 'Failed to start generation' });
  }
});

// ─── POST /api/builder/sessions/:id/revise — start async revision ────────────

router.post('/sessions/:id/revise', auth, requireAppBuilder, checkTokenBudget, builderLimiter, validateId, async (req, res) => {
  try {
    const { feedback } = req.body;
    if (!feedback || !feedback.trim()) {
      return res.status(400).json({ error: 'Feedback is required' });
    }
    if (feedback.length > 2000) {
      return res.status(400).json({ error: 'Feedback must be 2000 characters or less' });
    }

    const session = await pool.query(
      'SELECT * FROM builder_sessions WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.user.workspaceId]
    );
    if (session.rows.length === 0) return res.status(404).json({ error: 'Session not found' });

    const sess = session.rows[0];
    if (!sess.current_html) {
      return res.status(400).json({ error: 'No app has been generated yet. Generate first before revising.' });
    }
    if (sess.status === 'generating') {
      return res.status(409).json({ error: 'A generation is already in progress' });
    }

    await pool.query(
      "UPDATE builder_sessions SET status = 'generating', updated_at = NOW() WHERE id = $1",
      [sess.id]
    );

    const jobResult = await pool.query(
      `INSERT INTO builder_jobs (session_id, workspace_id, user_id, job_type, user_feedback)
       VALUES ($1, $2, $3, 'revise', $4) RETURNING id`,
      [sess.id, req.user.workspaceId, req.user.id, feedback.trim()]
    );
    const jobId = jobResult.rows[0].id;

    reviseApp(sess.current_html, feedback.trim(), sess, { jobId, workspaceId: req.user.workspaceId })
      .then(async (result) => {
        await pool.query(
          `UPDATE builder_jobs SET status = 'done', html = $1, review_notes = $2 WHERE id = $3`,
          [result.html, JSON.stringify(result.reviewNotes), jobId]
        );
        await pool.query(
          `UPDATE builder_sessions
           SET status = 'done', current_html = $1, revision_count = revision_count + 1, updated_at = NOW()
           WHERE id = $2`,
          [result.html, sess.id]
        );
      })
      .catch(async (err) => {
        console.error('Builder revise error:', err);
        await pool.query(
          "UPDATE builder_jobs SET status = 'failed', error = $1 WHERE id = $2",
          [err.message || 'Revision failed', jobId]
        );
        await pool.query(
          "UPDATE builder_sessions SET status = 'done', updated_at = NOW() WHERE id = $1",
          [sess.id]
        );
      });

    res.json({ jobId });
  } catch (err) {
    console.error('Revise error:', err);
    res.status(500).json({ error: 'Failed to start revision' });
  }
});

// ─── GET /api/builder/sessions/:id/jobs/:jobId — poll job status ─────────────

router.get('/sessions/:id/jobs/:jobId', auth, async (req, res) => {
  try {
    const job = await pool.query(
      'SELECT * FROM builder_jobs WHERE id = $1 AND session_id = $2 AND workspace_id = $3',
      [req.params.jobId, req.params.id, req.user.workspaceId]
    );
    if (job.rows.length === 0) return res.status(404).json({ error: 'Job not found' });

    const row = job.rows[0];

    if (row.status === 'processing' || row.status === 'reviewing') {
      return res.json({ status: row.status });
    }

    if (row.status === 'failed') {
      return res.json({ status: 'failed', error: row.error });
    }

    // Done — return result
    res.json({
      status: 'done',
      html: row.html,
      reviewNotes: row.review_notes,
      jobType: row.job_type,
      tokensUsed: {
        input: row.input_tokens,
        output: row.output_tokens,
        cacheRead: row.cache_read_tokens,
        cacheCreation: row.cache_creation_tokens
      }
    });
  } catch (err) {
    console.error('Poll job error:', err);
    res.status(500).json({ error: 'Failed to check job status' });
  }
});

// ─── POST /api/builder/sessions/:id/publish — save to apps table ─────────────

router.post('/sessions/:id/publish', auth, requireAppBuilder, enforceAppLimit, validateId, async (req, res) => {
  try {
    const session = await pool.query(
      'SELECT * FROM builder_sessions WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.user.workspaceId]
    );
    if (session.rows.length === 0) return res.status(404).json({ error: 'Session not found' });

    const sess = session.rows[0];
    if (!sess.current_html) {
      return res.status(400).json({ error: 'No app has been generated yet' });
    }

    const { name, description, icon, visibility, sharedWith } = req.body;
    const appName = (name || sess.name || 'Untitled App').trim();

    if (appName.length > 100) {
      return res.status(400).json({ error: 'App name must be 100 characters or less' });
    }
    if (description && description.length > 500) {
      return res.status(400).json({ error: 'Description must be 500 characters or less' });
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
          req.user.workspaceId, req.user.id,
          appName, description?.trim() || sess.description || null,
          icon || '🤖', sess.current_html, `${appName.replace(/[^a-zA-Z0-9]/g, '_')}.html`,
          Buffer.byteLength(sess.current_html, 'utf-8'),
          maxOrder.rows[0].next_order, visibility || 'team'
        ]
      );

      const app = result.rows[0];

      if (visibility === 'specific' && sharedWith) {
        const userIds = Array.isArray(sharedWith) ? sharedWith : JSON.parse(sharedWith);
        for (const userId of userIds) {
          await client.query(
            'INSERT INTO app_shares (app_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [app.id, userId]
          );
        }
      }

      await client.query(
        "UPDATE builder_sessions SET status = 'published', updated_at = NOW() WHERE id = $1",
        [sess.id]
      );

      await client.query('COMMIT');

      const full = await pool.query(
        `SELECT a.*, u.display_name AS uploaded_by_name, u.email AS uploaded_by_email
         FROM apps a LEFT JOIN users u ON a.uploaded_by = u.id WHERE a.id = $1`,
        [app.id]
      );

      res.status(201).json({
        app: {
          id: full.rows[0].id,
          name: full.rows[0].name,
          description: full.rows[0].description,
          icon: full.rows[0].icon,
          visibility: full.rows[0].visibility,
          createdAt: full.rows[0].created_at
        }
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Publish error:', err);
    res.status(500).json({ error: 'Failed to publish app' });
  }
});

// ─── DELETE /api/builder/sessions/:id ────────────────────────────────────────

router.delete('/sessions/:id', auth, validateId, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM builder_sessions WHERE id = $1 AND workspace_id = $2 AND user_id = $3 RETURNING id',
      [req.params.id, req.user.workspaceId, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Session not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete session error:', err);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

// ─── GET /api/builder/usage — token usage meter ──────────────────────────────

router.get('/usage', auth, async (req, res) => {
  try {
    const usage = await getTokenUsage(req.user.workspaceId);
    if (!usage) return res.status(404).json({ error: 'Workspace not found' });
    res.json(usage);
  } catch (err) {
    console.error('Usage error:', err);
    res.status(500).json({ error: 'Failed to get usage' });
  }
});

module.exports = router;
