const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { auth } = require('../middleware/auth');

const router = express.Router();

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

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, workspaceId: user.workspace_id || user.workspaceId, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// Fetch full user profile with workspace details (shared by register, login, me)
async function getUserProfile(userId) {
  const result = await pool.query(
    `SELECT u.id, u.email, u.display_name, u.role, u.workspace_id,
            w.name AS workspace_name, w.slug AS workspace_slug,
            w.logo_data, w.primary_color, w.accent_color
     FROM users u
     JOIN workspaces w ON u.workspace_id = w.id
     WHERE u.id = $1 AND u.is_active = true`,
    [userId]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    workspaceId: row.workspace_id,
    workspace: {
      name: row.workspace_name,
      slug: row.workspace_slug,
      logoData: row.logo_data,
      primaryColor: row.primary_color,
      accentColor: row.accent_color
    }
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

  const cleanEmail = email.toLowerCase().trim();
  const cleanName = displayName.trim();

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
      workspaceId = inviteResult.rows[0].workspace_id;
      await client.query('UPDATE invitations SET accepted = true WHERE id = $1', [inviteCode]);

    } else if (workspaceName) {
      const cleanWsName = workspaceName.trim();
      const slug = cleanWsName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      const existingWorkspace = await client.query('SELECT id FROM workspaces WHERE slug = $1', [slug]);
      if (existingWorkspace.rows.length > 0) {
        return res.status(400).json({ error: 'A workspace with a similar name already exists' });
      }
      const wsResult = await client.query(
        'INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id',
        [cleanWsName, slug]
      );
      workspaceId = wsResult.rows[0].id;
      role = 'admin';

    } else {
      return res.status(400).json({ error: 'Either workspaceName or inviteCode is required' });
    }

    const existingUser = await client.query(
      'SELECT id FROM users WHERE email = $1 AND workspace_id = $2',
      [cleanEmail, workspaceId]
    );
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'An account with this email already exists in this workspace' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const userResult = await client.query(
      'INSERT INTO users (workspace_id, email, password_hash, display_name, role) VALUES ($1, $2, $3, $4, $5) RETURNING id, email, display_name, role, workspace_id',
      [workspaceId, cleanEmail, passwordHash, cleanName, role]
    );

    await client.query('COMMIT');

    const user = userResult.rows[0];
    const token = signToken(user);
    const profile = await getUserProfile(user.id);

    res.cookie('token', token, getCookieOptions());
    res.status(201).json({ user: profile });
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
      'SELECT id, password_hash FROM users WHERE email = $1 AND is_active = true',
      [email.toLowerCase().trim()]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const row = result.rows[0];
    const validPassword = await bcrypt.compare(password, row.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const profile = await getUserProfile(row.id);
    const token = signToken({ id: row.id, email: profile.email, workspace_id: profile.workspaceId, role: profile.role });

    res.cookie('token', token, getCookieOptions());
    res.json({ user: profile });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  const isProd = process.env.NODE_ENV === 'production';
  res.clearCookie('token', { path: '/', sameSite: isProd ? 'none' : 'lax', secure: isProd });
  res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', auth, async (req, res) => {
  try {
    const profile = await getUserProfile(req.user.id);
    if (!profile) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user: profile });
  } catch (err) {
    console.error('Profile error:', err);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

module.exports = router;
