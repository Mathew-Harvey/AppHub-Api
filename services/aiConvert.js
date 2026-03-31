const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function convertToHtml(filename, fileContent) {
  const ext = filename.split('.').pop().toLowerCase();

  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 16000,
    messages: [{
      role: 'user',
      content: `Convert this ${ext} file into a single, self-contained HTML file.

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

Here is the file "${filename}":

\`\`\`
${fileContent}
\`\`\``
    }]
  });

  if (!message.content || message.content.length === 0) {
    throw new Error('AI conversion returned empty response');
  }

  let html = message.content[0].text.trim();

  // Strip markdown code fences if present
  if (html.startsWith('```')) {
    html = html.replace(/^```(?:html)?\n?/, '').replace(/\n?```$/, '').trim();
  }

  if (!html.includes('<!DOCTYPE') && !html.includes('<!doctype') && !html.includes('<html')) {
    throw new Error('AI conversion did not produce valid HTML');
  }

  return html;
}

module.exports = { convertToHtml };
