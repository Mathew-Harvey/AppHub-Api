const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { logBuffer } = require('../services/logCapture');

// ── Hardcoded whitelist & password ──────────────────────────────────
const SUPER_ADMIN_PASSWORD = 'admin';
const WHITELISTED_EMAILS = [
  'mathewharvey@gmail.com',
  'mharvey@franmarine.com.au',
];

// ── Simple session tokens (in-memory) ──────────────────────────────
const activeSessions = new Map(); // token -> { email, createdAt }
const crypto = require('crypto');

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function superAdminAuth(req, res, next) {
  const token = req.headers['x-super-admin-token'];
  if (!token || !activeSessions.has(token)) {
    return res.status(401).json({ error: 'Super admin authentication required' });
  }
  const session = activeSessions.get(token);
  // 24-hour expiry
  if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) {
    activeSessions.delete(token);
    return res.status(401).json({ error: 'Session expired' });
  }
  req.superAdmin = session;
  next();
}

// ── POST /api/super-admin/login ─────────────────────────────────────
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  const normalizedEmail = email.toLowerCase().trim();
  if (!WHITELISTED_EMAILS.includes(normalizedEmail)) {
    return res.status(403).json({ error: 'Email not authorized for super admin access' });
  }
  if (password !== SUPER_ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  const token = generateToken();
  activeSessions.set(token, { email: normalizedEmail, createdAt: Date.now() });
  res.json({ token, email: normalizedEmail });
});

// ── POST /api/super-admin/logout ────────────────────────────────────
router.post('/logout', (req, res) => {
  const token = req.headers['x-super-admin-token'];
  if (token) activeSessions.delete(token);
  res.json({ ok: true });
});

// ── GET /api/super-admin/stats ──────────────────────────────────────
// Overview: workspace count, member count, plan distribution, app count
router.get('/stats', superAdminAuth, async (req, res) => {
  try {
    const [workspaces, users, apps, planDist, userPlanDist] = await Promise.all([
      pool.query('SELECT COUNT(*) AS count FROM workspaces'),
      pool.query('SELECT COUNT(*) AS count FROM users WHERE is_active = true'),
      pool.query('SELECT COUNT(*) AS count FROM apps WHERE is_active = true'),
      pool.query(`
        SELECT w.plan, COUNT(*) AS count
        FROM workspaces w
        GROUP BY w.plan
        ORDER BY count DESC
      `),
      pool.query(`
        SELECT COALESCE(u.plan, 'free') AS plan, COUNT(*) AS count
        FROM users u
        WHERE u.is_active = true
        GROUP BY u.plan
        ORDER BY count DESC
      `),
    ]);

    res.json({
      totalWorkspaces: parseInt(workspaces.rows[0].count),
      totalMembers: parseInt(users.rows[0].count),
      totalApps: parseInt(apps.rows[0].count),
      workspacePlanDistribution: planDist.rows.map(r => ({
        plan: r.plan || 'free',
        count: parseInt(r.count),
      })),
      userPlanDistribution: userPlanDist.rows.map(r => ({
        plan: r.plan || 'free',
        count: parseInt(r.count),
      })),
    });
  } catch (err) {
    console.error('Super admin stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ── GET /api/super-admin/usage ──────────────────────────────────────
// Per-user API usage (builder tokens, AI conversions)
router.get('/usage', superAdminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id,
        u.email,
        u.display_name,
        u.plan,
        u.role,
        u.is_active,
        u.ai_conversions_used,
        u.builder_tokens_used,
        u.last_login_at,
        u.created_at,
        w.name AS workspace_name,
        w.plan AS workspace_plan
      FROM users u
      LEFT JOIN workspaces w ON u.workspace_id = w.id
      WHERE u.is_active = true
      ORDER BY u.builder_tokens_used DESC NULLS LAST, u.ai_conversions_used DESC NULLS LAST
      LIMIT 200
    `);

    res.json({
      users: result.rows.map(r => ({
        id: r.id,
        email: r.email,
        displayName: r.display_name,
        plan: r.plan || 'free',
        role: r.role,
        aiConversionsUsed: r.ai_conversions_used || 0,
        builderTokensUsed: r.builder_tokens_used || 0,
        lastLoginAt: r.last_login_at,
        createdAt: r.created_at,
        workspaceName: r.workspace_name,
        workspacePlan: r.workspace_plan || 'free',
      })),
    });
  } catch (err) {
    console.error('Super admin usage error:', err);
    res.status(500).json({ error: 'Failed to fetch usage data' });
  }
});

// ── GET /api/super-admin/costs ──────────────────────────────────────
// AI conversion costs from conversion_logs + builder job token usage
router.get('/costs', superAdminAuth, async (req, res) => {
  try {
    const [conversionCosts, builderCosts, dailyCosts, totalConversions] = await Promise.all([
      // Total conversion costs
      pool.query(`
        SELECT
          COALESCE(SUM(cost_estimate_usd), 0) AS total_cost,
          COALESCE(SUM(input_tokens_est), 0) AS total_input_tokens,
          COALESCE(SUM(output_tokens_est), 0) AS total_output_tokens,
          COUNT(*) AS total_calls,
          COUNT(*) FILTER (WHERE success = true) AS successful_calls,
          COUNT(*) FILTER (WHERE success = false) AS failed_calls
        FROM conversion_logs
      `),
      // Builder job token costs (estimate from builder_jobs)
      pool.query(`
        SELECT
          COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
          COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
          COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read_tokens,
          COALESCE(SUM(cache_creation_tokens), 0) AS total_cache_creation_tokens,
          COUNT(*) AS total_jobs
        FROM builder_jobs
      `),
      // Daily cost breakdown (last 30 days)
      pool.query(`
        SELECT
          DATE(created_at) AS date,
          COALESCE(SUM(cost_estimate_usd), 0) AS cost,
          COUNT(*) AS calls
        FROM conversion_logs
        WHERE created_at >= NOW() - INTERVAL '30 days'
        GROUP BY DATE(created_at)
        ORDER BY date DESC
      `),
      // Total conversions by tier
      pool.query(`
        SELECT
          tier_used,
          model_used,
          COUNT(*) AS count,
          COALESCE(SUM(cost_estimate_usd), 0) AS total_cost
        FROM conversion_logs
        GROUP BY tier_used, model_used
        ORDER BY total_cost DESC
      `),
    ]);

    const convRow = conversionCosts.rows[0];
    const builderRow = builderCosts.rows[0];

    // Estimate builder costs using Anthropic pricing (builder uses Claude)
    const builderCostEstimate =
      (parseInt(builderRow.total_input_tokens) / 1000) * 0.003 +
      (parseInt(builderRow.total_output_tokens) / 1000) * 0.015 +
      (parseInt(builderRow.total_cache_read_tokens) / 1000) * 0.0003 +
      (parseInt(builderRow.total_cache_creation_tokens) / 1000) * 0.00375;

    res.json({
      conversions: {
        totalCost: parseFloat(convRow.total_cost),
        totalInputTokens: parseInt(convRow.total_input_tokens),
        totalOutputTokens: parseInt(convRow.total_output_tokens),
        totalCalls: parseInt(convRow.total_calls),
        successfulCalls: parseInt(convRow.successful_calls),
        failedCalls: parseInt(convRow.failed_calls),
      },
      builder: {
        estimatedCost: Math.round(builderCostEstimate * 100) / 100,
        totalInputTokens: parseInt(builderRow.total_input_tokens),
        totalOutputTokens: parseInt(builderRow.total_output_tokens),
        totalCacheReadTokens: parseInt(builderRow.total_cache_read_tokens),
        totalCacheCreationTokens: parseInt(builderRow.total_cache_creation_tokens),
        totalJobs: parseInt(builderRow.total_jobs),
      },
      totalEstimatedCost: Math.round((parseFloat(convRow.total_cost) + builderCostEstimate) * 100) / 100,
      dailyCosts: dailyCosts.rows.map(r => ({
        date: r.date,
        cost: parseFloat(r.cost),
        calls: parseInt(r.calls),
      })),
      costByTier: totalConversions.rows.map(r => ({
        tier: r.tier_used,
        model: r.model_used,
        count: parseInt(r.count),
        totalCost: parseFloat(r.total_cost),
      })),
    });
  } catch (err) {
    console.error('Super admin costs error:', err);
    res.status(500).json({ error: 'Failed to fetch cost data' });
  }
});

// ── GET /api/super-admin/income ─────────────────────────────────────
// Subscription income estimates based on active plans
router.get('/income', superAdminAuth, async (req, res) => {
  try {
    const PLAN_PRICES = { free: 0, team: 12, business: 29, power: 79 };

    const [planCounts, recentSignups, activeStripe] = await Promise.all([
      // Count users by plan (active users only)
      pool.query(`
        SELECT COALESCE(u.plan, 'free') AS plan, COUNT(*) AS count
        FROM users u
        WHERE u.is_active = true
        GROUP BY u.plan
      `),
      // Recent signups (last 30 days)
      pool.query(`
        SELECT DATE(created_at) AS date, COUNT(*) AS signups
        FROM users
        WHERE created_at >= NOW() - INTERVAL '30 days'
        GROUP BY DATE(created_at)
        ORDER BY date DESC
      `),
      // Users with active Stripe subscriptions
      pool.query(`
        SELECT COUNT(*) AS count
        FROM users
        WHERE stripe_subscription_id IS NOT NULL AND is_active = true
      `),
    ]);

    let estimatedMRR = 0;
    const planBreakdown = planCounts.rows.map(r => {
      const plan = r.plan || 'free';
      const count = parseInt(r.count);
      const price = PLAN_PRICES[plan] || 0;
      const revenue = count * price;
      estimatedMRR += revenue;
      return { plan, count, pricePerUser: price, monthlyRevenue: revenue };
    });

    res.json({
      estimatedMRR,
      estimatedARR: estimatedMRR * 12,
      activeStripeSubscriptions: parseInt(activeStripe.rows[0].count),
      planBreakdown,
      recentSignups: recentSignups.rows.map(r => ({
        date: r.date,
        signups: parseInt(r.signups),
      })),
    });
  } catch (err) {
    console.error('Super admin income error:', err);
    res.status(500).json({ error: 'Failed to fetch income data' });
  }
});

// ── GET /api/super-admin/logs ───────────────────────────────────────
// Server logs from the in-memory ring buffer
router.get('/logs', superAdminAuth, (req, res) => {
  const level = req.query.level; // 'info', 'warn', 'error', or undefined for all
  const search = req.query.search;
  const limit = Math.min(parseInt(req.query.limit) || 200, 1000);

  let logs = logBuffer.getLogs();

  if (level) {
    logs = logs.filter(l => l.level === level);
  }
  if (search) {
    const searchLower = search.toLowerCase();
    logs = logs.filter(l => l.message.toLowerCase().includes(searchLower));
  }

  // Return most recent first, limited
  logs = logs.slice(-limit).reverse();

  res.json({ logs, total: logs.length });
});

module.exports = router;
