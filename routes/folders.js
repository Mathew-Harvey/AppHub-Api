const express = require('express');
const pool = require('../config/db');
const { auth, validateId } = require('../middleware/auth');

const router = express.Router();

function formatFolder(row, items = []) {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    apps: items.map(item => ({
      id: item.app_id,
      name: item.app_name,
      icon: item.app_icon,
      description: item.app_description,
      isDemo: item.is_demo || false,
      sortOrder: item.item_sort_order
    }))
  };
}

// GET /api/folders — list all folders for the current user in their workspace, with nested apps
router.get('/', auth, async (req, res) => {
  try {
    const folders = await pool.query(
      `SELECT * FROM app_folders
       WHERE workspace_id = $1 AND user_id = $2
       ORDER BY sort_order ASC, created_at ASC`,
      [req.user.workspaceId, req.user.id]
    );

    if (folders.rows.length === 0) {
      return res.json({ folders: [] });
    }

    const folderIds = folders.rows.map(f => f.id);
    const items = await pool.query(
      `SELECT fi.folder_id, fi.app_id, fi.sort_order AS item_sort_order,
              a.name AS app_name, a.icon AS app_icon, a.description AS app_description, a.is_demo
       FROM app_folder_items fi
       JOIN apps a ON fi.app_id = a.id AND a.is_active = true AND a.pending_delete = false
       WHERE fi.folder_id = ANY($1)
       ORDER BY fi.sort_order ASC`,
      [folderIds]
    );

    const itemsByFolder = {};
    for (const item of items.rows) {
      if (!itemsByFolder[item.folder_id]) itemsByFolder[item.folder_id] = [];
      itemsByFolder[item.folder_id].push(item);
    }

    res.json({
      folders: folders.rows.map(f => formatFolder(f, itemsByFolder[f.id] || []))
    });
  } catch (err) {
    console.error('List folders error:', err);
    res.status(500).json({ error: 'Failed to list folders' });
  }
});

// POST /api/folders — create a folder (optionally with initial app IDs)
router.post('/', auth, async (req, res) => {
  const { name, icon, appIds } = req.body;

  if (!Array.isArray(appIds) || appIds.length < 2) {
    return res.status(400).json({ error: 'At least two appIds are required to create a folder' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const maxOrder = await client.query(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM app_folders WHERE workspace_id = $1 AND user_id = $2',
      [req.user.workspaceId, req.user.id]
    );

    const folderResult = await client.query(
      `INSERT INTO app_folders (workspace_id, user_id, name, icon, sort_order)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.user.workspaceId, req.user.id, name?.trim() || 'New Folder', icon || '📁', maxOrder.rows[0].next]
    );
    const folder = folderResult.rows[0];

    const verified = await client.query(
      'SELECT id FROM apps WHERE id = ANY($1) AND workspace_id = $2 AND is_active = true',
      [appIds, req.user.workspaceId]
    );
    const validIds = new Set(verified.rows.map(r => r.id));

    let sortIdx = 0;
    for (const appId of appIds) {
      if (!validIds.has(appId)) continue;
      await client.query(
        'INSERT INTO app_folder_items (folder_id, app_id, sort_order) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [folder.id, appId, sortIdx++]
      );
    }

    await client.query('COMMIT');

    const items = await pool.query(
      `SELECT fi.folder_id, fi.app_id, fi.sort_order AS item_sort_order,
              a.name AS app_name, a.icon AS app_icon, a.description AS app_description, a.is_demo
       FROM app_folder_items fi
       JOIN apps a ON fi.app_id = a.id
       WHERE fi.folder_id = $1
       ORDER BY fi.sort_order ASC`,
      [folder.id]
    );

    res.status(201).json({ folder: formatFolder(folder, items.rows) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create folder error:', err);
    res.status(500).json({ error: 'Failed to create folder' });
  } finally {
    client.release();
  }
});

// PUT /api/folders/layout — save the full layout (folder order + items within each folder)
router.put('/layout', auth, async (req, res) => {
  const { folders } = req.body;
  if (!Array.isArray(folders)) {
    return res.status(400).json({ error: 'folders array is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (let i = 0; i < folders.length; i++) {
      const { id, appIds } = folders[i];
      if (!id) continue;

      await client.query(
        'UPDATE app_folders SET sort_order = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3 AND workspace_id = $4',
        [i, id, req.user.id, req.user.workspaceId]
      );

      if (Array.isArray(appIds)) {
        await client.query('DELETE FROM app_folder_items WHERE folder_id = $1', [id]);
        for (let j = 0; j < appIds.length; j++) {
          await client.query(
            'INSERT INTO app_folder_items (folder_id, app_id, sort_order) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [id, appIds[j], j]
          );
        }
      }
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Save layout error:', err);
    res.status(500).json({ error: 'Failed to save layout' });
  } finally {
    client.release();
  }
});

// PUT /api/folders/:id — rename or change icon
router.put('/:id', auth, validateId, async (req, res) => {
  const { name, icon } = req.body;

  try {
    const result = await pool.query(
      `UPDATE app_folders
       SET name = COALESCE($1, name), icon = COALESCE($2, icon), updated_at = NOW()
       WHERE id = $3 AND user_id = $4 AND workspace_id = $5
       RETURNING *`,
      [name?.trim() || null, icon || null, req.params.id, req.user.id, req.user.workspaceId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    const items = await pool.query(
      `SELECT fi.folder_id, fi.app_id, fi.sort_order AS item_sort_order,
              a.name AS app_name, a.icon AS app_icon, a.description AS app_description, a.is_demo
       FROM app_folder_items fi
       JOIN apps a ON fi.app_id = a.id AND a.is_active = true
       WHERE fi.folder_id = $1
       ORDER BY fi.sort_order ASC`,
      [req.params.id]
    );

    res.json({ folder: formatFolder(result.rows[0], items.rows) });
  } catch (err) {
    console.error('Update folder error:', err);
    res.status(500).json({ error: 'Failed to update folder' });
  }
});

// DELETE /api/folders/:id — delete folder (apps are released back to the home screen)
router.delete('/:id', auth, validateId, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM app_folders WHERE id = $1 AND user_id = $2 AND workspace_id = $3 RETURNING id',
      [req.params.id, req.user.id, req.user.workspaceId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Folder not found' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete folder error:', err);
    res.status(500).json({ error: 'Failed to delete folder' });
  }
});

// POST /api/folders/:id/apps — add an app to a folder
router.post('/:id/apps', auth, validateId, async (req, res) => {
  const { appId } = req.body;
  if (!appId) {
    return res.status(400).json({ error: 'appId is required' });
  }

  try {
    const folder = await pool.query(
      'SELECT id FROM app_folders WHERE id = $1 AND user_id = $2 AND workspace_id = $3',
      [req.params.id, req.user.id, req.user.workspaceId]
    );
    if (folder.rows.length === 0) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    const app = await pool.query(
      'SELECT id FROM apps WHERE id = $1 AND workspace_id = $2 AND is_active = true',
      [appId, req.user.workspaceId]
    );
    if (app.rows.length === 0) {
      return res.status(404).json({ error: 'App not found' });
    }

    const maxOrder = await pool.query(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM app_folder_items WHERE folder_id = $1',
      [req.params.id]
    );

    await pool.query(
      'INSERT INTO app_folder_items (folder_id, app_id, sort_order) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [req.params.id, appId, maxOrder.rows[0].next]
    );

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('Add app to folder error:', err);
    res.status(500).json({ error: 'Failed to add app to folder' });
  }
});

// DELETE /api/folders/:id/apps/:appId — remove an app from a folder
router.delete('/:id/apps/:appId', auth, async (req, res) => {
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_REGEX.test(req.params.id) || !UUID_REGEX.test(req.params.appId)) {
    return res.status(400).json({ error: 'Invalid ID format' });
  }

  try {
    const folder = await pool.query(
      'SELECT id FROM app_folders WHERE id = $1 AND user_id = $2 AND workspace_id = $3',
      [req.params.id, req.user.id, req.user.workspaceId]
    );
    if (folder.rows.length === 0) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    await pool.query(
      'DELETE FROM app_folder_items WHERE folder_id = $1 AND app_id = $2',
      [req.params.id, req.params.appId]
    );

    // Auto-delete empty folders (if only 0 or 1 items remain, folder is pointless)
    const remaining = await pool.query(
      'SELECT COUNT(*) AS count FROM app_folder_items WHERE folder_id = $1',
      [req.params.id]
    );
    if (parseInt(remaining.rows[0].count) < 2) {
      await pool.query('DELETE FROM app_folders WHERE id = $1', [req.params.id]);
      return res.json({ ok: true, folderDeleted: true });
    }

    res.json({ ok: true, folderDeleted: false });
  } catch (err) {
    console.error('Remove app from folder error:', err);
    res.status(500).json({ error: 'Failed to remove app from folder' });
  }
});

module.exports = router;
