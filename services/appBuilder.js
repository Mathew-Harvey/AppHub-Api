const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../config/db');
const { getPlan } = require('../config/plans');
const { validateHtmlErrors } = require('./htmlValidator');
const { cleanLLMOutput } = require('./validator');

const BUILDER_MODEL = process.env.BUILDER_MODEL || 'claude-sonnet-4-20250514';
const BUILDER_MAX_TOKENS = parseInt(process.env.BUILDER_MAX_TOKENS) || 64000;
const TOKEN_BUDGET_RESET_MS = 30 * 24 * 60 * 60 * 1000;

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// ─── Master system prompt (cached across calls) ─────────────────────────────

const SYSTEM_PROMPT = `You are an expert web developer building self-contained HTML applications for a no-code app platform called AppHub.

CRITICAL OUTPUT RULES:
- Output ONLY a single HTML file, starting with <!DOCTYPE html> and ending with </html>
- No markdown fences, no explanations, no preamble, no commentary before or after the HTML
- ALL CSS must be in <style> tags inside the document
- ALL JavaScript must be in <script> tags inside the document
- Include a proper HTML5 doctype, <head> with meta charset and viewport, and <body>

TECHNICAL REQUIREMENTS:
- Use modern CSS: flexbox, grid, custom properties, smooth transitions
- Use vanilla JavaScript (ES2020+). No frameworks, no build step required
- Must work when opened directly in a browser with zero dependencies
- Responsive and mobile-friendly — use fluid layouts and media queries
- Accessible: semantic HTML, proper ARIA labels, keyboard navigation

QUALITY STANDARDS:
- Thoughtful, polished UI with hover effects, focus states, and micro-animations
- Proper error handling and edge cases in JavaScript
- Loading states and empty states where appropriate
- Use system font stack for performance: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif

SECURITY CONSTRAINTS:
- Do NOT make any fetch() or XMLHttpRequest calls to external APIs
- Do NOT access document.cookie or parent window references
- Do NOT include any analytics, tracking, or third-party scripts
- Do NOT use eval() or Function() constructors
- localStorage and sessionStorage are allowed for app state persistence within the sandbox

When editing existing code on revisions, change ONLY what is necessary. Preserve all existing functionality, variable names, comments, and structure. Never rewrite from scratch.`;

// ─── Prompt construction ─────────────────────────────────────────────────────

function buildUserPrompt(session) {
  const parts = [`Build me a ${session.app_type || 'web application'} called "${session.name}".`];

  if (session.description) {
    parts.push(`\nDescription: ${session.description}`);
  }

  const features = session.features || [];
  if (features.length > 0) {
    parts.push('\nRequired Features (implement ALL of these):');
    features.forEach((f, i) => parts.push(`${i + 1}. ${f}`));
  }

  const style = session.style_preferences || {};
  const styleParts = [];
  if (style.colorScheme) styleParts.push(`Color scheme: ${style.colorScheme}`);
  if (style.layoutStyle) styleParts.push(`Layout: ${style.layoutStyle}`);
  if (style.fontStyle) styleParts.push(`Font style: ${style.fontStyle}`);
  if (styleParts.length > 0) {
    parts.push(`\nVisual Style:\n${styleParts.join('\n')}`);
  }

  if (session.target_audience) {
    parts.push(`\nTarget audience: ${session.target_audience}`);
  }

  if (session.additional_notes) {
    parts.push(`\nAdditional notes: ${session.additional_notes}`);
  }

  return parts.join('\n');
}

function buildRevisionPrompt(userFeedback) {
  return `The user has reviewed the app and wants the following changes. Edit the EXISTING code to address ONLY this feedback. Do NOT rewrite from scratch. Preserve all existing functionality, variable names, and structure. Change the minimum amount of code necessary.

User feedback:
${userFeedback}

Output the complete updated HTML file with the changes applied.`;
}

// ─── LLM call with prompt caching (streaming) ───────────────────────────────

async function callWithCache(systemText, userParts) {
  const client = getClient();

  const stream = await client.messages.stream({
    model: BUILDER_MODEL,
    max_tokens: BUILDER_MAX_TOKENS,
    system: [
      {
        type: 'text',
        text: systemText,
        cache_control: { type: 'ephemeral' }
      }
    ],
    messages: [{
      role: 'user',
      content: userParts.map((part) => {
        const block = { type: 'text', text: part.text };
        if (part.cache) {
          block.cache_control = { type: 'ephemeral' };
        }
        return block;
      })
    }]
  });

  const response = await stream.finalMessage();

  const text = response.content?.[0]?.text || '';
  const usage = response.usage || {};

  return {
    text,
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    cacheReadTokens: usage.cache_read_input_tokens || 0,
    cacheCreationTokens: usage.cache_creation_input_tokens || 0
  };
}

// ─── Self-review ─────────────────────────────────────────────────────────────

const REVIEW_SYSTEM = `You are a QA reviewer for web applications. You will be given an HTML app and the original requirements. Your job is to check whether the app meets ALL requirements.

Respond with a JSON object (no markdown fences):
- If everything is correct: {"approved": true, "notes": []}
- If there are issues: {"approved": false, "notes": ["issue 1", "issue 2", ...], "fixes": "description of what needs to be fixed"}

Only flag genuine missing features or broken functionality. Do not flag minor style preferences.`;

async function selfReview(html, session, onTokens) {
  const spec = buildUserPrompt(session);

  const result = await callWithCache(REVIEW_SYSTEM, [
    { text: `Original requirements:\n${spec}`, cache: true },
    { text: `Generated HTML app:\n${html}`, cache: false }
  ]);

  if (onTokens) await onTokens(result);

  let review;
  try {
    const cleaned = result.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    review = JSON.parse(cleaned);
  } catch {
    review = { approved: true, notes: ['Review parse failed — treating as approved'] };
  }

  return { review };
}

// ─── Fix pass (when review finds issues) ─────────────────────────────────────

async function applyFixes(html, review, session, onTokens) {
  const fixPrompt = `The following issues were found during review:
${review.notes.map((n, i) => `${i + 1}. ${n}`).join('\n')}

${review.fixes || 'Fix all listed issues.'}

Edit the existing code to fix ONLY these issues. Do NOT rewrite from scratch. Output the complete corrected HTML file.`;

  const result = await callWithCache(SYSTEM_PROMPT, [
    { text: html, cache: true },
    { text: fixPrompt, cache: false }
  ]);

  if (onTokens) await onTokens(result);

  return { html: cleanLLMOutput(result.text) };
}

// ─── Main build flow ─────────────────────────────────────────────────────────

/**
 * @param {object} session - DB row from builder_sessions
 * @param {object} opts
 * @param {string} opts.jobId - builder_jobs row id
 * @param {string} opts.userId - user id for token tracking
 */
async function buildApp(session, { jobId, userId } = {}) {
  const userPrompt = buildUserPrompt(session);

  const onTokens = jobId ? makeTokenTracker(jobId, userId, session.id) : null;

  // Step 1: Generate the app
  const genResult = await callWithCache(SYSTEM_PROMPT, [
    { text: userPrompt, cache: true }
  ]);

  if (onTokens) await onTokens(genResult);

  let html = cleanLLMOutput(genResult.text);

  if (!html.includes('<!DOCTYPE') && !html.includes('<!doctype') && !html.includes('<html')) {
    throw new Error('AI generation did not produce valid HTML');
  }

  // Step 2: Validate for JS errors
  const codeErrors = validateHtmlErrors(html);
  const blockingErrors = codeErrors.filter(e => e.type !== 'tdz_warning');

  // Step 3: Self-review against requirements
  const { review } = await selfReview(html, session, onTokens);

  // Step 4: If review found issues or there are code errors, do a fix pass
  const needsFix = !review.approved || blockingErrors.length > 0;
  if (needsFix) {
    const combinedReview = { ...review };
    if (blockingErrors.length > 0) {
      combinedReview.notes = [
        ...(combinedReview.notes || []),
        ...blockingErrors.map(e => `JavaScript error in script block ${e.scriptBlock}: ${e.message}`)
      ];
      combinedReview.approved = false;
    }

    const fixResult = await applyFixes(html, combinedReview, session, onTokens);
    html = fixResult.html;
  }

  return {
    html,
    reviewNotes: review.notes || [],
    approved: review.approved,
    fixed: needsFix
  };
}

// ─── Revision flow ───────────────────────────────────────────────────────────

async function reviseApp(existingHtml, userFeedback, session, { jobId, userId } = {}) {
  const revisionPrompt = buildRevisionPrompt(userFeedback);

  const onTokens = jobId ? makeTokenTracker(jobId, userId, session.id) : null;

  const genResult = await callWithCache(SYSTEM_PROMPT, [
    { text: existingHtml, cache: true },
    { text: revisionPrompt, cache: false }
  ]);

  if (onTokens) await onTokens(genResult);

  let html = cleanLLMOutput(genResult.text);

  if (!html.includes('<!DOCTYPE') && !html.includes('<!doctype') && !html.includes('<html')) {
    throw new Error('AI revision did not produce valid HTML');
  }

  // Self-review the revision
  const { review } = await selfReview(html, session, onTokens);

  // Fix pass if needed
  if (!review.approved) {
    const fixResult = await applyFixes(html, review, session, onTokens);
    html = fixResult.html;
  }

  return {
    html,
    reviewNotes: review.notes || [],
    approved: review.approved
  };
}

// ─── Incremental token tracker ───────────────────────────────────────────────

/**
 * Returns a callback that updates the DB after each LLM call.
 * Updates both the builder_jobs row (for polling) and the workspace budget.
 */
function makeTokenTracker(jobId, userId, sessionId) {
  return async function onTokens(result) {
    const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } = result;

    try {
      await Promise.all([
        pool.query(
          `UPDATE builder_jobs
           SET input_tokens = input_tokens + $1, output_tokens = output_tokens + $2,
               cache_read_tokens = cache_read_tokens + $3, cache_creation_tokens = cache_creation_tokens + $4
           WHERE id = $5`,
          [inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, jobId]
        ),
        pool.query(
          'UPDATE users SET builder_tokens_used = builder_tokens_used + $1 WHERE id = $2',
          [outputTokens, userId]
        ),
        pool.query(
          'UPDATE builder_sessions SET total_tokens_used = total_tokens_used + $1 WHERE id = $2',
          [outputTokens, sessionId]
        )
      ]);
    } catch (err) {
      console.error('Token tracking update failed:', err.message);
    }
  };
}

// ─── Token budget helpers ────────────────────────────────────────────────────

async function getTokenUsage(userId) {
  const u = await pool.query(
    'SELECT plan, builder_tokens_used, builder_tokens_reset_at FROM users WHERE id = $1',
    [userId]
  );
  if (u.rows.length === 0) return null;

  const row = u.rows[0];
  const effectivePlan = process.env.DEV_BYPASS_PLAN === 'true' ? 'power' : (row.plan || 'free');
  const plan = getPlan(effectivePlan);
  const resetAt = new Date(row.builder_tokens_reset_at);
  const now = new Date();

  let used = row.builder_tokens_used || 0;

  if (now - resetAt > TOKEN_BUDGET_RESET_MS) {
    await pool.query(
      'UPDATE users SET builder_tokens_used = 0, builder_tokens_reset_at = NOW() WHERE id = $1',
      [userId]
    );
    used = 0;
  }

  const limit = plan.builderTokenLimit;
  const unlimited = limit === Infinity;

  return {
    used,
    limit: unlimited ? null : limit,
    remaining: unlimited ? null : Math.max(0, limit - used),
    percentage: unlimited ? 0 : (limit > 0 ? Math.round((used / limit) * 10000) / 100 : 0),
    resetAt: new Date(resetAt.getTime() + TOKEN_BUDGET_RESET_MS).toISOString(),
    plan: effectivePlan,
    unlimited
  };
}

// ─── Complexity assessment ───────────────────────────────────────────────────

function assessComplexity(session) {
  const features = session.features || [];
  const desc = session.description || '';

  let score = 0;
  if (session.complexity === 'complex') score += 3;
  if (session.complexity === 'moderate') score += 1;
  if (features.length > 10) score += 2;
  if (features.length > 5) score += 1;
  if (desc.length > 500) score += 1;
  if (session.app_type === 'dashboard') score += 1;

  if (score >= 4) {
    return {
      level: 'high',
      warning: 'This is a complex app. For best results with very complex applications, consider using Claude Opus or the latest ChatGPT to build it, then upload the HTML file directly to AppHub.'
    };
  }
  if (score >= 2) {
    return { level: 'medium', warning: null };
  }
  return { level: 'low', warning: null };
}

module.exports = {
  buildApp,
  reviseApp,
  getTokenUsage,
  assessComplexity,
  buildUserPrompt
};
