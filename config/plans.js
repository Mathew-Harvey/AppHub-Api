const PLANS = {
  free: {
    name: 'Free',
    maxApps: 3,
    maxMembers: 3,
    aiConversions: false,
    aiConversionsLimit: 0,
    priceMonthly: 0
  },
  pro: {
    name: 'Pro',
    maxApps: Infinity,
    maxMembers: Infinity,
    aiConversions: true,
    aiConversionsLimit: 50,
    priceMonthly: 1200 // cents
  }
};

function getPlan(planKey) {
  return PLANS[planKey] || PLANS.free;
}

function getLimits(planKey) {
  const plan = getPlan(planKey);
  return {
    plan: planKey || 'free',
    planName: plan.name,
    maxApps: plan.maxApps === Infinity ? null : plan.maxApps,
    maxMembers: plan.maxMembers === Infinity ? null : plan.maxMembers,
    aiConversions: plan.aiConversions,
    aiConversionsLimit: plan.aiConversionsLimit,
    priceMonthly: plan.priceMonthly
  };
}

module.exports = { PLANS, getPlan, getLimits };
