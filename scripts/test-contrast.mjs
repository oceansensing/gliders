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

section("the map's markers, against the map");

/**
 * **The one set of colours on the site that is not judged against the page.**
 *
 * A dot marking a glider sits on Esri's World Ocean Base, which has one
 * palette and no idea the theme exists. Judging it against `--bg` says
 * nothing; judging it against the water is the whole question. So these are
 * measured against the basemap as it actually renders — five tiles over
 * glider country (Mid-Atlantic shelf, Gulf Stream, Gulf of Mexico, an ocean
 * basin and a global view), quantised to twelve colours, of which these six
 * are 97% of the pixels.
 *
 * Two of the rare ones are in the list too, and so are the ends of the
 * colormap the tracks are drawn in, because a dot frequently sits on its own
 * track and `cmo.thermal` starts at very nearly black.
 */
{
  const BASEMAP = [
    ['shelf blue', '#b5d3ee', 34],
    ['land', '#e9e8e5', 18],
    ['slope blue', '#8cb0da', 16],
    ['deeper water', '#779ecc', 12],
    ['olive land', '#d3dbbb', 4],
  ];
  const DARKEST = [
    ['abyssal blue', '#21507c'],
    ['a track at its darkest', '#042333'],
    ['a track mid-record', '#6b438b'],
  ];

  const here = light?.['map-here'];
  const past = light?.['map-past'];
  const ring = light?.['map-ring'];
  ok('the marker tokens are defined', Boolean(here && past && ring),
    `${here} / ${past} / ${ring}`);

  /* Defining one of these per theme is the bug this whole set exists to
     prevent: the accent it replaced turned pale in dark mode over water that
     stayed pale, and measured 1.04:1 — the background, exactly. */
  ok('and are not redefined per theme',
    !dark?.['map-here'] && !dark?.['map-past'] && !dark?.['map-ring'],
    'the basemap does not change with the theme, so neither may these');

  if (here && past && ring) {
    /* The body carries the marker across the 97% of the map that is light. */
    for (const [what, colour] of [['here', here], ['past', past]]) {
      for (const [name, bg, share] of BASEMAP) {
        const r = ratio(colour, bg);
        ok(`--map-${what} on ${name} (${share}% of the map)`, r >= 3,
          `${r.toFixed(2)}:1, needs 3:1`);
      }
    }

    /* And the ring carries it across everything the body cannot: a marker
       with only one tone has no answer to a background of its own
       luminance, and a track's colormap supplies every luminance there is. */
    for (const [name, bg] of DARKEST) {
      const r = ratio(ring, bg);
      ok(`--map-ring on ${name}`, r >= 3, `${r.toFixed(2)}:1, needs 3:1`);
    }

    /* Worst case over the lot, which is the number worth quoting. */
    for (const [what, colour] of [['here', here], ['past', past]]) {
      const all = [...BASEMAP.map((b) => b[1]), ...DARKEST.map((b) => b[1])];
      const worst = Math.min(...all.map((bg) =>
        Math.max(ratio(colour, bg), ratio(ring, bg))));
      ok(`--map-${what} is visible on anything the map can draw`, worst >= 3,
        `worst of body-or-ring is ${worst.toFixed(2)}:1`);
    }
  }

  /* The PNG export composites the same tiles, so it draws the same markers —
     from its own copy of the values, which is the copy that can drift. */
  const exporter = fs.readFileSync('src/lib/map-export.ts', 'utf8');
  const mark = /const MARK = \{([\s\S]*?)\n\} as const;/.exec(exporter)?.[1] ?? '';
  for (const [key, token] of [['here', here], ['past', past], ['ring', ring]]) {
    const found = new RegExp(`${key}:\\s*'(#[0-9a-fA-F]{3,8})'`).exec(mark)?.[1];
    check(`the exported PNG's ${key} marker matches the token`, found, token);
  }
}

done();
