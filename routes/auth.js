const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { auth } = require('../middleware/auth');

const router = express.Router();

// Cookie config for cross-origin deployment.
// On Render: AppHub-Web (static site) and AppHub-Api (web service) are
// on different subdomains, so we need sameSite: 'none' + secure: true.
// In dev: Vite proxy makes everything same-origin, so 'lax' is fine.
function getCookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/'
  };
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { email, password, displayName, workspaceName, inviteCode } = req.body;

  if (!email || !password || !displayName) {
    return res.status(400).json({ error: 'Email, password, and display name are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let workspaceId;
    let role = 'member';

    if (inviteCode) {
      const inviteResult = await client.query(
        'SELECT * FROM invitations WHERE id = $1 AND accepted = false',
        [inviteCode]
      );
      if (inviteResult.rows.length === 0) {
        return res.status(400).json({ error: 'Invalid or already used invitation' });
      }
      const invitation = inviteResult.rows[0];
      if (invitation.email.toLowerCase() !== email.toLowerCase()) {
        return res.status(400).json({ error: 'Email does not match invitation' });
      }
      workspaceId = invitation.workspace_id;
      await client.query('UPDATE invitations SET accepted = true WHERE id = $1', [inviteCode]);

    } else if (workspaceName) {
      const slug = workspaceName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      const existingWorkspace = await client.query('SELECT id FROM workspaces WHERE slug = $1', [slug]);
      if (existingWorkspace.rows.length > 0) {
        return res.status(400).json({ error: 'A workspace with a similar name already exists' });
      }
      const wsResult = await client.query(
        'INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id',
        [workspaceName, slug]
      );
      workspaceId = wsResult.rows[0].id;
      role = 'admin';

    } else {
      return res.status(400).json({ error: 'Either workspaceName (to create) or inviteCode (to join) is required' });
    }

    const existingUser = await client.query(
      'SELECT id FROM users WHERE email = $1 AND workspace_id = $2',
      [email.toLowerCase(), workspaceId]
    );
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'An account with this email already exists in this workspace' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const userResult = await client.query(
      'INSERT INTO users (workspace_id, email, password_hash, display_name, role) VALUES ($1, $2, $3, $4, $5) RETURNING id, email, display_name, role',
      [workspaceId, email.toLowerCase(), passwordHash, displayName, role]
    );

    await client.query('COMMIT');
    const user = userResult.rows[0];

    const token = jwt.sign(
      { id: user.id, email: user.email, workspaceId, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.cookie('token', token, getCookieOptions());
    res.status(201).json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        role: user.role,
        workspaceId
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Registration failed' });
  } finally {
    client.release();
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const result = await pool.query(
      `SELECT u.*, w.name as workspace_name, w.slug as workspace_slug
       FROM users u JOIN workspaces w ON u.workspace_id = w.id
       WHERE u.email = $1 AND u.is_active = true`,
      [email.toLowerCase()]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, workspaceId: user.workspace_id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.cookie('token', token, getCookieOptions());
    res.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        role: user.role,
        workspaceId: user.workspace_id,
        workspaceName: user.workspace_name
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('token', { path: '/', sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', secure: process.env.NODE_ENV === 'production' });
  res.json({ message: 'Logged out' });
});

// GET /api/auth/me
router.get('/me', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.display_name, u.role, u.workspace_id,
              w.name as workspace_name, w.slug as workspace_slug,
              w.logo_path, w.primary_color, w.accent_color
       FROM users u JOIN workspaces w ON u.workspace_id = w.id
       WHERE u.id = $1`,
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    res.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        role: user.role,
        workspaceId: user.workspace_id,
        workspace: {
          name: user.workspace_name,
          slug: user.workspace_slug,
          logoPath: user.logo_path,
          primaryColor: user.primary_color,
          accentColor: user.accent_color
        }
      }
    });
  } catch (err) {
    console.error('Profile error:', err);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

module.exports = router;
