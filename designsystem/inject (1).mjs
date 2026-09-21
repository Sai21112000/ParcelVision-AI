// Injects the extracted ServiceMind CSS into the design system HTML at the
// <!--TIS_CSS--> marker. The `body {}` token block is dropped: it is already
// reproduced verbatim in section 1, and a body-scoped copy would out-specify
// the [data-theme] overrides on <html> and break the theme switcher.
import { readFileSync, writeFileSync } from 'node:fs';

const css = readFileSync('extracted.css', 'utf8');
const html = readFileSync('servicemind-design-system.html', 'utf8');

const start = css.indexOf('/* ===== design tokens');
const end = css.indexOf('/* ===== keyframes');
if (start < 0 || end < 0) throw new Error('token block markers not found in extracted.css');

const kept = css.slice(0, start) + css.slice(end);
if (kept.includes('--tis-primary:')) throw new Error('token block was not fully removed');

const block = `<style>
/* ==========================================================================
   3. SERVICEMIND COMPONENTS  --  VERBATIM EXTRACTION
   Source: https://app.servicemind.asia/styles-VWA5PDVG.css  (v4.3.543)
   Every .tis-* rule the application ships, byte-for-byte, plus the TH Sarabun
   @font-face declarations, the keyframes and the Angular Material colour
   overrides that define the indigo/turquoise/coral theme.
   The token block that lives on \`body\` in the original is reproduced in
   section 1 instead, so the theme switcher on this page can override it.
   DO NOT EDIT — regenerate with extract.mjs against a fresh bundle.
   ========================================================================== */
${kept.trim()}
</style>`;

const marker = '<!--TIS_CSS-->';
if (!html.includes(marker)) throw new Error('marker not found in html');
writeFileSync('servicemind-design-system.html', html.replace(marker, block));

console.log('injected', kept.length, 'bytes of CSS');
