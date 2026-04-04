const pool = require('../config/db');
const { getPlan } = require('../config/plans');

function isBypassEnabled() {
  return process.env.DEV_BYPASS_PLAN === 'true';
}

function enforceAppLimit(req, res, next) {
  if (isBypassEnabled()) return next();

  (async () => {
    try {
      const userPlan = req.user.plan || 'free';
      const plan = getPlan(userPlan);

      if (plan.maxApps === Infinity) return next();

      // Count apps across ALL workspaces owned by this user (by email) to prevent
      // bypass via multiple workspace creation
      const count = await pool.query(
        `SELECT COUNT(*) AS total FROM apps a
         JOIN users u ON a.uploaded_by = u.id
         WHERE LOWER(u.email) = LOWER($1) AND a.is_active = true AND a.is_demo = false`,
        [req.user.email]
      );

      if (parseInt(count.rows[0].total) >= plan.maxApps) {
        return res.status(403).json({
          error: 'plan_limit',
          message: `Your ${plan.name} plan allows up to ${plan.maxApps} apps across all workspaces. Upgrade your subscription for more.`,
          limit: plan.maxApps,
          current: parseInt(count.rows[0].total)
        });
      }

      next();
    } catch (err) {
      console.error('enforceAppLimit error:', err);
      res.status(500).json({ error: 'Failed to check plan limits' });
    }
  })();
}

function enforceWorkspaceLimit(req, res, next) {
  if (isBypassEnabled()) return next();

  (async () => {
    try {
      const userPlan = req.user.plan || 'free';
      const plan = getPlan(userPlan);

      if (plan.maxWorkspaces === Infinity) return next();

      // Count workspaces where this user (by email) is an admin
      const count = await pool.query(
        `SELECT COUNT(*) AS total FROM users
         WHERE LOWER(email) = LOWER($1) AND role = 'admin' AND is_active = true`,
        [req.user.email]
      );

      if (parseInt(count.rows[0].total) >= plan.maxWorkspaces) {
        return res.status(403).json({
          error: 'plan_limit',
          message: `Your ${plan.name} plan allows up to ${plan.maxWorkspaces} workspace${plan.maxWorkspaces === 1 ? '' : 's'}. Upgrade your subscription to create more.`,
          limit: plan.maxWorkspaces,
          current: parseInt(count.rows[0].total)
        });
      }

      next();
    } catch (err) {
      console.error('enforceWorkspaceLimit error:', err);
      res.status(500).json({ error: 'Failed to check workspace limits' });
    }
  })();
}

function enforceMemberLimit(req, res, next) {
  if (isBypassEnabled()) return next();

  (async () => {
    try {
      // Member limits still apply at workspace level based on the inviting user's plan
      const userPlan = req.user.plan || 'free';
      const plan = getPlan(userPlan);

      if (plan.maxMembers === Infinity) return next();

      const count = await pool.query(
        'SELECT COUNT(*) AS total FROM users WHERE workspace_id = $1 AND is_active = true',
        [req.user.workspaceId]
      );

      if (parseInt(count.rows[0].total) >= plan.maxMembers) {
        return res.status(403).json({
          error: 'plan_limit',
          message: `Your ${plan.name} plan allows up to ${plan.maxMembers} team members. Upgrade your subscription for more.`,
          limit: plan.maxMembers,
          current: parseInt(count.rows[0].total)
        });
      }

      next();
    } catch (err) {
      console.error('enforceMemberLimit error:', err);
      res.status(500).json({ error: 'Failed to check plan limits' });
    }
  })();
}

/**
 * Requires a plan with AI conversions enabled (team, business, power).
 */
function requirePaidAI(req, res, next) {
  if (isBypassEnabled()) return next();

  (async () => {
    try {
      const userPlan = req.user.plan || 'free';
      const plan = getPlan(userPlan);
      if (!plan.aiConversions) {
        return res.status(403).json({
          error: 'upgrade_required',
          message: 'This feature requires a Team plan or higher. Upgrade your subscription to access AI conversions.',
          currentPlan: userPlan
        });
      }

      next();
    } catch (err) {
      console.error('requirePaidAI error:', err);
      res.status(500).json({ error: 'Failed to check plan' });
    }
  })();
}

/**
 * Requires a plan with the AI App Builder (creator or power).
 */
function requireAppBuilder(req, res, next) {
  if (isBypassEnabled()) return next();

  (async () => {
    try {
      const userPlan = req.user.plan || 'free';
      const plan = getPlan(userPlan);
      if (!plan.appBuilder) {
        return res.status(403).json({
          error: 'upgrade_required',
          message: 'AI App Builder requires a Creator or Pro subscription.',
          currentPlan: userPlan,
          requiredPlans: ['business', 'power']
        });
      }

      next();
    } catch (err) {
      console.error('requireAppBuilder error:', err);
      res.status(500).json({ error: 'Failed to check plan' });
    }
  })();
}

const TOKEN_BUDGET_RESET_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Checks the user's monthly builder token budget.
 * Resets the counter if a month has passed.
 */
function checkTokenBudget(req, res, next) {
  if (isBypassEnabled()) return next();

  (async () => {
    try {
      const u = await pool.query(
        'SELECT plan, builder_tokens_used, builder_tokens_reset_at FROM users WHERE id = $1',
        [req.user.id]
      );
      if (u.rows.length === 0) return res.status(404).json({ error: 'User not found' });

      const row = u.rows[0];
      const userPlan = row.plan || 'free';
      const plan = getPlan(userPlan);

      if (plan.builderTokenLimit === Infinity) return next();

      const resetAt = new Date(row.builder_tokens_reset_at);
      const now = new Date();

      if (now - resetAt > TOKEN_BUDGET_RESET_MS) {
        await pool.query(
          'UPDATE users SET builder_tokens_used = 0, builder_tokens_reset_at = NOW() WHERE id = $1',
          [req.user.id]
        );
        req.builderTokensUsed = 0;
        return next();
      }

      const used = row.builder_tokens_used || 0;
      if (used >= plan.builderTokenLimit) {
        return res.status(429).json({
          error: 'token_budget_exceeded',
          message: `You've used all ${plan.builderTokenLimit.toLocaleString()} AI tokens this month. Upgrade to Pro for unlimited builds.`,
          used,
          limit: plan.builderTokenLimit,
          resetAt: new Date(resetAt.getTime() + TOKEN_BUDGET_RESET_MS).toISOString()
        });
      }

      req.builderTokensUsed = used;
      next();
    } catch (err) {
      console.error('checkTokenBudget error:', err);
      res.status(500).json({ error: 'Failed to check token budget' });
    }
  })();
}

module.exports = {
  enforceAppLimit,
  enforceMemberLimit,
  enforceWorkspaceLimit,
  requirePaidAI,
  requireAppBuilder,
  checkTokenBudget
};
