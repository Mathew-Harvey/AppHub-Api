const express = require('express');
const pool = require('../config/db');
const { auth, validateId } = require('../middleware/auth');
const { enforceAppLimit } = require('../middleware/subscription');

const router = express.Router();

function formatMarketplaceApp(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    marketplaceCategory: row.marketplace_category || null,
    marketplaceTags: row.marketplace_tags || [],
    installCount: row.install_count || 0,
    publishedAt: row.published_at,
    publisherName: row.workspace_name || 'Unknown',
    publisherLogo: row.workspace_id ? `/api/workspace/logo/${row.workspace_id}` : null,
    fileSize: row.file_size,
  };
}

// GET /api/marketplace — browse public apps
router.get('/', auth, async (req, res) => {
  try {
    const { search, category, sort, page = 1, limit = 24 } = req.query;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(48, Math.max(1, parseInt(limit) || 24));
    const offset = (pageNum - 1) * limitNum;

    let orderBy = 'a.install_count DESC, a.published_at DESC';
    if (sort === 'newest') orderBy = 'a.published_at DESC';
    if (sort === 'name') orderBy = 'a.name ASC';

    const conditions = [
      "a.visibility = 'public'",
      'a.is_active = true',
      'a.pending_delete = false',
      'a.is_demo = false',
    ];
    const params = [];
    let paramIdx = 1;

    if (search) {
      conditions.push(`(a.name ILIKE $${paramIdx} OR a.description ILIKE $${paramIdx})`);
      params.push(`%${search}%`);
      paramIdx++;
    }

    if (category) {
      conditions.push(`a.marketplace_category = $${paramIdx}`);
      params.push(category);
      paramIdx++;
    }

    const whereClause = conditions.join(' AND ');

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM apps a WHERE ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    const result = await pool.query(
      `SELECT a.id, a.name, a.description, a.icon, a.marketplace_category,
              a.marketplace_tags, a.install_count, a.published_at, a.file_size,
              w.name AS workspace_name, a.workspace_id
       FROM apps a
       LEFT JOIN workspaces w ON a.workspace_id = w.id
       WHERE ${whereClause}
       ORDER BY ${orderBy}
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limitNum, offset]
    );

    res.json({
      apps: result.rows.map(formatMarketplaceApp),
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (err) {
    console.error('Marketplace list error:', err);
    res.status(500).json({ error: 'Failed to load marketplace' });
  }
});

// GET /api/marketplace/categories — list available categories
router.get('/categories', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, icon, sort_order FROM marketplace_categories ORDER BY sort_order ASC'
    );
    res.json({ categories: result.rows });
  } catch (err) {
    console.error('Categories error:', err);
    res.status(500).json({ error: 'Failed to load categories' });
  }
});

// GET /api/marketplace/featured — top apps for homepage
router.get('/featured', auth, async (req, res) => {
  try {
    const popular = await pool.query(
      `SELECT a.id, a.name, a.description, a.icon, a.marketplace_category,
              a.marketplace_tags, a.install_count, a.published_at, a.file_size,
              w.name AS workspace_name, a.workspace_id
       FROM apps a
       LEFT JOIN workspaces w ON a.workspace_id = w.id
       WHERE a.visibility = 'public' AND a.is_active = true AND a.pending_delete = false AND a.is_demo = false
       ORDER BY a.install_count DESC
       LIMIT 6`
    );

    const newest = await pool.query(
      `SELECT a.id, a.name, a.description, a.icon, a.marketplace_category,
              a.marketplace_tags, a.install_count, a.published_at, a.file_size,
              w.name AS workspace_name, a.workspace_id
       FROM apps a
       LEFT JOIN workspaces w ON a.workspace_id = w.id
       WHERE a.visibility = 'public' AND a.is_active = true AND a.pending_delete = false AND a.is_demo = false
       ORDER BY a.published_at DESC
       LIMIT 6`
    );

    res.json({
      popular: popular.rows.map(formatMarketplaceApp),
      newest: newest.rows.map(formatMarketplaceApp),
    });
  } catch (err) {
    console.error('Featured error:', err);
    res.status(500).json({ error: 'Failed to load featured apps' });
  }
});

// GET /api/marketplace/:id — single app detail
router.get('/:id', auth, validateId, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.id, a.name, a.description, a.icon, a.marketplace_category,
              a.marketplace_tags, a.install_count, a.published_at, a.file_size,
              a.created_at, w.name AS workspace_name, a.workspace_id
       FROM apps a
       LEFT JOIN workspaces w ON a.workspace_id = w.id
       WHERE a.id = $1 AND a.visibility = 'public' AND a.is_active = true AND a.pending_delete = false`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'App not found in marketplace' });
    }

    // Check if user already has this app installed
    const existingCopy = await pool.query(
      'SELECT id FROM apps WHERE source_app_id = $1 AND workspace_id = $2 AND is_active = true',
      [req.params.id, req.user.workspaceId]
    );

    const app = formatMarketplaceApp(result.rows[0]);
    app.alreadyAdded = existingCopy.rows.length > 0;
    app.existingAppId = existingCopy.rows.length > 0 ? existingCopy.rows[0].id : null;

    res.json({ app });
  } catch (err) {
    console.error('Marketplace app detail error:', err);
    res.status(500).json({ error: 'Failed to load app details' });
  }
});

// POST /api/marketplace/:id/install — add app to user's workspace
router.post('/:id/install', auth, validateId, enforceAppLimit, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify source app is still public and active
    const source = await client.query(
      `SELECT id, name, description, icon, file_content, file_size, original_filename,
              marketplace_category, marketplace_tags
       FROM apps
       WHERE id = $1 AND visibility = 'public' AND is_active = true AND pending_delete = false`,
      [req.params.id]
    );
    if (source.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'App is no longer available in the marketplace' });
    }

    // Check if already installed
    const existing = await client.query(
      'SELECT id FROM apps WHERE source_app_id = $1 AND workspace_id = $2 AND is_active = true',
      [req.params.id, req.user.workspaceId]
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'App already added to your workspace', appId: existing.rows[0].id });
    }

    const src = source.rows[0];

    // Get next sort order
    const maxOrder = await client.query(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM apps WHERE workspace_id = $1 AND is_active = true',
      [req.user.workspaceId]
    );

    // Create copy in user's workspace
    const newApp = await client.query(
      `INSERT INTO apps (workspace_id, uploaded_by, name, description, icon, file_content,
        original_filename, file_size, sort_order, visibility, source_app_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'team', $10)
       RETURNING *`,
      [
        req.user.workspaceId, req.user.id, src.name, src.description, src.icon,
        src.file_content, src.original_filename, src.file_size,
        maxOrder.rows[0].next_order, req.params.id
      ]
    );

    // Increment install count on source app
    await client.query(
      'UPDATE apps SET install_count = install_count + 1 WHERE id = $1',
      [req.params.id]
    );

    await client.query('COMMIT');

    const full = await pool.query(
      `SELECT a.*, u.display_name AS uploaded_by_name, u.email AS uploaded_by_email
       FROM apps a LEFT JOIN users u ON a.uploaded_by = u.id WHERE a.id = $1`,
      [newApp.rows[0].id]
    );

    res.status(201).json({
      app: {
        id: full.rows[0].id,
        name: full.rows[0].name,
        description: full.rows[0].description,
        icon: full.rows[0].icon,
        visibility: full.rows[0].visibility,
        sortOrder: full.rows[0].sort_order,
        sourceAppId: full.rows[0].source_app_id,
        createdAt: full.rows[0].created_at,
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Marketplace install error:', err);
    res.status(500).json({ error: 'Failed to install app' });
  } finally {
    client.release();
  }
});

module.exports = router;
