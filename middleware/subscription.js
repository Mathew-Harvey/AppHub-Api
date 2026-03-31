const pool = require('../config/db');
const { getPlan } = require('../config/plans');

// Rejects the request if the workspace has hit its app limit for its current plan
function enforceAppLimit(req, res, next) {
  (async () => {
    try {
      const ws = await pool.query('SELECT plan FROM workspaces WHERE id = $1', [req.user.workspaceId]);
      if (ws.rows.length === 0) return res.status(404).json({ error: 'Workspace not found' });

      const plan = getPlan(ws.rows[0].plan);

      if (plan.maxApps === Infinity) return next();

      const count = await pool.query(
        'SELECT COUNT(*) AS total FROM apps WHERE workspace_id = $1 AND is_active = true AND is_demo = false',
        [req.user.workspaceId]
      );

      if (parseInt(count.rows[0].total) >= plan.maxApps) {
        return res.status(403).json({
          error: 'plan_limit',
          message: `Free plan allows up to ${plan.maxApps} apps. Upgrade to Pro for unlimited apps.`,
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

// Rejects the request if the workspace has hit its member limit for its current plan
function enforceMemberLimit(req, res, next) {
  (async () => {
    try {
      const ws = await pool.query('SELECT plan FROM workspaces WHERE id = $1', [req.user.workspaceId]);
      if (ws.rows.length === 0) return res.status(404).json({ error: 'Workspace not found' });

      const plan = getPlan(ws.rows[0].plan);

      if (plan.maxMembers === Infinity) return next();

      const count = await pool.query(
        'SELECT COUNT(*) AS total FROM users WHERE workspace_id = $1 AND is_active = true',
        [req.user.workspaceId]
      );

      if (parseInt(count.rows[0].total) >= plan.maxMembers) {
        return res.status(403).json({
          error: 'plan_limit',
          message: `Free plan allows up to ${plan.maxMembers} team members. Upgrade to Pro for unlimited members.`,
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

// Rejects the request if the workspace plan does not include AI conversions
function requirePro(req, res, next) {
  (async () => {
    try {
      const ws = await pool.query('SELECT plan FROM workspaces WHERE id = $1', [req.user.workspaceId]);
      if (ws.rows.length === 0) return res.status(404).json({ error: 'Workspace not found' });

      if (ws.rows[0].plan !== 'pro') {
        return res.status(403).json({
          error: 'upgrade_required',
          message: 'This feature requires a Pro subscription.'
        });
      }

      next();
    } catch (err) {
      console.error('requirePro error:', err);
      res.status(500).json({ error: 'Failed to check plan' });
    }
  })();
}

module.exports = { enforceAppLimit, enforceMemberLimit, requirePro };
