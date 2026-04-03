const PLANS = {
  free: {
    name: 'Free',
    maxApps: 5,
    maxMembers: 3,
    aiConversions: false,
    aiConversionsLimit: 0,
    appBuilder: false,
    builderTokenLimit: 0,
    priceMonthly: 0
  },
  team: {
    name: 'Team',
    maxApps: 50,
    maxMembers: 15,
    aiConversions: true,
    aiConversionsLimit: 20,
    appBuilder: false,
    builderTokenLimit: 0,
    priceMonthly: 1200
  },
  business: {
    name: 'Business',
    maxApps: Infinity,
    maxMembers: Infinity,
    aiConversions: true,
    aiConversionsLimit: Infinity,
    appBuilder: true,
    builderTokenLimit: 500000,
    priceMonthly: 2900
  },
  power: {
    name: 'Pro',
    maxApps: Infinity,
    maxMembers: Infinity,
    aiConversions: true,
    aiConversionsLimit: Infinity,
    appBuilder: true,
    builderTokenLimit: Infinity,
    priceMonthly: 7900
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
    aiConversionsLimit: plan.aiConversionsLimit === Infinity ? null : plan.aiConversionsLimit,
    appBuilder: plan.appBuilder,
    builderTokenLimit: plan.builderTokenLimit === Infinity ? null : plan.builderTokenLimit,
    priceMonthly: plan.priceMonthly
  };
}

function hasAppBuilder(planKey) {
  return getPlan(planKey).appBuilder === true;
}

module.exports = { PLANS, getPlan, getLimits, hasAppBuilder };
