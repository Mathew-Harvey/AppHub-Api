const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const TIER_CONFIG = {
  1: {
    provider: process.env.TIER1_PROVIDER || 'gemini',
    model: process.env.TIER1_MODEL || 'gemini-2.5-flash',
    apiKey: () => process.env.TIER1_API_KEY || process.env.GEMINI_API_KEY,
    maxTokens: parseInt(process.env.TIER1_MAX_TOKENS) || 65536,
    costPer1kInput: parseFloat(process.env.TIER1_COST_INPUT) || 0.00015,
    costPer1kOutput: parseFloat(process.env.TIER1_COST_OUTPUT) || 0.0006,
  },
  2: {
    provider: process.env.TIER2_PROVIDER || 'anthropic',
    model: process.env.TIER2_MODEL || 'claude-sonnet-4-6-20250514',
    apiKey: () => process.env.TIER2_API_KEY || process.env.ANTHROPIC_API_KEY,
    maxTokens: parseInt(process.env.TIER2_MAX_TOKENS) || 64000,
    costPer1kInput: parseFloat(process.env.TIER2_COST_INPUT) || 0.003,
    costPer1kOutput: parseFloat(process.env.TIER2_COST_OUTPUT) || 0.015,
  },
};

const TIMEOUT_MS = 120_000;
const MAX_RETRIES = 3;

function getTierConfig(tier) {
  return TIER_CONFIG[tier];
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callWithRetry(fn, retries = MAX_RETRIES) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isRateLimit = err.status === 429 || err.code === 429 ||
        (err.message && err.message.toLowerCase().includes('rate limit'));
      const isServerError = err.status >= 500;

      if (attempt < retries && (isRateLimit || isServerError)) {
        const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 16000);
        const jitter = Math.random() * 1000;
        console.log(`LLM retry ${attempt}/${retries} after ${backoff + jitter}ms (${err.message || err.status})`);
        await sleep(backoff + jitter);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

async function callAnthropic(config, systemPrompt, userPrompt) {
  const client = new Anthropic({ apiKey: config.apiKey() });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await client.messages.create({
      model: config.model,
      max_tokens: config.maxTokens,
      temperature: 0.1,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }, { signal: controller.signal });

    const text = response.content?.[0]?.text || '';
    return {
      text,
      inputTokens: response.usage?.input_tokens || 0,
      outputTokens: response.usage?.output_tokens || 0,
      stopReason: response.stop_reason,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function callGemini(config, systemPrompt, userPrompt) {
  const genAI = new GoogleGenerativeAI(config.apiKey());
  const model = genAI.getGenerativeModel({
    model: config.model,
    systemInstruction: systemPrompt,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        maxOutputTokens: config.maxTokens,
        temperature: 0.1,
      },
    });

    const response = result.response;
    const text = response.text() || '';
    const usage = response.usageMetadata || {};

    return {
      text,
      inputTokens: usage.promptTokenCount || 0,
      outputTokens: usage.candidatesTokenCount || 0,
      stopReason: response.candidates?.[0]?.finishReason || 'unknown',
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function callOpenAICompatible(config, systemPrompt, userPrompt, baseUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey()}`,
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: config.maxTokens,
        temperature: 0.1,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      const err = new Error(`OpenAI-compatible API error: ${response.status} ${body}`);
      err.status = response.status;
      throw err;
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';

    return {
      text,
      inputTokens: data.usage?.prompt_tokens || 0,
      outputTokens: data.usage?.completion_tokens || 0,
      stopReason: data.choices?.[0]?.finish_reason || 'unknown',
    };
  } finally {
    clearTimeout(timeout);
  }
}

const PROVIDER_URLS = {
  openai: 'https://api.openai.com/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/v1/chat/completions',
};

async function callLLM(tier, systemPrompt, userPrompt) {
  const config = getTierConfig(tier);
  if (!config) throw new Error(`Unknown tier: ${tier}`);

  const apiKey = config.apiKey();
  if (!apiKey) throw new Error(`No API key configured for tier ${tier} (${config.provider})`);

  return callWithRetry(async () => {
    switch (config.provider) {
      case 'anthropic':
        return callAnthropic(config, systemPrompt, userPrompt);
      case 'gemini':
        return callGemini(config, systemPrompt, userPrompt);
      case 'openai':
        return callOpenAICompatible(config, systemPrompt, userPrompt, PROVIDER_URLS.openai);
      case 'deepseek':
        return callOpenAICompatible(config, systemPrompt, userPrompt, PROVIDER_URLS.deepseek);
      default:
        throw new Error(`Unsupported LLM provider: ${config.provider}`);
    }
  });
}

function estimateCost(tier, inputTokens, outputTokens) {
  const config = getTierConfig(tier);
  if (!config) return 0;
  return (inputTokens / 1000) * config.costPer1kInput + (outputTokens / 1000) * config.costPer1kOutput;
}

module.exports = { callLLM, getTierConfig, estimateCost };
