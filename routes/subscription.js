const express = require('express');
const pool = require('../config/db');
const { auth, adminOnly } = require('../middleware/auth');
const { getLimits, getPlan } = require('../config/plans');

const router = express.Router();

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
}

/**
 * Maps a Stripe price ID to a plan key. Configure via env vars:
 *   STRIPE_PRICE_TEAM=price_xxx
 *   STRIPE_PRICE_BUSINESS=price_yyy
 *   STRIPE_PRICE_POWER=price_zzz
 * Falls back to STRIPE_PRICE_ID -> 'team' for single-price setups.
 */
function planFromPriceId(priceId) {
  if (priceId === process.env.STRIPE_PRICE_POWER) return 'power';
  if (priceId === process.env.STRIPE_PRICE_BUSINESS) return 'business';
  if (priceId === process.env.STRIPE_PRICE_TEAM) return 'team';
  if (priceId === process.env.STRIPE_PRICE_ID) return 'team';
  return 'team';
}

function extractPriceId(subscription) {
  return subscription.items?.data?.[0]?.price?.id || null;
}

// GET /api/subscription/status
router.get('/status', auth, async (req, res) => {
  try {
    const bypassPlan = process.env.DEV_BYPASS_PLAN === 'true';

    const ws = await pool.query(
      `SELECT plan, stripe_customer_id, stripe_subscription_id,
              ai_conversions_used, ai_conversions_reset_at,
              builder_tokens_used, builder_tokens_reset_at
       FROM workspaces WHERE id = $1`,
      [req.user.workspaceId]
    );
    if (ws.rows.length === 0) return res.status(404).json({ error: 'Workspace not found' });

    const row = ws.rows[0];
    const effectivePlan = bypassPlan ? 'power' : row.plan;
    const limits = getLimits(effectivePlan);
    const planDef = getPlan(effectivePlan);

    const [appCount, memberCount] = await Promise.all([
      pool.query('SELECT COUNT(*) AS total FROM apps WHERE workspace_id = $1 AND is_active = true', [req.user.workspaceId]),
      pool.query('SELECT COUNT(*) AS total FROM users WHERE workspace_id = $1 AND is_active = true', [req.user.workspaceId])
    ]);

    const builderUsed = row.builder_tokens_used || 0;
    const builderLimit = planDef.builderTokenLimit;

    res.json({
      ...limits,
      usage: {
        apps: parseInt(appCount.rows[0].total),
        members: parseInt(memberCount.rows[0].total),
        aiConversions: row.ai_conversions_used || 0,
        aiConversionsResetAt: row.ai_conversions_reset_at,
        builderTokensUsed: builderUsed,
        builderTokensLimit: builderLimit === Infinity ? null : builderLimit,
        builderTokensResetAt: row.builder_tokens_reset_at,
        builderTokensPercentage: builderLimit === Infinity ? 0 : (builderLimit > 0 ? Math.round((builderUsed / builderLimit) * 10000) / 100 : 0)
      },
      hasStripeSubscription: bypassPlan ? true : !!row.stripe_subscription_id
    });
  } catch (err) {
    console.error('Subscription status error:', err);
    res.status(500).json({ error: 'Failed to get subscription status' });
  }
});

// GET /api/subscription/checkout-landing?plan=team|business|power
// Public endpoint for landing page — creates Stripe Checkout before registration
router.get('/checkout-landing', async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(500).json({ error: 'Billing is not configured' });

  const { plan } = req.query;
  const validPlans = ['team', 'business', 'power'];
  if (!plan || !validPlans.includes(plan)) {
    return res.status(400).json({ error: 'Invalid plan. Use: team, business, or power' });
  }

  const priceId = plan === 'power' ? process.env.STRIPE_PRICE_POWER
    : plan === 'business' ? process.env.STRIPE_PRICE_BUSINESS
    : process.env.STRIPE_PRICE_TEAM || process.env.STRIPE_PRICE_ID;

  if (!priceId) return res.status(500).json({ error: 'No Stripe price configured for this plan' });

  try {
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    const landingUrl = process.env.LANDING_URL || 'https://my-app-hub.com';

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${clientUrl}/register?stripe_session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${landingUrl}/#pricing`,
      metadata: { plan }
    });

    res.redirect(303, session.url);
  } catch (err) {
    console.error('Landing checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// GET /api/subscription/verify-session?session_id=xxx — verify a completed Stripe session (public)
router.get('/verify-session', async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(500).json({ error: 'Billing is not configured' });

  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'session_id is required' });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Session is not paid', paymentStatus: session.payment_status });
    }

    const plan = session.metadata?.plan || 'team';
    res.json({ valid: true, plan, email: session.customer_details?.email || null });
  } catch (err) {
    console.error('Verify session error:', err);
    res.status(400).json({ error: 'Invalid session' });
  }
});

// POST /api/subscription/checkout
router.post('/checkout', auth, adminOnly, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(500).json({ error: 'Billing is not configured' });
  }

  const { planKey } = req.body;
  const priceId = planKey === 'power' ? process.env.STRIPE_PRICE_POWER
    : planKey === 'business' ? process.env.STRIPE_PRICE_BUSINESS
    : process.env.STRIPE_PRICE_TEAM || process.env.STRIPE_PRICE_ID;

  if (!priceId) {
    return res.status(500).json({ error: 'No Stripe price configured for this plan' });
  }

  try {
    const ws = await pool.query(
      'SELECT id, plan, stripe_customer_id, name FROM workspaces WHERE id = $1',
      [req.user.workspaceId]
    );
    if (ws.rows.length === 0) return res.status(404).json({ error: 'Workspace not found' });

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
      line_items: [{ price: priceId, quantity: 1 }],
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

// POST /api/subscription/portal
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

// POST /api/subscription/webhook
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
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          const plan = planFromPriceId(extractPriceId(sub));
          await pool.query(
            `UPDATE workspaces SET plan = $1, stripe_subscription_id = $2, updated_at = NOW() WHERE id = $3`,
            [plan, session.subscription, workspaceId]
          );
          console.log(`Workspace ${workspaceId} upgraded to ${plan}`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const customerId = sub.customer;
        const isActive = ['active', 'trialing'].includes(sub.status);

        const ws = await pool.query('SELECT id FROM workspaces WHERE stripe_customer_id = $1', [customerId]);
        if (ws.rows.length > 0) {
          const plan = isActive ? planFromPriceId(extractPriceId(sub)) : 'free';
          await pool.query(
            `UPDATE workspaces SET plan = $1, stripe_subscription_id = $2, updated_at = NOW() WHERE id = $3`,
            [plan, sub.id, ws.rows[0].id]
          );
          console.log(`Workspace ${ws.rows[0].id} subscription updated -> ${plan}`);
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
