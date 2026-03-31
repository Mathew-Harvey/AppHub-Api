const { callLLM, estimateCost, getTierConfig } = require('./llmClient');
const { validate, cleanLLMOutput } = require('./validator');
const { estimateTokens } = require('./fileProcessor');

const SYSTEM_PROMPT = `You are a frontend build tool. Your job is to take a multi-file frontend project and consolidate it into a single, self-contained HTML file that works when opened directly in a browser.

Rules:
1. Output ONLY the HTML file content. No explanations, no markdown fences, no preamble. Start with <!DOCTYPE html> and end with </html>.
2. Inline ALL JavaScript into <script> tags. Inline ALL CSS into <style> tags.
3. Resolve all imports/requires between files. Flatten the module structure. If the project uses React/JSX, include a CDN link to React and ReactDOM (unpkg) and use Babel standalone for JSX transformation, OR pre-transform JSX into createElement calls — whichever produces cleaner output.
4. If the project uses TypeScript, strip all type annotations and convert to plain JS.
5. If the project uses Vue SFCs (.vue files), extract template/script/style and inline them.
6. If the project uses Svelte, compile components into vanilla JS.
7. For CSS frameworks (Tailwind, Bootstrap, etc.): include a CDN link to the framework stylesheet rather than inlining the entire framework.
8. For images referenced in the code: if base64 data is provided in the manifest, embed it as data URIs. If not provided, preserve the original src path and add a comment <!-- IMAGE NOT EMBEDDED: path -->.
9. Preserve all application logic, state management, event handlers, and UI behaviour.
10. The output must be a COMPLETE, WORKING HTML file. Not a fragment. Not a skeleton.
11. If you encounter a dependency that cannot be resolved (e.g., a backend API call), stub it with a comment and a mock response so the UI still renders.
12. Add a <meta charset="UTF-8"> and <meta name="viewport" content="width=device-width, initial-scale=1.0"> in the head.`;

function buildUserPrompt(manifest) {
  return `Convert this project into a single HTML file.

<file_manifest>
${manifest}
</file_manifest>`;
}

function buildTier2UserPrompt(manifest, tier1Errors, tier1Html) {
  const truncatedHtml = tier1Html && tier1Html.length > 2000
    ? tier1Html.substring(0, 2000) + '\n... [truncated]'
    : tier1Html || '[no output produced]';

  return `Convert this project into a single HTML file.

<file_manifest>
${manifest}
</file_manifest>

A previous conversion attempt failed validation with these issues:
<previous_errors>
${tier1Errors.join('\n')}
</previous_errors>

<previous_attempt>
${truncatedHtml}
</previous_attempt>

Fix these issues and produce a correct, complete single HTML file.`;
}

async function convert(manifest, fileList) {
  const startTime = Date.now();
  const warnings = [];
  const skippedImages = fileList.filter(f => f.type === 'image-skipped');
  if (skippedImages.length > 0) {
    warnings.push(
      `${skippedImages.length} image(s) not embedded (> 50KB): ${skippedImages.map(f => f.path).join(', ')}`
    );
  }

  const inputTokenEst = estimateTokens(manifest);
  const metadata = {
    tier_used: null,
    tier1_attempted: true,
    tier1_valid: null,
    tier1_errors: null,
    tier2_attempted: false,
    tier2_valid: null,
    input_files: fileList.length,
    input_tokens_est: inputTokenEst,
    output_size_bytes: 0,
    processing_time_ms: 0,
    cost_estimate_usd: 0,
  };

  // ── Tier 1 ──
  let tier1Result = null;
  let tier1Validation = null;
  let tier1Cost = 0;

  try {
    const userPrompt = buildUserPrompt(manifest);
    tier1Result = await callLLM(1, SYSTEM_PROMPT, userPrompt);
    const cleaned = cleanLLMOutput(tier1Result.text);
    tier1Validation = validate(cleaned, fileList);
    tier1Cost = estimateCost(1, tier1Result.inputTokens, tier1Result.outputTokens);

    metadata.tier1_valid = tier1Validation.valid;
    metadata.cost_estimate_usd += tier1Cost;

    if (tier1Validation.valid) {
      metadata.tier_used = 1;
      metadata.output_size_bytes = Buffer.byteLength(tier1Validation.html, 'utf-8');
      metadata.processing_time_ms = Date.now() - startTime;
      return {
        success: true,
        html: tier1Validation.html,
        metadata,
        warnings,
        _log: {
          tier: 1,
          model: getTierConfig(1).model,
          inputTokens: tier1Result.inputTokens,
          outputTokens: tier1Result.outputTokens,
          cost: tier1Cost,
          valid: true,
          errors: null,
        },
      };
    }

    metadata.tier1_errors = tier1Validation.errors;
  } catch (err) {
    console.error('Tier 1 LLM error:', err.message);
    metadata.tier1_valid = false;
    metadata.tier1_errors = [err.message];
    tier1Validation = { valid: false, errors: [err.message], html: '' };
  }

  // ── Tier 2 ──
  metadata.tier2_attempted = true;
  let tier2Result = null;
  let tier2Validation = null;

  try {
    const userPrompt = buildTier2UserPrompt(
      manifest,
      tier1Validation?.errors || ['Tier 1 produced no output'],
      tier1Validation?.html || ''
    );
    tier2Result = await callLLM(2, SYSTEM_PROMPT, userPrompt);
    const cleaned = cleanLLMOutput(tier2Result.text);
    tier2Validation = validate(cleaned, fileList);
    const tier2Cost = estimateCost(2, tier2Result.inputTokens, tier2Result.outputTokens);

    metadata.tier2_valid = tier2Validation.valid;
    metadata.tier_used = 2;
    metadata.cost_estimate_usd += tier2Cost;
    metadata.output_size_bytes = Buffer.byteLength(tier2Validation.html, 'utf-8');
    metadata.processing_time_ms = Date.now() - startTime;

    if (tier2Validation.valid) {
      return {
        success: true,
        html: tier2Validation.html,
        metadata,
        warnings,
        _log: {
          tier: 2,
          model: getTierConfig(2).model,
          inputTokens: tier2Result.inputTokens,
          outputTokens: tier2Result.outputTokens,
          cost: tier2Cost,
          valid: true,
          errors: null,
        },
      };
    }

    // Tier 2 also failed validation — return HTML with warnings
    warnings.push(...tier2Validation.errors.map(e => `Validation warning: ${e}`));
    return {
      success: true,
      html: tier2Validation.html,
      metadata,
      warnings,
      _log: {
        tier: 2,
        model: getTierConfig(2).model,
        inputTokens: tier2Result.inputTokens,
        outputTokens: tier2Result.outputTokens,
        cost: tier2Cost,
        valid: false,
        errors: tier2Validation.errors,
      },
    };
  } catch (err) {
    console.error('Tier 2 LLM error:', err.message);
    metadata.tier2_valid = false;
    metadata.processing_time_ms = Date.now() - startTime;
    return {
      success: false,
      html: null,
      metadata,
      warnings,
      error: 'Both conversion tiers failed. Please try again or simplify your project.',
      _log: {
        tier: 2,
        model: getTierConfig(2)?.model || 'unknown',
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        valid: false,
        errors: [err.message],
      },
    };
  }
}

module.exports = { convert };
