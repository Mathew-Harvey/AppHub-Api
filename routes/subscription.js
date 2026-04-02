const express = require('express');
const pool = require('../config/db');
const { auth, adminOnly } = require('../middleware/auth');
const { getLimits } = require('../config/plans');

const router = express.Router();

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
}

// GET /api/subscription/status — current plan, usage, and limits
router.get('/status', auth, async (req, res) => {
  try {
    const bypassPlan = process.env.DEV_BYPASS_PLAN === 'true';

    const ws = await pool.query(
      `SELECT plan, stripe_customer_id, stripe_subscription_id,
              ai_conversions_used, ai_conversions_reset_at
       FROM workspaces WHERE id = $1`,
      [req.user.workspaceId]
    );
    if (ws.rows.length === 0) return res.status(404).json({ error: 'Workspace not found' });

    const row = ws.rows[0];
    const limits = bypassPlan ? getLimits('pro') : getLimits(row.plan);

    const [appCount, memberCount] = await Promise.all([
      pool.query('SELECT COUNT(*) AS total FROM apps WHERE workspace_id = $1 AND is_active = true', [req.user.workspaceId]),
      pool.query('SELECT COUNT(*) AS total FROM users WHERE workspace_id = $1 AND is_active = true', [req.user.workspaceId])
    ]);

    res.json({
      ...limits,
      usage: {
        apps: parseInt(appCount.rows[0].total),
        members: parseInt(memberCount.rows[0].total),
        aiConversions: row.ai_conversions_used || 0,
        aiConversionsResetAt: row.ai_conversions_reset_at
      },
      hasStripeSubscription: bypassPlan ? true : !!row.stripe_subscription_id
    });
  } catch (err) {
    console.error('Subscription status error:', err);
    res.status(500).json({ error: 'Failed to get subscription status' });
  }
});

// POST /api/subscription/checkout — create Stripe Checkout session (admin only)
router.post('/checkout', auth, adminOnly, async (req, res) => {
  const stripe = getStripe();
  if (!stripe || !process.env.STRIPE_PRICE_ID) {
    return res.status(500).json({ error: 'Billing is not configured' });
  }

  try {
    const ws = await pool.query(
      'SELECT id, plan, stripe_customer_id, name FROM workspaces WHERE id = $1',
      [req.user.workspaceId]
    );
    if (ws.rows.length === 0) return res.status(404).json({ error: 'Workspace not found' });
    if (ws.rows[0].plan === 'pro') {
      return res.status(400).json({ error: 'Workspace is already on the Pro plan' });
    }

    let customerId = ws.rows[0].stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        metadata: { workspaceId: req.user.workspaceId },
        name: ws.rows[0].name,
        email: req.user.email
      });
      customerId = customer.id;
      await pool.query('UPDATE workspaces SET stripe_customer_id = $1 WHERE id = $2', [customerId, req.user.workspaceId]);
    }

    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${clientUrl}/settings?upgraded=true`,
      cancel_url: `${clientUrl}/settings?cancelled=true`,
      metadata: { workspaceId: req.user.workspaceId }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// POST /api/subscription/portal — create Stripe Customer Portal session (admin only)
router.post('/portal', auth, adminOnly, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(500).json({ error: 'Billing is not configured' });
  }

  try {
    const ws = await pool.query(
      'SELECT stripe_customer_id FROM workspaces WHERE id = $1',
      [req.user.workspaceId]
    );
    if (ws.rows.length === 0) return res.status(404).json({ error: 'Workspace not found' });
    if (!ws.rows[0].stripe_customer_id) {
      return res.status(400).json({ error: 'No billing account found. Subscribe first.' });
    }

    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';

    const session = await stripe.billingPortal.sessions.create({
      customer: ws.rows[0].stripe_customer_id,
      return_url: `${clientUrl}/settings`
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Portal error:', err);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
});

// POST /api/subscription/webhook — Stripe webhook handler (no auth, raw body)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const stripe = getStripe();
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(500).json({ error: 'Webhook not configured' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const workspaceId = session.metadata?.workspaceId;
        if (workspaceId && session.subscription) {
          await pool.query(
            `UPDATE workspaces SET plan = 'pro', stripe_subscription_id = $1, updated_at = NOW() WHERE id = $2`,
            [session.subscription, workspaceId]
          );
          console.log(`Workspace ${workspaceId} upgraded to pro`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const customerId = sub.customer;
        const isActive = ['active', 'trialing'].includes(sub.status);

        const ws = await pool.query('SELECT id FROM workspaces WHERE stripe_customer_id = $1', [customerId]);
        if (ws.rows.length > 0) {
          await pool.query(
            `UPDATE workspaces SET plan = $1, stripe_subscription_id = $2, updated_at = NOW() WHERE id = $3`,
            [isActive ? 'pro' : 'free', sub.id, ws.rows[0].id]
          );
          console.log(`Workspace ${ws.rows[0].id} subscription updated → ${isActive ? 'pro' : 'free'}`);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const customerId = sub.customer;

        const ws = await pool.query('SELECT id FROM workspaces WHERE stripe_customer_id = $1', [customerId]);
        if (ws.rows.length > 0) {
          await pool.query(
            `UPDATE workspaces SET plan = 'free', stripe_subscription_id = NULL, updated_at = NOW() WHERE id = $1`,
            [ws.rows[0].id]
          );
          console.log(`Workspace ${ws.rows[0].id} downgraded to free (subscription deleted)`);
        }
        break;
      }

      default:
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;
