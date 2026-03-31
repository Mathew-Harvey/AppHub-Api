const cheerio = require('cheerio');

const TRUNCATION_PATTERNS = [
  '// rest of',
  '/* remaining',
  '// ... more',
  '// ...more',
  '/* ... */',
  '// TODO: rest',
  '// remaining code',
  '// etc.',
  '/* etc. */',
  '// and so on',
  '// continue',
  '<!-- rest of',
  '<!-- remaining',
  '<!-- ... -->',
  '// [rest of',
  '/* [rest of',
];

function cleanLLMOutput(raw) {
  let html = raw.trim();

  // Strip markdown fences wrapping the output
  if (html.startsWith('```')) {
    html = html.replace(/^```(?:html|HTML)?\s*\n?/, '').replace(/\n?\s*```\s*$/, '').trim();
  }

  // Strip any preamble text before the DOCTYPE
  const doctypeIndex = html.search(/<!DOCTYPE\s/i);
  if (doctypeIndex > 0) {
    html = html.substring(doctypeIndex);
  }

  // Strip anything after the last </html>
  const closingHtmlMatch = html.match(/.*<\/html>/is);
  if (closingHtmlMatch) {
    html = closingHtmlMatch[0];
  }

  return html;
}

function validate(html, inputFileList) {
  const errors = [];

  // 1. Starts with <!DOCTYPE html>
  if (!/^\s*<!DOCTYPE\s+html/i.test(html)) {
    errors.push('Output does not start with <!DOCTYPE html>');
  }

  // 2. Ends with </html>
  if (!/\s*<\/html>\s*$/i.test(html)) {
    errors.push('Output does not end with </html>');
  }

  // 3. Valid HTML structure via cheerio
  let $;
  try {
    $ = cheerio.load(html);
  } catch (e) {
    errors.push(`HTML parsing error: ${e.message}`);
    return { valid: false, errors, html };
  }

  if ($('html').length === 0) errors.push('Missing <html> tag');
  if ($('head').length === 0) errors.push('Missing <head> tag');
  if ($('body').length === 0) errors.push('Missing <body> tag');

  // 4. Has content — body not empty or trivially small
  const bodyContent = $('body').html() || '';
  if (bodyContent.trim().length < 50) {
    errors.push('Body content is empty or trivially small (< 50 chars)');
  }

  // 5. JS present if input had JS files
  const inputHasJS = inputFileList.some(f => {
    const ext = f.path.split('.').pop().toLowerCase();
    return ['js', 'jsx', 'ts', 'tsx', 'vue', 'svelte'].includes(ext);
  });
  if (inputHasJS && $('script').length === 0) {
    errors.push('Input contained JavaScript/framework files but output has no <script> tags');
  }

  // 6. CSS present if input had CSS files
  const inputHasCSS = inputFileList.some(f => {
    const ext = f.path.split('.').pop().toLowerCase();
    return ext === 'css';
  });
  if (inputHasCSS && $('style').length === 0 && $('link[rel="stylesheet"]').length === 0) {
    errors.push('Input contained CSS files but output has no <style> or stylesheet <link> tags');
  }

  // 7. No markdown fences in output
  if (/```/.test(html)) {
    errors.push('Output contains markdown code fences (```)');
  }

  // 8. Check for truncation markers
  const htmlLower = html.toLowerCase();
  for (const pattern of TRUNCATION_PATTERNS) {
    if (htmlLower.includes(pattern.toLowerCase())) {
      errors.push(`Output contains truncation marker: "${pattern}"`);
      break;
    }
  }

  // 9. No explanation preamble — first meaningful chars should be <
  const firstNonWhitespace = html.trimStart().substring(0, 50);
  if (firstNonWhitespace.length > 0 && !firstNonWhitespace.startsWith('<')) {
    errors.push('Output appears to start with explanation text instead of HTML');
  }

  // 10. Reasonable size — output should be >= 20% of input manifest size
  const totalInputSize = inputFileList.reduce((sum, f) => sum + (f.size || 0), 0);
  if (totalInputSize > 0 && html.length < totalInputSize * 0.2) {
    errors.push(
      `Output size (${html.length} chars) is less than 20% of input size (${totalInputSize} chars) — likely truncated or incomplete`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    html,
  };
}

module.exports = { validate, cleanLLMOutput };
