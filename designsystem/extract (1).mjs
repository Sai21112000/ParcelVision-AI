// Extracts the ServiceMind design system out of the app's global stylesheet.
// Walks top-level CSS rules with brace matching, keeps anything whose selector
// mentions tis-, plus @font-face and the body token block.
import { readFileSync, writeFileSync } from 'node:fs';

const css = readFileSync('styles-raw.css', 'utf8');

// Split into top-level rules: [{ prelude, body, isAt }]
function topLevelRules(src) {
  const rules = [];
  let i = 0, start = 0, depth = 0, inStr = null, inComment = false;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (inComment) { if (c === '*' && n === '/') { inComment = false; i += 2; continue; } i++; continue; }
    if (inStr) { if (c === '\\') { i += 2; continue; } if (c === inStr) inStr = null; i++; continue; }
    if (c === '/' && n === '*') { inComment = true; i += 2; continue; }
    if (c === '"' || c === "'") { inStr = c; i++; continue; }
    if (c === '{') { depth++; i++; continue; }
    if (c === '}') {
      depth--;
      if (depth === 0) {
        const chunk = src.slice(start, i + 1);
        const open = chunk.indexOf('{');
        rules.push({ prelude: chunk.slice(0, open).trim(), body: chunk.slice(open + 1, -1), raw: chunk.trim() });
        start = i + 1;
      }
      i++; continue;
    }
    if (c === ';' && depth === 0) { // top-level @import / @charset
      const chunk = src.slice(start, i + 1).trim();
      if (chunk) rules.push({ prelude: chunk, body: null, raw: chunk });
      start = i + 1; i++; continue;
    }
    i++;
  }
  return rules;
}

const rules = topLevelRules(css);

const fontFaces = [];
const tokenBlocks = [];
const tisRules = [];
const matRules = [];

// Selectors we need for the shell chrome even though they are not tis-*
const shellSelectorRe = /mat-(sidenav|drawer|toolbar|mdc-table|mdc-tab|mdc-form-field|mdc-dialog|mdc-menu|mdc-checkbox|mdc-radio|mdc-paginator|expansion|stepper|mdc-chip|mdc-progress)/;

for (const r of rules) {
  if (r.prelude.startsWith('@font-face')) { fontFaces.push(r.raw); continue; }
  if (r.body === null) continue;

  if (/^(html|body)\b/.test(r.prelude) && r.body.includes('--tis-')) { tokenBlocks.push(r.raw); continue; }

  if (r.prelude.startsWith('@media') || r.prelude.startsWith('@supports')) {
    // keep nested tis rules inside media queries
    if (r.raw.includes('tis-')) tisRules.push(r.raw);
    continue;
  }
  if (r.prelude.startsWith('@')) continue; // @keyframes etc handled below

  if (r.prelude.includes('tis-')) tisRules.push(r.raw);
  else if (shellSelectorRe.test(r.prelude)) matRules.push(r.raw);
}

const keyframes = rules.filter((r) => r.prelude.startsWith('@keyframes')).map((r) => r.raw);

// Which tis classes have at least one rule, and which are only referenced?
const definedClasses = new Set();
for (const r of tisRules) {
  const open = r.indexOf('{');
  for (const m of r.slice(0, open).matchAll(/\.(tis-[A-Za-z0-9_-]+)/g)) definedClasses.add(m[1]);
}
const allClasses = new Set([...css.matchAll(/\.(tis-[A-Za-z0-9_-]+)/g)].map((m) => m[1]));

const out = [
  '/* ===== @font-face (' + fontFaces.length + ') ===== */',
  ...fontFaces,
  '',
  '/* ===== design tokens (' + tokenBlocks.length + ' block(s)) ===== */',
  ...tokenBlocks,
  '',
  '/* ===== keyframes (' + keyframes.length + ') ===== */',
  ...keyframes,
  '',
  '/* ===== tis-* component rules (' + tisRules.length + ') ===== */',
  ...tisRules,
  '',
  '/* ===== angular material shell rules (' + matRules.length + ') ===== */',
  ...matRules,
].join('\n');

writeFileSync('extracted.css', out);

console.log(JSON.stringify({
  fontFaces: fontFaces.length,
  tokenBlocks: tokenBlocks.length,
  keyframes: keyframes.length,
  tisRules: tisRules.length,
  matRules: matRules.length,
  definedClasses: definedClasses.size,
  allReferencedClasses: allClasses.size,
  referencedButNotDefined: [...allClasses].filter((c) => !definedClasses.has(c)).sort(),
  outBytes: out.length,
}, null, 2));
