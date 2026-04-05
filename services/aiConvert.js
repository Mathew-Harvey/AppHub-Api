const Anthropic = require('@anthropic-ai/sdk');
const AdmZip = require('adm-zip');
const cheerio = require('cheerio');
const path = require('path');

const { getPlan } = require('../config/plans');
const AI_CONVERSIONS_LIMIT_FALLBACK = 50; // fallback if plan lookup fails
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Extract readable content from a ZIP buffer
function extractZipContents(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  const parts = [];
  let totalSize = 0;
  const maxSize = 200000; // ~200KB of source text to fit in context

  // Sort: prioritize source files over configs/assets
  const priority = ['.html', '.jsx', '.tsx', '.vue', '.svelte', '.js', '.ts', '.css', '.json', '.py', '.md'];
  const sorted = [...entries].sort((a, b) => {
    const extA = path.extname(a.entryName).toLowerCase();
    const extB = path.extname(b.entryName).toLowerCase();
    return (priority.indexOf(extA) === -1 ? 99 : priority.indexOf(extA)) - (priority.indexOf(extB) === -1 ? 99 : priority.indexOf(extB));
  });

  for (const entry of sorted) {
    if (entry.isDirectory) continue;
    const name = entry.entryName;
    // Skip binary files, node_modules, build output
    if (name.includes('node_modules/') || name.includes('.git/') || name.includes('dist/') || name.includes('build/')) continue;
    const ext = path.extname(name).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.wav', '.pdf'].includes(ext)) continue;

    try {
      const text = entry.getData().toString('utf-8');
      if (totalSize + text.length > maxSize) break;
      parts.push(`--- ${name} ---\n${text}`);
      totalSize += text.length;
    } catch {}
  }

  if (parts.length === 0) {
    throw new Error('No readable source files found in ZIP');
  }

  return parts.join('\n\n');
}

async function convertToHtml(filename, fileBuffer) {
  const ext = path.extname(filename).toLowerCase();
  let fileContent;

  if (ext === '.zip') {
    fileContent = extractZipContents(fileBuffer);
  } else {
    fileContent = fileBuffer.toString('utf-8');
  }

  const message = await client.messages.create({
    model: process.env.AI_CONVERT_MODEL || 'claude-sonnet-4-20250514',
    max_tokens: 16000,
    messages: [{
      role: 'user',
      content: `Convert this ${ext === '.zip' ? 'multi-file project' : ext + ' file'} into a single, self-contained HTML file.

Requirements:
- Everything in ONE index.html file — no separate CSS or JS files
- Inline all styles in <style> tags
- Inline all JavaScript in <script> tags
- If it uses a framework (React, Vue, etc), either convert to vanilla JS or load the framework via CDN
- Include a proper HTML5 doctype, <head> with meta charset and viewport, and <body>
- Make it responsive and mobile-friendly
- The file MUST work when opened directly in a browser with no build step
- Preserve all functionality from the original code
- Do NOT include any explanation — output ONLY the HTML file content, starting with <!DOCTYPE html>

${ext === '.zip' ? 'Here are the project files:' : `Here is the file "${filename}":`}

\`\`\`
${fileContent}
\`\`\``
    }]
  });

  if (!message.content || message.content.length === 0) {
    throw new Error('AI conversion returned empty response');
  }

  let html = message.content[0].text.trim();

  if (html.startsWith('```')) {
    html = html.replace(/^```(?:html)?\n?/, '').replace(/\n?```$/, '').trim();
  }

  if (!html.includes('<!DOCTYPE') && !html.includes('<!doctype') && !html.includes('<html')) {
    throw new Error('AI conversion did not produce valid HTML');
  }

  return html;
}

// Check and increment conversion count, reset monthly (user-level)
async function checkConversionQuota(pool, userId) {
  const u = await pool.query(
    'SELECT plan, ai_conversions_used, ai_conversions_reset_at FROM users WHERE id = $1',
    [userId]
  );
  if (u.rows.length === 0) return { allowed: false, used: 0, limit: 0 };

  const row = u.rows[0];
  const planDef = getPlan(row.plan || 'free');
  const limit = planDef.aiConversionsLimit === Infinity ? Infinity : (planDef.aiConversionsLimit || AI_CONVERSIONS_LIMIT_FALLBACK);

  // Unlimited conversions for business/power plans
  if (limit === Infinity) return { allowed: true, used: row.ai_conversions_used || 0, limit: null };

  const resetAt = new Date(row.ai_conversions_reset_at);
  const now = new Date();

  // Reset counter if a month has passed
  if (now - resetAt > 30 * 24 * 60 * 60 * 1000) {
    await pool.query(
      'UPDATE users SET ai_conversions_used = 0, ai_conversions_reset_at = NOW() WHERE id = $1',
      [userId]
    );
    return { allowed: true, used: 0, limit };
  }

  const used = row.ai_conversions_used || 0;
  return { allowed: used < limit, used, limit };
}

async function incrementConversionCount(pool, userId) {
  await pool.query(
    'UPDATE users SET ai_conversions_used = ai_conversions_used + 1 WHERE id = $1',
    [userId]
  );
}

/**
 * Fix identified JS errors in an HTML file using AI.
 * Extracts only the broken script blocks, fixes them, and splices back
 * into the original HTML to avoid modifying anything else.
 */
async function fixHtmlErrors(htmlContent, errors) {
  const $ = cheerio.load(htmlContent, { xmlMode: false });

  const errorsByBlock = new Map();
  for (const err of errors) {
    if (!err.scriptBlock) continue;
    if (!errorsByBlock.has(err.scriptBlock)) errorsByBlock.set(err.scriptBlock, []);
    errorsByBlock.get(err.scriptBlock).push(err);
  }

  const scriptElements = [];
  let idx = 0;
  $('script').each((_, el) => {
    const $el = $(el);
    if ($el.attr('src')) return;
    if (!$el.text().trim()) return;
    idx++;
    scriptElements.push({ index: idx, element: $el, code: $el.text() });
  });

  let fixedHtml = htmlContent;

  for (const [blockNum, blockErrors] of errorsByBlock) {
    const script = scriptElements.find(s => s.index === blockNum);
    if (!script) continue;

    const errorList = blockErrors
      .map(e => `- Line ${e.line || '?'}: ${e.message}`)
      .join('\n');

    const message = await client.messages.create({
      model: process.env.AI_CONVERT_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 64000,
      messages: [{
        role: 'user',
        content: `Fix ONLY the listed errors in this JavaScript code. Keep everything else exactly the same — same variable names, same structure, same comments. Return ONLY the corrected JavaScript code with no explanation, no markdown fences, no HTML tags.

Errors to fix:
${errorList}

JavaScript code:
${script.code}`
      }]
    });

    if (!message.content?.[0]?.text) continue;

    let fixedCode = message.content[0].text.trim();
    if (fixedCode.startsWith('```')) {
      fixedCode = fixedCode.replace(/^```(?:javascript|js)?\n?/, '').replace(/\n?```$/, '').trim();
    }

    const original = script.code;
    const pos = fixedHtml.indexOf(original);
    if (pos !== -1) {
      fixedHtml = fixedHtml.substring(0, pos) + fixedCode + fixedHtml.substring(pos + original.length);
    }
  }

  return fixedHtml;
}

module.exports = { convertToHtml, checkConversionQuota, incrementConversionCount, fixHtmlErrors };
