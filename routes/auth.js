const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { auth } = require('../middleware/auth');
const { getLimits } = require('../config/plans');
const { seedDemoApps } = require('../config/demoApps');
const { sendPasswordReset, sendWelcome } = require('../services/email');

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
}

function planFromPriceId(priceId) {
  if (priceId === process.env.STRIPE_PRICE_POWER) return 'power';
  if (priceId === process.env.STRIPE_PRICE_BUSINESS) return 'business';
  if (priceId === process.env.STRIPE_PRICE_TEAM) return 'team';
  if (priceId === process.env.STRIPE_PRICE_ID) return 'team';
  return 'team';
}

const router = express.Router();

function getCookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/api'
  };
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, workspaceId: user.workspace_id || user.workspaceId, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function validatePassword(password) {
  if (!password || password.length < 8) return false;
  if (!/[A-Z]/.test(password)) return false;
  if (!/[0-9]/.test(password)) return false;
  return true;
}

async function getUserProfile(userId) {
  const result = await pool.query(
    `SELECT u.id, u.email, u.display_name, u.role, u.workspace_id,
            w.name AS workspace_name, w.slug AS workspace_slug,
            w.primary_color, w.accent_color,
            w.primary_color_light, w.accent_color_light, w.plan,
            w.updated_at AS workspace_updated_at,
            CASE WHEN w.logo_data IS NOT NULL THEN true ELSE false END AS has_logo
     FROM users u
     JOIN workspaces w ON u.workspace_id = w.id
     WHERE u.id = $1 AND u.is_active = true`,
    [userId]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const bypassPlan = process.env.DEV_BYPASS_PLAN === 'true';
  const plan = bypassPlan ? 'power' : (row.plan || 'free');
  const logoVersion = row.workspace_updated_at ? new Date(row.workspace_updated_at).getTime() : '';
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    workspaceId: row.workspace_id,
    workspace: {
      name: row.workspace_name,
      slug: row.workspace_slug,
      logoUrl: row.has_logo ? `/api/workspace/logo?v=${logoVersion}` : null,
      primaryColor: row.primary_color,
      accentColor: row.accent_color,
      primaryColorLight: row.primary_color_light || '#ffffff',
      accentColorLight: row.accent_color_light || '#d63851',
      plan,
      planLimits: getLimits(plan)
    }
  };
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { email, password, displayName, workspaceName, inviteCode, stripeSessionId } = req.body;

  if (!email || !password || !displayName) {
    return res.status(400).json({ error: 'Email, password, and display name are required' });
  }
  if (!validatePassword(password)) {
    return res.status(400).json({ error: 'Password must be at least 8 characters with one uppercase letter and one number' });
  }
  if (displayName.length > 100) {
    return res.status(400).json({ error: 'Display name must be 100 characters or less' });
  }
  if (email.length > 255) {
    return res.status(400).json({ error: 'Email must be 255 characters or less' });
  }
  if (workspaceName && workspaceName.length > 100) {
    return res.status(400).json({ error: 'Workspace name must be 100 characters or less' });
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
      // Enforce: registering email must match the invited email
      if (inviteResult.rows[0].email !== cleanEmail) {
        return res.status(400).json({ error: 'This invitation was sent to a different email address' });
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

    // Seed demo apps for brand-new workspaces (not invite-based registrations)
    if (!inviteCode) {
      await seedDemoApps(client, workspaceId, userResult.rows[0].id);
    }

    // Link pre-paid Stripe subscription from landing page checkout
    if (stripeSessionId && !inviteCode) {
      const stripe = getStripe();
      if (stripe) {
        try {
          const session = await stripe.checkout.sessions.retrieve(stripeSessionId);
          if (session.payment_status === 'paid' && session.subscription) {
            const sub = await stripe.subscriptions.retrieve(session.subscription);
            const plan = planFromPriceId(sub.items?.data?.[0]?.price?.id);
            await stripe.customers.update(session.customer, {
              metadata: { workspaceId }
            });
            await client.query(
              'UPDATE workspaces SET plan = $1, stripe_customer_id = $2, stripe_subscription_id = $3 WHERE id = $4',
              [plan, session.customer, session.subscription, workspaceId]
            );
          }
        } catch (stripeErr) {
          console.error('Stripe session linking failed (workspace created on free tier):', stripeErr.message);
        }
      }
    }

    await client.query('COMMIT');

    const user = userResult.rows[0];
    const token = signToken(user);
    const profile = await getUserProfile(user.id);

    res.cookie('token', token, getCookieOptions());
    res.status(201).json({ user: profile });

    sendWelcome({ to: cleanEmail, displayName: cleanName, workspaceName: workspaceName?.trim() || null });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Registration failed' });
  } finally {
    client.release();
  }
});

// POST /api/auth/check-email — called from the login page to determine next step
router.post('/check-email', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const cleanEmail = email.toLowerCase().trim();

  try {
    const userResult = await pool.query(
      'SELECT id FROM users WHERE email = $1 AND is_active = true',
      [cleanEmail]
    );
    if (userResult.rows.length > 0) {
      return res.json({ status: 'existing_user' });
    }

    const inviteResult = await pool.query(
      `SELECT i.id AS invite_id, i.workspace_id, w.name AS workspace_name,
              CASE WHEN w.logo_data IS NOT NULL THEN true ELSE false END AS has_logo
       FROM invitations i
       JOIN workspaces w ON i.workspace_id = w.id
       WHERE i.email = $1 AND i.accepted = false`,
      [cleanEmail]
    );
    if (inviteResult.rows.length > 0) {
      return res.json({
        status: 'pending_invite',
        invites: inviteResult.rows.map(r => ({
          inviteId: r.invite_id,
          workspaceId: r.workspace_id,
          workspaceName: r.workspace_name,
          workspaceLogoUrl: r.has_logo ? `/api/workspace/logo/${r.workspace_id}` : null
        }))
      });
    }

    res.json({ status: 'unknown' });
  } catch (err) {
    console.error('Check email error:', err);
    res.status(500).json({ error: 'Failed to check email' });
  }
});

// POST /api/auth/accept-invite — invited user sets password and joins workspace
router.post('/accept-invite', async (req, res) => {
  const { email, password, displayName, inviteId } = req.body;

  if (!email || !password || !displayName || !inviteId) {
    return res.status(400).json({ error: 'Email, password, display name, and invite ID are required' });
  }
  if (!validatePassword(password)) {
    return res.status(400).json({ error: 'Password must be at least 8 characters with one uppercase letter and one number' });
  }

  const cleanEmail = email.toLowerCase().trim();
  const cleanName = displayName.trim();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const inviteResult = await client.query(
      `SELECT i.id, i.workspace_id, i.email, w.name AS workspace_name
       FROM invitations i
       JOIN workspaces w ON i.workspace_id = w.id
       WHERE i.id = $1 AND i.accepted = false`,
      [inviteId]
    );
    if (inviteResult.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or already used invitation' });
    }

    const invite = inviteResult.rows[0];
    if (invite.email !== cleanEmail) {
      return res.status(400).json({ error: 'Email does not match the invitation' });
    }

    const existingUser = await client.query(
      'SELECT id FROM users WHERE email = $1 AND workspace_id = $2',
      [cleanEmail, invite.workspace_id]
    );
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'An account with this email already exists in this workspace' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const userResult = await client.query(
      'INSERT INTO users (workspace_id, email, password_hash, display_name, role) VALUES ($1, $2, $3, $4, $5) RETURNING id, email, display_name, role, workspace_id',
      [invite.workspace_id, cleanEmail, passwordHash, cleanName, 'member']
    );

    await client.query('UPDATE invitations SET accepted = true WHERE id = $1', [inviteId]);

    await client.query('COMMIT');

    const user = userResult.rows[0];
    const token = signToken(user);
    const profile = await getUserProfile(user.id);

    res.cookie('token', token, getCookieOptions());
    res.status(201).json({ user: profile });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Accept invite error:', err);
    res.status(500).json({ error: 'Failed to accept invitation' });
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

    await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [row.id]);

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
  res.clearCookie('token', { path: '/api', sameSite: isProd ? 'none' : 'lax', secure: isProd });
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

// POST /api/auth/change-password — authenticated user changes their own password
router.post('/change-password', auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current password and new password are required' });
  }
  if (!validatePassword(newPassword)) {
    return res.status(400).json({ error: 'Password must be at least 8 characters with one uppercase letter and one number' });
  }

  try {
    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const valid = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// POST /api/auth/request-reset — generate a password reset token (no email sent — returns token for admin to share)
router.post('/request-reset', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  try {
    const result = await pool.query(
      'SELECT id FROM users WHERE email = $1 AND is_active = true',
      [email.toLowerCase().trim()]
    );
    // Always return success to prevent email enumeration
    if (result.rows.length === 0) {
      return res.json({ ok: true });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await pool.query(
      'UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3',
      [token, expiresAt, result.rows[0].id]
    );

    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    const resetLink = `${clientUrl}/reset-password?token=${token}`;
    sendPasswordReset({ to: email.toLowerCase().trim(), resetLink });

    res.json({ ok: true });
  } catch (err) {
    console.error('Request reset error:', err);
    res.status(500).json({ error: 'Failed to request reset' });
  }
});

// POST /api/auth/reset-password — use token to set new password
router.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) {
    return res.status(400).json({ error: 'Token and new password are required' });
  }
  if (!validatePassword(newPassword)) {
    return res.status(400).json({ error: 'Password must be at least 8 characters with one uppercase letter and one number' });
  }

  try {
    const result = await pool.query(
      'SELECT id FROM users WHERE reset_token = $1 AND reset_token_expires > NOW() AND is_active = true',
      [token]
    );
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset link' });
    }

    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query(
      'UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL, updated_at = NOW() WHERE id = $2',
      [hash, result.rows[0].id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// POST /api/auth/admin-reset — admin generates a reset link for a user
router.post('/admin-reset', auth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  try {
    const member = await pool.query(
      'SELECT id, email FROM users WHERE id = $1 AND workspace_id = $2 AND is_active = true',
      [userId, req.user.workspaceId]
    );
    if (member.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000); // 4 hours

    await pool.query(
      'UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3',
      [token, expiresAt, userId]
    );

    const resetLink = `${process.env.CLIENT_URL || 'http://localhost:5173'}/reset-password?token=${token}`;
    res.json({ resetLink, email: member.rows[0].email });
  } catch (err) {
    console.error('Admin reset error:', err);
    res.status(500).json({ error: 'Failed to generate reset link' });
  }
});

// GET /api/auth/sandbox-token — short-lived token for iframe sandbox
router.get('/sandbox-token', auth, (req, res) => {
  const token = jwt.sign(
    { id: req.user.id, email: req.user.email, workspaceId: req.user.workspaceId, role: req.user.role },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
  res.json({ token });
});

module.exports = router;
