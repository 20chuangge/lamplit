#!/usr/bin/env node
/**
 * check-page-parts.mjs - the page's script is split by feature into plain
 * scripts that share one scope and load in order (public/app/main/, ENG-04).
 * That is only safe while:
 *   - code that runs at load time (not inside a function) uses nothing from a
 *     later part - directly or through a function it calls right away;
 *   - no top-level name is declared twice across the parts;
 *   - no const / let shadows a browser property that cannot be redefined.
 * Uses the TypeScript parser (desktop/'s or the root's dev dependency).
 *
 *   node scripts/check-page-parts.mjs      (also run by npm run smoke)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { MAIN_PARTS } from './page-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEADER = /^'use strict';\n\/\/ [^\n]*\n/;
// window properties a top-level const / let may not use (non-configurable).
const FIXED = new Set(['window', 'document', 'location', 'top', 'self', 'frames', 'parent', 'globalThis', 'undefined', 'NaN', 'Infinity']);

function loadTs() {
  for (const base of [path.join(root, 'desktop', 'package.json'), path.join(root, 'package.json')]) {
    try { return createRequire(base)('typescript'); } catch { /* next */ }
  }
  return null;
}

export function checkPageParts(publicDir = path.join(root, 'public')) {
  const ts = loadTs();
  if (!ts) return { skipped: 'typescript is not installed', problems: [] };
  const problems = [];
  const parts = MAIN_PARTS.map((rel, index) => {
    const text = fs.readFileSync(path.join(publicDir, rel), 'utf8').replace(/\r\n/g, '\n');
    if (!HEADER.test(text)) problems.push(`${rel}: must start with 'use strict'; and a one-line comment`);
    return { rel, index, sf: ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS) };
  });
  const isFn = (n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n);

  // Every top-level name: where it is declared.
  const decl = new Map();
  const declare = (name, part, kind) => {
    if (decl.has(name)) problems.push(`"${name}" is declared twice (${decl.get(name).rel} and ${part.rel})`);
    else decl.set(name, { part: part.index, rel: part.rel, kind });
    if (kind === 'lexical' && FIXED.has(name)) problems.push(`${part.rel}: top-level "${name}" clashes with a browser property`);
  };
  const fnBody = new Map();
  for (const part of parts) {
    for (const st of part.sf.statements) {
      if (ts.isImportDeclaration(st) || ts.isExportDeclaration(st) || ts.isExportAssignment(st)) problems.push(`${part.rel}: import / export cannot be used in a plain script`);
      if (ts.isFunctionDeclaration(st) && st.name) { declare(st.name.text, part, 'function'); fnBody.set(st.name.text, st); } else if (ts.isClassDeclaration(st) && st.name) declare(st.name.text, part, 'lexical');
      else if (ts.isVariableStatement(st)) {
        const kind = st.declarationList.flags & ts.NodeFlags.BlockScoped ? 'lexical' : 'var';
        for (const d of st.declarationList.declarations) {
          const names = [];
          const collect = (b) => { if (ts.isIdentifier(b)) names.push(b.text); else b.elements?.forEach((e) => e.name && collect(e.name)); };
          collect(d.name);
          names.forEach((n) => declare(n, part, kind));
        }
      }
    }
  }
  // What a piece of code uses right now (not inside functions it only defines).
  const now = (node, skipRoot = false) => {
    const refs = new Set();
    const calls = new Set();
    const visit = (n, isRoot) => {
      if (!isRoot && isFn(n)) return;
      if (ts.isIdentifier(n) && decl.has(n.text)) {
        const p = n.parent;
        if (!(p && ts.isPropertyAccessExpression(p) && p.name === n) && !(p && ts.isPropertyAssignment(p) && p.name === n)) refs.add(n.text);
      }
      if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && n.expression && ts.isIdentifier(n.expression)) calls.add(n.expression.text);
      if (ts.isCallExpression(n) && ts.isParenthesizedExpression(n.expression) && isFn(n.expression.expression)) visit(n.expression.expression, true);
      ts.forEachChild(n, (c) => visit(c, false));
    };
    visit(node, skipRoot);
    return { refs, calls };
  };
  const fnNeeds = new Map();
  const needsOf = (name, seen = new Set()) => {
    if (seen.has(name) || !fnBody.get(name)?.body) return new Set();
    seen.add(name);
    if (!fnNeeds.has(name)) fnNeeds.set(name, now(fnBody.get(name).body, true));
    const { refs, calls } = fnNeeds.get(name);
    const out = new Set(refs);
    for (const c of calls) if (fnBody.has(c)) needsOf(c, seen).forEach((x) => out.add(x));
    return out;
  };
  for (const part of parts) {
    for (const st of part.sf.statements) {
      if (ts.isFunctionDeclaration(st)) continue;
      const { refs, calls } = now(st);
      const need = new Set(refs);
      for (const c of calls) if (fnBody.has(c)) { need.add(c); needsOf(c).forEach((x) => need.add(x)); }
      for (const n of need) {
        const d = decl.get(n);
        if (d && d.part > part.index) {
          const line = part.sf.getLineAndCharacterOfPosition(st.getStart(part.sf)).line + 1;
          problems.push(`${part.rel}:${line} runs at load time and needs "${n}" from the later ${d.rel}`);
        }
      }
    }
  }
  return { problems, parts: parts.length, names: decl.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = checkPageParts();
  if (out.skipped) console.log(`SKIP  ${out.skipped}`);
  else if (out.problems.length) { console.log(`FAIL  ${out.problems.length} problem(s):`); out.problems.forEach((p) => console.log(`  ${p}`)); process.exitCode = 1; } else console.log(`PASS  ${out.parts} parts, ${out.names} top-level names: load order is safe`);
}
