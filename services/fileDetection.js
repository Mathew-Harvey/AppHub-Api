// Detects uploaded file type and returns conversion prompts for non-HTML files
const path = require('path');
const fs = require('fs');

const SUPPORTED_EXTENSIONS = ['.html', '.htm'];

const FILE_TYPE_PROMPTS = {
  '.jsx': {
    detected: 'React JSX Component',
    prompt: `I have a React JSX component that I need converted to a single, self-contained HTML file. 

Requirements:
- Everything in ONE index.html file — no separate CSS or JS files
- Inline all styles in a <style> tag
- Inline all JavaScript in a <script> tag  
- Use vanilla JavaScript instead of React (convert JSX to DOM manipulation or use a CDN-loaded React if the component is complex)
- If the component uses React hooks or state, include React + ReactDOM via CDN: https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js and https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js and https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.9/babel.min.js
- Include a proper HTML5 doctype, <head> with meta charset and viewport, and <body>
- Make it responsive and mobile-friendly
- The file should work when opened directly in a browser with no build step

Here is my JSX component:\n\n`
  },

  '.tsx': {
    detected: 'TypeScript React Component',
    prompt: `I have a TypeScript React component (TSX) that I need converted to a single, self-contained HTML file.

Requirements:
- Everything in ONE index.html file — no separate files
- Remove all TypeScript types and interfaces
- Inline all styles in a <style> tag
- Inline all JavaScript in a <script> tag
- Use vanilla JavaScript or CDN-loaded React (https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js)
- Include HTML5 doctype, proper <head>, responsive viewport meta tag
- No build step required — must work when opened in a browser
- Make it responsive

Here is my TSX component:\n\n`
  },

  '.vue': {
    detected: 'Vue.js Single File Component',
    prompt: `I have a Vue.js component that I need converted to a single, self-contained HTML file.

Requirements:
- Everything in ONE index.html file
- Load Vue via CDN: https://cdnjs.cloudflare.com/ajax/libs/vue/3.4.15/vue.global.prod.min.js
- Inline all styles in a <style> tag
- Inline all JavaScript in a <script> tag
- Include HTML5 doctype, proper <head>, responsive viewport meta tag
- No build step — must work when opened directly in a browser
- Make it responsive

Here is my Vue component:\n\n`
  },

  '.svelte': {
    detected: 'Svelte Component',
    prompt: `I have a Svelte component that I need converted to a single, self-contained HTML file.

Requirements:
- Everything in ONE index.html file — no Svelte compiler needed
- Convert all Svelte reactivity to vanilla JavaScript
- Inline all styles in a <style> tag
- Inline all JavaScript in a <script> tag
- Include HTML5 doctype, proper <head>, responsive viewport meta tag
- No build step — must work when opened directly in a browser
- Make it responsive

Here is my Svelte component:\n\n`
  },

  '.py': {
    detected: 'Python Script',
    prompt: `I have a Python script that I need converted to a single, self-contained HTML file that runs entirely in the browser.

Requirements:
- Everything in ONE index.html file
- Convert the Python logic to JavaScript
- If the script does data processing, use JavaScript equivalents
- If it generates charts, use Chart.js via CDN
- Inline all styles in a <style> tag
- Inline all JavaScript in a <script> tag
- Include HTML5 doctype, proper <head>, responsive viewport meta tag
- Create a user-friendly interface with input fields and output display
- No server required — must work when opened directly in a browser

Here is my Python script:\n\n`
  },

  '.zip': {
    detected: 'Project Archive (ZIP)',
    prompt: `I have a multi-file web project that I need consolidated into a single, self-contained HTML file.

Requirements:
- Everything in ONE index.html file — no external dependencies except CDN libraries
- Inline all CSS into a <style> tag
- Inline all JavaScript into a <script> tag
- If the project uses npm packages, replace them with CDN equivalents where possible
- If it uses a framework (React, Vue, etc.), either convert to vanilla JS or load the framework via CDN
- Include HTML5 doctype, proper <head> with meta charset and viewport
- No build step — must work when opened directly in a browser
- Preserve all functionality
- Make it responsive

Here is my project structure and code:\n\n`
  },

  '.js': {
    detected: 'JavaScript File',
    prompt: `I have a JavaScript file that I need wrapped in a single, self-contained HTML file.

Requirements:
- Everything in ONE index.html file
- Wrap the JavaScript in a <script> tag inside a complete HTML document
- Create appropriate HTML UI elements that the script interacts with
- Inline all styles in a <style> tag
- Include HTML5 doctype, proper <head> with meta charset and viewport
- No external dependencies unless loaded via CDN
- Must work when opened directly in a browser
- Make it responsive

Here is my JavaScript:\n\n`
  },

  '.ts': {
    detected: 'TypeScript File',
    prompt: `I have a TypeScript file that I need converted to a single, self-contained HTML file.

Requirements:
- Everything in ONE index.html file
- Convert TypeScript to vanilla JavaScript (remove all type annotations)
- Wrap in a <script> tag inside a complete HTML document
- Create appropriate HTML UI elements
- Inline all styles in a <style> tag
- Include HTML5 doctype, proper <head>, responsive viewport
- Must work when opened directly in a browser
- Make it responsive

Here is my TypeScript:\n\n`
  },

  '.css': {
    detected: 'CSS Stylesheet',
    prompt: `I have a CSS file but I need a complete, self-contained HTML file that uses these styles.

Please create an HTML file that:
- Includes these styles in a <style> tag
- Creates HTML elements that showcase/use the styles
- Includes any necessary JavaScript for interactive elements
- Has proper HTML5 doctype, <head>, responsive viewport
- Works when opened directly in a browser

Here are my styles:\n\n`
  },

  '.md': {
    detected: 'Markdown File',
    prompt: `I have a Markdown file that I need converted to a single, self-contained HTML file.

Requirements:
- Everything in ONE index.html file
- Convert all Markdown to properly formatted HTML
- Include clean, professional CSS styling inline in a <style> tag
- Support code blocks with syntax highlighting (use a lightweight highlighter)
- Include HTML5 doctype, proper <head>, responsive viewport
- Must work when opened directly in a browser

Here is my Markdown:\n\n`
  },

  '.json': {
    detected: 'JSON Data File',
    prompt: `I have a JSON data file that I need turned into a useful, interactive HTML tool.

Requirements:
- Everything in ONE index.html file
- Embed the JSON data directly in a <script> tag
- Create a searchable, filterable table or card view of the data
- Include sorting and filtering controls
- Inline all styles in a <style> tag
- Include HTML5 doctype, proper <head>, responsive viewport
- Must work when opened directly in a browser
- Make it look professional

Here is my JSON data:\n\n`
  }
};

function detectFileType(filename) {
  const ext = path.extname(filename).toLowerCase();
  
  if (SUPPORTED_EXTENSIONS.includes(ext)) {
    return { supported: true, extension: ext };
  }

  const typeInfo = FILE_TYPE_PROMPTS[ext];
  
  if (typeInfo) {
    return {
      supported: false,
      extension: ext,
      detected: typeInfo.detected,
      conversionPrompt: typeInfo.prompt
    };
  }

  return {
    supported: false,
    extension: ext,
    detected: `Unsupported file type (${ext})`,
    conversionPrompt: `I have a ${ext} file that I need converted to a single, self-contained HTML file.

Requirements:
- Everything in ONE index.html file
- Inline all styles in a <style> tag
- Inline all JavaScript in a <script> tag
- Include HTML5 doctype, proper <head> with meta charset and viewport
- No external dependencies unless loaded via CDN
- Must work when opened directly in a browser
- Make it responsive and professional-looking

Here is my file:\n\n`
  };
}

function validateHtmlFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const issues = [];
    
    // Check for basic HTML structure
    if (!content.includes('<html') && !content.includes('<!DOCTYPE') && !content.includes('<!doctype')) {
      // It might be a fragment — still usable but warn
      issues.push('No HTML doctype or <html> tag found — the file may be an HTML fragment');
    }

    // Check file size
    const stats = fs.statSync(filePath);
    if (stats.size > 10 * 1024 * 1024) {
      issues.push('File is larger than 10MB — consider optimizing');
    }

    return { valid: true, issues };
  } catch (err) {
    return { valid: false, issues: ['Could not read file'] };
  }
}

module.exports = { detectFileType, validateHtmlFile, SUPPORTED_EXTENSIONS };
