const Anthropic = require('@anthropic-ai/sdk');
const AdmZip = require('adm-zip');
const path = require('path');

const AI_CONVERSIONS_LIMIT = 50; // per month per workspace
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

// Check and increment conversion count, reset monthly
async function checkConversionQuota(pool, workspaceId) {
  const ws = await pool.query(
    'SELECT ai_conversions_used, ai_conversions_reset_at FROM workspaces WHERE id = $1',
    [workspaceId]
  );
  if (ws.rows.length === 0) return { allowed: false, used: 0, limit: AI_CONVERSIONS_LIMIT };

  const row = ws.rows[0];
  const resetAt = new Date(row.ai_conversions_reset_at);
  const now = new Date();

  // Reset counter if a month has passed
  if (now - resetAt > 30 * 24 * 60 * 60 * 1000) {
    await pool.query(
      'UPDATE workspaces SET ai_conversions_used = 0, ai_conversions_reset_at = NOW() WHERE id = $1',
      [workspaceId]
    );
    return { allowed: true, used: 0, limit: AI_CONVERSIONS_LIMIT };
  }

  const used = row.ai_conversions_used || 0;
  return { allowed: used < AI_CONVERSIONS_LIMIT, used, limit: AI_CONVERSIONS_LIMIT };
}

async function incrementConversionCount(pool, workspaceId) {
  await pool.query(
    'UPDATE workspaces SET ai_conversions_used = ai_conversions_used + 1 WHERE id = $1',
    [workspaceId]
  );
}

module.exports = { convertToHtml, checkConversionQuota, incrementConversionCount };
