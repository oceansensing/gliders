#!/usr/bin/env node
/**
 * Every colour pair in the theme, against WCAG AA.
 *
 *   npm run test:contrast
 *
 * The tokens are inherited from oceansensing.org, where they were built to
 * meet AA — but this site adds its own pairings (a chip's text on the accent
 * fill, a live badge, muted mono captions) and a token edit here would not
 * be caught there. Read out of `src/styles/tokens.css` so the check is
 * against what ships rather than a copy of the values.
 *
 * AA is 4.5:1 for body text and 3:1 for large text and UI boundaries.
 */

import fs from 'node:fs';
import { check, done, ok, section } from './lib/check.mjs';

const css = fs.readFileSync('src/styles/tokens.css', 'utf8');

/** The tokens of one theme block. `:root` is light; the `[data-theme='dark']`
    block is dark. */
function tokens(blockPattern) {
  const block = blockPattern.exec(css);
  if (!block) return null;
  const out = {};
  for (const m of block[1].matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

const light = tokens(/:root\s*\{([\s\S]*?)\n\}/);
const dark = tokens(/:root\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/);

function rgb(hex) {
  const h = hex.slice(1);
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Relative luminance, per WCAG. */
function luminance(hex) {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The pairs this site actually renders. */
const PAIRS = [
  ['text', 'bg', 4.5, 'body text on the page'],
  ['text', 'bg-subtle', 4.5, 'body text on a panel'],
  ['text-muted', 'bg', 4.5, 'captions and metadata'],
  ['text-muted', 'bg-subtle', 4.5, 'muted text on a panel'],
  ['accent', 'bg', 4.5, 'links'],
  ['accent', 'bg-subtle', 4.5, 'links on a panel'],
  ['accent-strong', 'bg', 4.5, 'a hovered link'],
  ['accent-contrast', 'accent', 4.5, 'a pressed chip, and the live badge'],
  /* WCAG 1.4.11: the boundary of a form control is what identifies it, and
     an empty text field is nothing but its border. The decorative
     `--border` is a 1.33:1 hairline — right for a table rule and not for
     this — so interactive edges use their own token. */
  ['border-strong', 'bg', 3, 'the edge of an input, a button, a chip'],
  ['border-strong', 'bg-subtle', 3, 'the same, on a panel'],
];

for (const [name, theme] of [['light', light], ['dark', dark]]) {
  section(`${name} theme`);
  ok('the tokens were found', theme !== null && Object.keys(theme).length > 6,
    theme ? `${Object.keys(theme).length} tokens` : 'none');
  if (!theme) continue;

  for (const [fg, bg, want, what] of PAIRS) {
    const a = theme[fg];
    const b = theme[bg];
    if (!a || !b) {
      ok(`${fg} on ${bg} — ${what}`, false, `missing token ${a ? bg : fg}`);
      continue;
    }
    const r = ratio(a, b);
    ok(`${fg} on ${bg} — ${what}`, r >= want,
      `${r.toFixed(2)}:1, needs ${want}:1  (${a} on ${b})`);
  }
}

section('the two themes are the same shape');

{
  const a = Object.keys(light ?? {}).sort().join(',');
  const b = Object.keys(dark ?? {}).sort().join(',');
  /* A token defined in one theme and not the other is the failure that
     leaves an element unstyled in exactly one of them, which nobody sees
     until they switch. The dark block redefines only the colours, so it is
     compared against the light block's colours rather than all of it. */
  const colours = ['bg', 'bg-subtle', 'text', 'text-muted', 'border', 'border-strong',
    'accent', 'accent-strong', 'accent-contrast'];
  ok('every colour token exists in both',
    colours.every((c) => light?.[c] && dark?.[c]),
    colours.filter((c) => !light?.[c] || !dark?.[c]).join(', ') || 'all present');
  void a; void b;
}

done();
