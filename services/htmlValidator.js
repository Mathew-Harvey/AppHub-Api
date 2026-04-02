const cheerio = require('cheerio');
const acorn = require('acorn');

/**
 * Validates HTML content for JavaScript errors (syntax errors, TDZ issues)
 * that would prevent it from running in the browser.
 *
 * Returns { errors: [{ type, message, line, scriptBlock }] }
 */
function validateHtmlErrors(htmlContent) {
  const errors = [];
  const $ = cheerio.load(htmlContent, { xmlMode: false });

  const handlerFunctions = collectEventHandlerFunctions($);

  let scriptIndex = 0;
  $('script').each((_, el) => {
    const $el = $(el);
    if ($el.attr('src')) return;
    const code = $el.text();
    if (!code.trim()) return;

    scriptIndex++;
    const blockNum = scriptIndex;
    const scriptType = ($el.attr('type') || '').toLowerCase();

    if (scriptType && scriptType !== 'module' &&
        scriptType !== 'text/javascript' &&
        scriptType !== 'application/javascript') {
      return;
    }

    const isModule = scriptType === 'module';

    let ast;
    try {
      ast = acorn.parse(code, {
        ecmaVersion: 'latest',
        sourceType: isModule ? 'module' : 'script',
        locations: true,
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: !isModule,
      });
    } catch (e) {
      errors.push({
        type: 'syntax_error',
        message: e.message.replace(/\s*\(\d+:\d+\)\s*$/, ''),
        line: e.loc?.line || null,
        scriptBlock: blockNum,
      });
      return;
    }

    const tdzIssues = analyzeScopeTDZ(ast.body, handlerFunctions);
    for (const issue of tdzIssues) {
      errors.push({ ...issue, scriptBlock: blockNum });
    }
  });

  return errors;
}

/**
 * Collect function names referenced in inline event handlers (onclick, onload, etc.).
 */
function collectEventHandlerFunctions($) {
  const names = new Set();
  $('*').each((_, el) => {
    for (const [attr, val] of Object.entries(el.attribs || {})) {
      if (attr.startsWith('on') && val) {
        for (const m of val.matchAll(/\b([a-zA-Z_$][\w$]*)\s*\(/g)) {
          names.add(m[1]);
        }
      }
    }
  });
  return names;
}

/**
 * Analyze top-level statements for TDZ issues:
 * 1. Direct synchronous references to const/let variables before their declaration
 * 2. Function calls that trigger TDZ via the called function's body
 * 3. Event handler functions that reference variables vulnerable to TDZ
 */
function analyzeScopeTDZ(statements, handlerFunctions) {
  const issues = [];

  const declMap = new Map();
  for (const stmt of statements) {
    if (stmt.type === 'VariableDeclaration' && (stmt.kind === 'const' || stmt.kind === 'let')) {
      for (const d of stmt.declarations) {
        if (d.id?.type === 'Identifier') {
          declMap.set(d.id.name, { kind: stmt.kind, line: stmt.loc.start.line, pos: stmt.start });
        }
      }
    }
  }

  if (declMap.size === 0) return issues;

  const funcVarRefs = new Map();
  for (const stmt of statements) {
    if (stmt.type === 'FunctionDeclaration' && stmt.id) {
      const refs = collectAllIdentifiers(stmt.body);
      const relevant = new Set([...refs].filter(r => declMap.has(r)));
      if (relevant.size > 0) {
        funcVarRefs.set(stmt.id.name, relevant);
      }
    }
  }

  const initialized = new Set();
  const reported = new Set();

  for (const stmt of statements) {
    if (stmt.type === 'VariableDeclaration' && (stmt.kind === 'const' || stmt.kind === 'let')) {
      for (const d of stmt.declarations) {
        if (d.id?.type === 'Identifier') initialized.add(d.id.name);
      }
      continue;
    }

    if (stmt.type === 'FunctionDeclaration') continue;

    const syncRefs = collectSyncIdentifiers(stmt);
    for (const name of syncRefs) {
      if (declMap.has(name) && !initialized.has(name) && !reported.has(name)) {
        const decl = declMap.get(name);
        issues.push({
          type: 'tdz_error',
          message: `'${name}' (${decl.kind}) is accessed before its declaration on line ${decl.line}`,
          line: stmt.loc.start.line,
        });
        reported.add(name);
      }
    }

    const called = collectCalledFunctionNames(stmt);
    for (const funcName of called) {
      if (!funcVarRefs.has(funcName)) continue;
      for (const varName of funcVarRefs.get(funcName)) {
        if (!initialized.has(varName) && !reported.has(varName)) {
          const decl = declMap.get(varName);
          issues.push({
            type: 'tdz_error',
            message: `'${varName}' (${decl.kind}) is accessed in '${funcName}()' which is called before '${varName}' is declared on line ${decl.line}`,
            line: stmt.loc.start.line,
          });
          reported.add(varName);
        }
      }
    }
  }

  for (const funcName of handlerFunctions) {
    if (!funcVarRefs.has(funcName)) continue;
    for (const varName of funcVarRefs.get(funcName)) {
      if (!reported.has(varName)) {
        const decl = declMap.get(varName);
        issues.push({
          type: 'tdz_warning',
          message: `'${varName}' (${decl.kind}) is used in event handler '${funcName}()' — runtime error if initialization on line ${decl.line} fails`,
          line: decl.line,
        });
        reported.add(varName);
      }
    }
  }

  return issues;
}

function collectAllIdentifiers(node) {
  const names = new Set();
  walkAST(node, n => { if (n.type === 'Identifier') names.add(n.name); });
  return names;
}

function collectSyncIdentifiers(node) {
  const names = new Set();
  walkSyncAST(node, n => { if (n.type === 'Identifier') names.add(n.name); });
  return names;
}

function collectCalledFunctionNames(node) {
  const names = new Set();
  walkSyncAST(node, n => {
    if (n.type === 'CallExpression' && n.callee?.type === 'Identifier') {
      names.add(n.callee.name);
    }
  });
  return names;
}

const SKIP_KEYS = new Set(['type', 'loc', 'start', 'end', 'raw', 'sourceType']);
const DEFERRED_TYPES = new Set([
  'FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration',
  'ClassDeclaration', 'ClassExpression',
]);

function walkAST(node, visitor) {
  if (!node || typeof node !== 'object' || !node.type) return;
  visitor(node);
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) if (c?.type) walkAST(c, visitor);
    } else if (v?.type) {
      walkAST(v, visitor);
    }
  }
}

/** Walk AST but skip function/class bodies (deferred execution). */
function walkSyncAST(node, visitor) {
  if (!node || typeof node !== 'object' || !node.type) return;
  visitor(node);
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    if (key === 'body' && DEFERRED_TYPES.has(node.type)) continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) if (c?.type) walkSyncAST(c, visitor);
    } else if (v?.type) {
      walkSyncAST(v, visitor);
    }
  }
}

module.exports = { validateHtmlErrors };
