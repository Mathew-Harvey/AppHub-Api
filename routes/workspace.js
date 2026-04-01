const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const pool = require('../config/db');
const { auth, adminOnly, validateId } = require('../middleware/auth');
const { enforceMemberLimit } = require('../middleware/subscription');
const { getLimits } = require('../config/plans');

const router = express.Router();

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

function formatWorkspace(ws) {
  const limits = getLimits(ws.plan || 'free');
  return {
    id: ws.id,
    name: ws.name,
    slug: ws.slug,
    logoData: ws.logo_data || null,
    primaryColor: ws.primary_color,
    accentColor: ws.accent_color,
    primaryColorLight: ws.primary_color_light || '#ffffff',
    accentColorLight: ws.accent_color_light || '#d63851',
    plan: ws.plan || 'free',
    planLimits: limits,
    aiConversionsUsed: ws.ai_conversions_used || 0,
    aiConversionsResetAt: ws.ai_conversions_reset_at
  };
}

router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM workspaces WHERE id = $1', [req.user.workspaceId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Workspace not found' });
    }
    res.json({ workspace: formatWorkspace(result.rows[0]) });
  } catch (err) {
    console.error('Get workspace error:', err);
    res.status(500).json({ error: 'Failed to get workspace' });
  }
});

router.put('/', auth, adminOnly, async (req, res) => {
  const { name, primaryColor, accentColor, primaryColorLight, accentColorLight } = req.body;

  if (name && name.length > 100) {
    return res.status(400).json({ error: 'Workspace name must be 100 characters or less' });
  }

  const hexPattern = /^#[0-9a-fA-F]{6}$/;
  if (primaryColor && !hexPattern.test(primaryColor)) return res.status(400).json({ error: 'Invalid primary color format' });
  if (accentColor && !hexPattern.test(accentColor)) return res.status(400).json({ error: 'Invalid accent color format' });
  if (primaryColorLight && !hexPattern.test(primaryColorLight)) return res.status(400).json({ error: 'Invalid primary light color format' });
  if (accentColorLight && !hexPattern.test(accentColorLight)) return res.status(400).json({ error: 'Invalid accent light color format' });

  try {
    const result = await pool.query(
      `UPDATE workspaces SET
        name = COALESCE($1, name),
        primary_color = COALESCE($2, primary_color),
        accent_color = COALESCE($3, accent_color),
        primary_color_light = COALESCE($4, primary_color_light),
        accent_color_light = COALESCE($5, accent_color_light),
        updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [name?.trim() || null, primaryColor || null, accentColor || null, primaryColorLight || null, accentColorLight || null, req.user.workspaceId]
    );
    res.json({ workspace: formatWorkspace(result.rows[0]) });
  } catch (err) {
    console.error('Update workspace error:', err);
    res.status(500).json({ error: 'Failed to update workspace' });
  }
});

router.post('/logo', auth, adminOnly, logoUpload.single('logo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  try {
    const resized = await sharp(req.file.buffer)
      .resize(200, 200, { fit: 'inside', withoutEnlargement: true })
      .png({ quality: 85 })
      .toBuffer();
    const base64 = `data:image/png;base64,${resized.toString('base64')}`;
    const result = await pool.query(
      'UPDATE workspaces SET logo_data = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [base64, req.user.workspaceId]
    );
    res.json({ workspace: formatWorkspace(result.rows[0]) });
  } catch (err) {
    console.error('Logo upload error:', err);
    res.status(500).json({ error: 'Failed to upload logo' });
  }
});

router.get('/members', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, display_name, role, is_active, last_login_at, created_at
       FROM users WHERE workspace_id = $1 ORDER BY role DESC, display_name ASC`,
      [req.user.workspaceId]
    );
    res.json({
      members: result.rows.map(u => ({
        id: u.id, email: u.email, displayName: u.display_name, role: u.role,
        isActive: u.is_active, lastLoginAt: u.last_login_at, createdAt: u.created_at
      }))
    });
  } catch (err) {
    console.error('List members error:', err);
    res.status(500).json({ error: 'Failed to list members' });
  }
});

router.post('/invite', auth, adminOnly, enforceMemberLimit, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });
  const cleanEmail = email.toLowerCase().trim();
  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1 AND workspace_id = $2', [cleanEmail, req.user.workspaceId]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'User is already a member of this workspace' });
    const existingInvite = await pool.query('SELECT id FROM invitations WHERE email = $1 AND workspace_id = $2 AND accepted = false', [cleanEmail, req.user.workspaceId]);
    if (existingInvite.rows.length > 0) return res.status(400).json({ error: 'User has already been invited' });
    const result = await pool.query('INSERT INTO invitations (workspace_id, email, invited_by) VALUES ($1, $2, $3) RETURNING *', [req.user.workspaceId, cleanEmail, req.user.id]);
    const invitation = result.rows[0];
    const inviteLink = `${process.env.CLIENT_URL || 'http://localhost:5173'}/register?invite=${invitation.id}`;
    res.status(201).json({ invitation: { id: invitation.id, email: invitation.email, inviteLink, accepted: false } });
  } catch (err) {
    console.error('Invite error:', err);
    res.status(500).json({ error: 'Failed to send invitation' });
  }
});

router.get('/invitations', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query('SELECT i.id, i.email, i.accepted, i.created_at FROM invitations i WHERE i.workspace_id = $1 ORDER BY i.created_at DESC', [req.user.workspaceId]);
    res.json({ invitations: result.rows.map(i => ({ id: i.id, email: i.email, accepted: i.accepted, createdAt: i.created_at })) });
  } catch (err) {
    console.error('List invitations error:', err);
    res.status(500).json({ error: 'Failed to list invitations' });
  }
});

router.delete('/invite/:id', auth, adminOnly, validateId, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM invitations WHERE id = $1 AND workspace_id = $2 RETURNING id', [req.params.id, req.user.workspaceId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Invitation not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Revoke invite error:', err);
    res.status(500).json({ error: 'Failed to revoke invitation' });
  }
});

router.put('/members/:id/role', auth, adminOnly, validateId, async (req, res) => {
  const { role } = req.body;
  if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  try {
    const member = await pool.query('SELECT id FROM users WHERE id = $1 AND workspace_id = $2 AND is_active = true', [req.params.id, req.user.workspaceId]);
    if (member.rows.length === 0) return res.status(404).json({ error: 'Member not found' });
    await pool.query('UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2', [role, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Role change error:', err);
    res.status(500).json({ error: 'Failed to change role' });
  }
});

router.delete('/members/:id', auth, adminOnly, validateId, async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot remove yourself' });
  try {
    const member = await pool.query('SELECT id FROM users WHERE id = $1 AND workspace_id = $2 AND is_active = true', [req.params.id, req.user.workspaceId]);
    if (member.rows.length === 0) return res.status(404).json({ error: 'Member not found' });
    await pool.query('UPDATE users SET is_active = false, updated_at = NOW() WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Remove member error:', err);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

module.exports = router;
