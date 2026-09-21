// Self-check for the design system and every page built on it. Exits non-zero if
// a page is internally inconsistent: a tis-* class used in the markup with no
// rule behind it, a var(--tis-*) with no declaration, or a dead anchor. For the
// design system it also reports coverage — which extracted classes are not yet
// demonstrated — so gaps are visible rather than assumed.
//
//   node verify.mjs                  # all known pages
//   node verify.mjs somepage.html    # just one
import { readFileSync, existsSync } from 'node:fs';

// Classes that cannot honestly be applied to an element: their selectors are
// body-scoped and print-only, so demonstrating them would either do nothing or
// blank the document.
const NOT_DEMONSTRABLE = new Set(['tis-printing-qr-labels']);

const uniq = (a) => [...new Set(a)].sort();
const matchAll = (s, re) => [...s.matchAll(re)].map((m) => m[1]);

function check(file, { coverage = false } = {}) {
  const html = readFileSync(file, 'utf8');

  // CSS is whatever the page embeds plus whatever local stylesheet it links.
  const embedded = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  const linked = matchAll(html, /<link[^>]+href="([^"]+\.css)"/g)
    .filter((h) => existsSync(h))
    .map((h) => readFileSync(h, 'utf8'));
  const css = [...embedded, ...linked].join('\n');

  const markup = html
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/<script>[\s\S]*?<\/script>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  const styled = new Set(matchAll(css, /\.(tis-[A-Za-z0-9_-]+)/g));
  const used = new Set();
  for (const attr of matchAll(markup, /\sclass="([^"]*)"/g)) {
    for (const c of attr.split(/\s+/)) if (c.startsWith('tis-')) used.add(c);
  }

  const declared = new Set(matchAll(css, /(--tis-[A-Za-z0-9_-]+)\s*:/g));
  const consumed = new Set(matchAll(html, /var\((--tis-[A-Za-z0-9_-]+)/g));

  const ids = new Set(matchAll(html, /\sid="([^"]+)"/g));
  const anchors = uniq(matchAll(html, /<a[^>]+href="#([^"]+)"/g));

  const unstyled = uniq([...used].filter((c) => !styled.has(c)));
  const undeclared = uniq([...consumed].filter((t) => !declared.has(t)));
  const dead = anchors.filter((h) => !ids.has(h));

  console.log(`\n${file}  ${(html.length / 1024).toFixed(0)} KB`);
  console.log(`  css                ${embedded.length} embedded block(s), ${linked.length} linked file(s)`);
  console.log(`  tokens             ${declared.size} declared, ${consumed.size} used`);
  console.log(`  tis-* classes      ${used.size} used, all backed by ${styled.size} styled`);

  if (coverage) {
    const notShown = uniq([...styled].filter((c) => !used.has(c) && !NOT_DEMONSTRABLE.has(c)));
    const demoable = styled.size - NOT_DEMONSTRABLE.size;
    console.log(`  coverage           ${((used.size / demoable) * 100).toFixed(0)}% of ${demoable} demonstrable`);
    if (notShown.length) console.log(`  not demonstrated   ${notShown.join(', ')}`);
  }

  const failures = [
    ['tis-* classes used with no CSS rule', unstyled],
    ['var(--tis-*) used but never declared', undeclared],
    ['anchors pointing at a missing id', dead],
  ].filter(([, l]) => l.length);

  for (const [label, list] of failures) console.log(`  FAIL ${label}: ${list.join(', ')}`);
  return failures.length === 0;
}

const args = process.argv.slice(2);
const pages = args.length
  ? args.map((f) => [f, { coverage: /design-system/.test(f) }])
  : [
      ['servicemind-design-system.html', { coverage: true }],
      ['servicemind-property-billing.html', {}],
    ];

const ok = pages.map(([f, o]) => check(f, o)).every(Boolean);
console.log(ok ? '\nOK — every page is internally consistent.' : '\nFAILED');
process.exit(ok ? 0 : 1);
