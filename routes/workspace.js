const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pool = require('../config/db');
const { auth, adminOnly } = require('../middleware/auth');

const router = express.Router();

// Logo upload config
const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(process.env.UPLOAD_DIR || './uploads', 'logos');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${req.user.workspaceId}${ext}`);
  }
});

const logoUpload = multer({
  storage: logoStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.svg', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// GET /api/workspace - Get workspace details
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM workspaces WHERE id = $1',
      [req.user.workspaceId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    const ws = result.rows[0];
    res.json({
      workspace: {
        id: ws.id,
        name: ws.name,
        slug: ws.slug,
        logoPath: ws.logo_path,
        primaryColor: ws.primary_color,
        accentColor: ws.accent_color
      }
    });
  } catch (err) {
    console.error('Get workspace error:', err);
    res.status(500).json({ error: 'Failed to get workspace' });
  }
});

// PUT /api/workspace - Update workspace settings (admin only)
router.put('/', auth, adminOnly, async (req, res) => {
  const { name, primaryColor, accentColor } = req.body;

  try {
    const result = await pool.query(
      `UPDATE workspaces SET 
        name = COALESCE($1, name),
        primary_color = COALESCE($2, primary_color),
        accent_color = COALESCE($3, accent_color),
        updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [name, primaryColor, accentColor, req.user.workspaceId]
    );

    const ws = result.rows[0];
    res.json({
      workspace: {
        id: ws.id,
        name: ws.name,
        slug: ws.slug,
        logoPath: ws.logo_path,
        primaryColor: ws.primary_color,
        accentColor: ws.accent_color
      }
    });
  } catch (err) {
    console.error('Update workspace error:', err);
    res.status(500).json({ error: 'Failed to update workspace' });
  }
});

// POST /api/workspace/logo - Upload workspace logo (admin only)
router.post('/logo', auth, adminOnly, logoUpload.single('logo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const logoPath = `/api/workspace/logo/${req.user.workspaceId}`;

    await pool.query(
      'UPDATE workspaces SET logo_path = $1, updated_at = NOW() WHERE id = $2',
      [logoPath, req.user.workspaceId]
    );

    res.json({ logoPath });
  } catch (err) {
    console.error('Logo upload error:', err);
    res.status(500).json({ error: 'Failed to upload logo' });
  }
});

// GET /api/workspace/logo/:workspaceId - Serve workspace logo
router.get('/logo/:workspaceId', async (req, res) => {
  const logoDir = path.join(process.env.UPLOAD_DIR || './uploads', 'logos');
  const extensions = ['.png', '.jpg', '.jpeg', '.svg', '.webp'];
  
  for (const ext of extensions) {
    const filePath = path.join(logoDir, `${req.params.workspaceId}${ext}`);
    if (fs.existsSync(filePath)) {
      return res.sendFile(path.resolve(filePath));
    }
  }

  res.status(404).json({ error: 'Logo not found' });
});

// GET /api/workspace/members - List workspace members
router.get('/members', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, display_name, role, is_active, created_at
       FROM users
       WHERE workspace_id = $1
       ORDER BY role DESC, display_name ASC`,
      [req.user.workspaceId]
    );

    res.json({ members: result.rows.map(u => ({
      id: u.id,
      email: u.email,
      displayName: u.display_name,
      role: u.role,
      isActive: u.is_active,
      createdAt: u.created_at
    }))});
  } catch (err) {
    console.error('List members error:', err);
    res.status(500).json({ error: 'Failed to list members' });
  }
});

// POST /api/workspace/invite - Invite a user (admin only)
router.post('/invite', auth, adminOnly, async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  try {
    // Check if already a member
    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1 AND workspace_id = $2',
      [email.toLowerCase(), req.user.workspaceId]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'User is already a member of this workspace' });
    }

    // Check if already invited
    const existingInvite = await pool.query(
      'SELECT id FROM invitations WHERE email = $1 AND workspace_id = $2 AND accepted = false',
      [email.toLowerCase(), req.user.workspaceId]
    );

    if (existingInvite.rows.length > 0) {
      return res.status(400).json({ error: 'User has already been invited' });
    }

    const result = await pool.query(
      'INSERT INTO invitations (workspace_id, email, invited_by) VALUES ($1, $2, $3) RETURNING *',
      [req.user.workspaceId, email.toLowerCase(), req.user.id]
    );

    const invitation = result.rows[0];

    // In production, send an email here with the invite link
    // For now, return the invite code
    const inviteLink = `${process.env.CLIENT_URL || ''}/register?invite=${invitation.id}`;

    res.status(201).json({
      invitation: {
        id: invitation.id,
        email: invitation.email,
        inviteLink
      }
    });
  } catch (err) {
    console.error('Invite error:', err);
    res.status(500).json({ error: 'Failed to send invitation' });
  }
});

// GET /api/workspace/invitations - List pending invitations (admin only)
router.get('/invitations', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT i.*, u.display_name as invited_by_name
       FROM invitations i
       LEFT JOIN users u ON i.invited_by = u.id
       WHERE i.workspace_id = $1
       ORDER BY i.created_at DESC`,
      [req.user.workspaceId]
    );

    res.json({ invitations: result.rows.map(i => ({
      id: i.id,
      email: i.email,
      accepted: i.accepted,
      invitedBy: i.invited_by_name,
      createdAt: i.created_at
    }))});
  } catch (err) {
    console.error('List invitations error:', err);
    res.status(500).json({ error: 'Failed to list invitations' });
  }
});

// DELETE /api/workspace/invite/:id - Revoke invitation (admin only)
router.delete('/invite/:id', auth, adminOnly, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM invitations WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.user.workspaceId]
    );
    res.json({ message: 'Invitation revoked' });
  } catch (err) {
    console.error('Revoke invite error:', err);
    res.status(500).json({ error: 'Failed to revoke invitation' });
  }
});

// PUT /api/workspace/members/:id/role - Change member role (admin only)
router.put('/members/:id/role', auth, adminOnly, async (req, res) => {
  const { role } = req.body;

  if (!['admin', 'member'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Cannot change your own role' });
  }

  try {
    await pool.query(
      'UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2 AND workspace_id = $3',
      [role, req.params.id, req.user.workspaceId]
    );
    res.json({ message: 'Role updated' });
  } catch (err) {
    console.error('Change role error:', err);
    res.status(500).json({ error: 'Failed to change role' });
  }
});

// DELETE /api/workspace/members/:id - Remove member (admin only)
router.delete('/members/:id', auth, adminOnly, async (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Cannot remove yourself' });
  }

  try {
    await pool.query(
      'UPDATE users SET is_active = false, updated_at = NOW() WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.user.workspaceId]
    );
    res.json({ message: 'Member removed' });
  } catch (err) {
    console.error('Remove member error:', err);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

module.exports = router;
