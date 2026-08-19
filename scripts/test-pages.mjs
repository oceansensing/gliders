#!/usr/bin/env node
/**
 * The built pages, read as files.
 *
 *   npm run build && npm run test:pages
 *
 * This is the gate for the class of bug that only exists *after* the build:
 * a link that forgot the base path, a policy directive that did not survive,
 * a stylesheet rule that a scoping attribute quietly stopped matching.
 * Every one of them looks fine in `astro dev` and 404s on the deployed site.
 */

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { check, done, ok, section } from './lib/check.mjs';

const DIST = 'dist';
const BASE = '/gliders';

if (!fs.existsSync(DIST)) {
  console.log('FAIL  there is no dist/ — run `npm run build` first');
  process.exit(1);
}

const read = (p) => fs.readFileSync(`${DIST}/${p}`, 'utf8');
const parse = (p) => new JSDOM(read(p)).window.document;

/**
 * Every stylesheet the build emitted, plus every page's inline one.
 *
 * **Both, always.** Astro inlines a small stylesheet into the page and emits
 * a larger one as a file, and which side of that threshold a component lands
 * on changes as it grows — adding the map's legend moved this page's CSS out
 * of the HTML and into `_astro/deployment.*.css`, and six checks that read
 * only the HTML started failing against CSS that was perfectly correct. A
 * gate that depends on a bundler's size heuristic is a gate that fails for
 * the wrong reason.
 */
const ALL_CSS = [
  ...fs.readdirSync(`${DIST}/_astro`).filter((f) => f.endsWith('.css'))
    .map((f) => read(`_astro/${f}`)),
  read('index.html'),
  read('deployment/index.html'),
  read('local/index.html'),
].join('\n');

section('the pages exist');

for (const page of ['index.html', 'deployment/index.html', 'local/index.html']) {
  ok(`${page} was built`, fs.existsSync(`${DIST}/${page}`));
}

section('every internal URL carries the base path');

{
  /* The site is served from a subdirectory, and Astro does not rewrite
     anything: `base` is a value the code has to apply. A root-absolute
     internal link is a 404 on the deployed site and works perfectly in dev,
     which is why this is a gate rather than a habit. */
  for (const page of ['index.html', 'deployment/index.html', 'local/index.html']) {
    const doc = parse(page);
    const offenders = [];

    for (const a of doc.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      if (!href.startsWith('/') || href.startsWith('//')) continue;
      if (!href.startsWith(`${BASE}/`) && href !== BASE) offenders.push(`a ${href}`);
    }
    for (const el of doc.querySelectorAll('link[href], script[src], img[src]')) {
      const url = el.getAttribute('href') ?? el.getAttribute('src');
      if (!url || !url.startsWith('/') || url.startsWith('//')) continue;
      if (!url.startsWith(`${BASE}/`)) offenders.push(`${el.tagName} ${url}`);
    }
    ok(`${page}: no root-absolute internal URL`, offenders.length === 0,
      offenders.join(', ') || 'all prefixed');
  }
}

{
  /* Two URLs that are not links and are therefore the easiest to miss: the
     SAAR atlas the derived properties need, and the worker's own URL. Both
     are fetched by script, so a missing base fails silently at runtime —
     the page loads, the plots draw, and every derived variable is simply
     absent.
     They cannot be matched as literals in the bundle, because `withBase`
     composes them at runtime — which is the point. So the gate is on the
     source: every site asset must go through `withBase`, and a bare
     `fetch('/…')` is the regression to catch. */
  const bundle = fs.readdirSync(`${DIST}/_astro`)
    .filter((f) => f.endsWith('.js'))
    .map((f) => read(`_astro/${f}`))
    .join('\n');
  ok('the base path reached the bundles', bundle.includes(BASE), BASE);

  const sources = fs.readdirSync('src/lib')
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ f, text: fs.readFileSync(`src/lib/${f}`, 'utf8') }));
  const raw = sources.flatMap(({ f, text }) =>
    [...text.matchAll(/fetch\(\s*['"`](\/[^'"`]*)/g)].map((m) => `${f}: ${m[1]}`));
  ok('no source fetches a root-absolute path directly',
    raw.length === 0, raw.join(', ') || 'all go through withBase');

  ok('the worker URL is built with import.meta.url',
    sources.some(({ text }) => /new Worker\(\s*new URL\(/.test(text)),
    'so the bundler fingerprints it and the base is carried');

  ok('the atlas file was published', fs.existsSync(`${DIST}/teos10/saar.bin.gz`));
  ok('the worker was emitted',
    fs.readdirSync(`${DIST}/_astro`).some((f) => /derive\.worker/.test(f)));
  ok('the catalog snapshot was published', fs.existsSync(`${DIST}/data/deployments.json`));
}

section('the content security policy survived');

{
  const doc = parse('deployment/index.html');
  const meta = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
  ok('a policy is present', meta !== null);
  const policy = meta?.getAttribute('content') ?? '';

  /* Without `worker-src`, the derived-property worker never starts: the
     page loads, the sections draw, and every TEOS-10 variable is quietly
     missing. A failure with no error message is exactly what a gate is for. */
  ok('worker-src is there', /worker-src[^;]*'self'/.test(policy), policy.slice(0, 200));
  ok('the DAC can be reached', /connect-src[^;]*https:/.test(policy));
  ok('scripts are not blanket-inline', !/script-src[^;]*'unsafe-inline'/.test(policy));
  ok('objects are refused', /object-src[^;]*'none'/.test(policy));
}

section('the figures are styled after they are cloned');

{
  /* Section figures are built at runtime by cloning a prototype, and a clone
     carries no scoping attribute — so the rules for the plot's own linework
     have to be global, anchored on `[data-figure]`. Scoped, every section
     would render as black fills on black strokes.
     Read out of the built CSS because jsdom does no layout and cannot see
     it. */
  const css = ALL_CSS;

  ok('the trace rule is global and anchored on the figure',
    /\[data-figure\][^{]*\.trace\s*\{/.test(css), 'found in the built CSS');
  /* An SVG path fills by default: without this the two-legged axis renders
     as a solid triangle across every plot. */
  ok('the axis has fill:none', /\[data-figure\][^{]*\.axis\s*\{[^}]*fill:\s*none/.test(css));
  ok('and so does the trace', /\[data-figure\][^{]*\.trace\s*\{[^}]*fill:\s*none/.test(css));
  ok('isopycnals are styled', /\[data-figure\][^{]*\.isopycnal\s*\{/.test(css));
  /* The band drawn while sweeping a section for a time range. It is built at
     runtime like everything else inside the SVG, and it must not take
     pointer events — it sits under the cursor for the whole gesture and
     would otherwise swallow the pointerup that ends it. */
  ok('the selection band is styled and lets the pointer through',
    /\[data-figure\][^{]*\.select-band\s*\{[^}]*pointer-events:\s*none/.test(css));
  /**
   * The pointer readout must not move the figure it describes.
   *
   * Measured before the fix, at 1280×900: hovering the T–S diagram wrapped
   * an 80-character readout onto three lines, grew the figure's head from
   * 26 px to 80 px and dropped the plot 54 px — out from under the pointer
   * that summoned it. Horizontally, right-aligned free-width numbers slid
   * every label sideways as the digits changed.
   *
   * Four rules hold it still, and jsdom does no layout, so the only way to
   * check them is to read the built stylesheet.
   */
  ok('the readout can never wrap onto a second line',
    /\[data-plot-hover\]\s*\{[^}]*white-space:\s*nowrap/.test(css));
  ok('and reserves its line even when empty',
    /\[data-plot-hover\]\s*\{[^}]*min-height/.test(css));
  ok('and is hidden rather than emptied, so the slot keeps its width',
    /\[data-plot-hover\]\s*\{[^}]*visibility:\s*hidden/.test(css)
    && /\[data-plot-hover\]\.live\s*\{[^}]*visibility:\s*visible/.test(css));
  ok('each value sits in a fixed-width slot with tabular figures',
    /\.ro-v\s*\{[^}]*min-width:\s*\d+ch/.test(css)
    && /\.ro-v\s*\{[^}]*tabular-nums/.test(css));
  /* The head itself must not be allowed to wrap, or the slot would simply
     take a line of its own instead of shrinking. */
  ok('the figure head does not wrap', /flex-wrap:\s*nowrap/.test(css));

  ok('runtime-built chips are styled globally',
    /\[data-chips\][^{]*\.chip\s*\{/.test(css));
  ok('runtime-built table rows too', /\[data-rows\]\s*tr\s*\{/.test(css));

  /* Leaflet's own stylesheet is what clips the tile pane to the container.
     Without it the map draws over the page's title — which it did. */
  ok('Leaflet’s stylesheet was bundled',
    /\.leaflet-container\s*\{/.test(css) && /overflow:\s*hidden/.test(css));
}

section('every figure title is styled the same way');

{
  /* The map's title wore `.eyebrow` — mono, uppercase, muted, small — while
     every plot's wore an `h3`, so two figures side by side looked like a
     caption beside a heading. One class now, and it is global rather than
     scoped because the section figures are clones. */
  const doc = parse('deployment/index.html');
  const titles = [...doc.querySelectorAll('.figure-title')];
  ok('every figure has one', titles.length >= 4, `${titles.length} titles`);
  ok('the map’s title is one of them',
    titles.some((t) => t.textContent.trim() === 'Track'));
  ok('and so is the T–S diagram’s',
    titles.some((t) => t.textContent.trim() === 'T–S diagram'));
  ok('none of them is still an eyebrow',
    titles.every((t) => !t.classList.contains('eyebrow')));

  /* `.eyebrow` uppercases, which would turn the section titles' "σ₀" into
     "Σ₀" and "kg/m³" into "KG/M³" — a style that corrupts the symbols it
     displays is not available here. */
  ok('the shared title style does not transform case',
    !/\.figure-title\s*\{[^}]*text-transform/.test(ALL_CSS));
  ok('and it is defined once, globally',
    /\.figure-title\s*\{[^}]*font-size/.test(ALL_CSS));

  /**
   * The map's caption must carry the same margins as a figure's head, or the
   * two titles beside each other sit on different lines.
   *
   * `global.css` gives `.topline` a top margin of `--space-md`, written for
   * a caption above a full-width map; a `PlotFigure`'s head has none. The
   * component's rule first overrode only `margin-block-end`, which left the
   * top margin in place and put "Track" exactly 20 px below "T–S diagram".
   * jsdom does no layout, so this is checked as the rule rather than as the
   * offset.
   */
  ok('the map caption sets both margins, not just the end',
    /\.topline[^{]*\{[^}]*margin-block:\s*0/.test(ALL_CSS));

  /* Still subordinate to the heading for a *group* of figures. */
  const h2 = doc.querySelector('h2');
  ok('group headings are still h2', h2 !== null && /Sections|Profiles/.test(h2.textContent));
}

section('the window controls');

{
  const doc = parse('deployment/index.html');
  for (const sel of ['[data-from]', '[data-to]', '[data-apply]', '[data-whole]']) {
    ok(`${sel} is rendered`, doc.querySelector(sel) !== null);
  }
  ok('the two clocks take a date and a time',
    doc.querySelector('[data-from]')?.getAttribute('type') === 'datetime-local');
  /* Disabled until a window is chosen: there is nothing to go back to on a
     page showing the whole deployment already. */
  ok('“whole deployment” starts disabled',
    doc.querySelector('[data-whole]')?.hasAttribute('disabled'));

  /* The profile figure had its own window boxes and its own fetch, which was
     a second way to ask the same question and a second answer to keep in
     step. One window now governs every figure. */
  ok('the profile figure has no window controls of its own',
    doc.querySelector('[data-profile-from]') === null
    && doc.querySelector('[data-profile-load]') === null);
  ok('but the profile figure is still there',
    doc.querySelector('[data-figure="profile"]') !== null);
}

section('the map’s colour control and the profile pair');

{
  const doc = parse('deployment/index.html');
  ok('the track has a colour-by control',
    doc.querySelector('[data-track-colour]') !== null);
  ok('and a scale control with a ramp beside it',
    doc.querySelector('[data-track-map]') !== null
    && doc.querySelector('[data-track-ramp]') !== null);
  ok('and colour-range limits with a way back to automatic',
    doc.querySelector('[data-track-lo]') !== null
    && doc.querySelector('[data-track-hi]') !== null
    && doc.querySelector('[data-track-auto]') !== null);
  /* Each legend row carries one visible label, which serves the first
     control in it. The second range box has no visible label of its own, so
     its `aria-label` is the only thing telling a screen reader which end of
     the range it sets. */
  ok('every legend control is named',
    ['track-colour', 'track-map', 'track-lo']
      .every((id) => doc.querySelector(`label[for="${id}"]`) !== null)
    && (doc.querySelector('[data-track-hi]')?.getAttribute('aria-label') ?? '').length > 0);

  /* The legend belongs under the picture it explains — and putting it there
     also keeps it out of the caption, which the map's height is measured
     against. */
  const mapEl = doc.querySelector('[data-map]');
  const legend = doc.querySelector('.track-controls');
  /* The range boxes become `datetime-local` on a time axis, which the browser
     renders ~2 px taller than a `number` — and the map fills what this strip
     leaves it, so without a floor the map resized when the colour variable
     changed. */
  ok('the legend rows have a fixed height',
    /\.track-controls[^{]*\.row[^{]*\{[^}]*min-height/.test(ALL_CSS));

  ok('the legend sits below the map',
    Boolean(mapEl && legend
      && (mapEl.compareDocumentPosition(legend) & 4) !== 0));
  ok('with a label tied to it',
    doc.querySelector('label[for="track-colour"]') !== null
    && doc.querySelector('#track-colour') !== null);

  /* Two profile panels, because a profile is read against another profile:
     temperature beside salinity is how a thermocline is told from a
     halocline. */
  ok('there are two profile figures',
    doc.querySelector('[data-figure="profile"]') !== null
    && doc.querySelector('[data-figure="profile2"]') !== null);

  /* Astro stamps its scoping attribute on *each* compound selector, so
     `.track-colour select` is emitted as
     `.track-colour[data-astro-cid-…] select[data-astro-cid-…]` — a pattern
     expecting the two to be adjacent matches nothing. Minification also
     folds `flex: 1 1 auto` to `flex:auto`. Both caught by this gate failing
     against CSS that was in fact correct. */
  const css = ALL_CSS;
  /* A select is as wide as its widest option, and the widest here is
     "Potential density anomaly σ₀ (kg/m³)". Uncapped it pushed the map's
     caption onto three lines and took 65 px out of the map below it. */
  ok('the colour select is width-capped',
    /\[data-track-colour\][^{]*\{[^}]*max-width/.test(css));
  ok('and so is the scale select',
    /\[data-track-map\][^{]*\{[^}]*max-width/.test(css));
  /* The range readout changes length with the variable, so its slot is
     reserved — otherwise picking one reflows the caption and the map
     resizes under the reader. */
  ok('and the range readout has a reserved slot',
    /\[data-track-note\][^{]*\{[^}]*min-width:\s*\d+ch/.test(css));
  /* The map fills whatever height the T–S column takes, so the two columns
     end level however tall the figure beside it is. */
  ok('the map stretches to the figure column',
    /align-items:\s*stretch/.test(css)
    && /\.map[^{]*\{[^}]*flex:\s*(1|auto)/.test(css));
}

section('the local page carries the same track figure');

{
  /* The two pages show the same figure of the same thing, so they share one
     component and one controller — `TrackFigure.astro` and
     `lib/track-legend.ts`. A copy in each would be a copy that drifts. */
  const local = parse('local/index.html');
  const deployment = parse('deployment/index.html');
  for (const sel of ['[data-map]', '[data-track-colour]', '[data-track-map]',
    '[data-track-ramp]', '[data-track-lo]', '[data-track-hi]', '[data-track-auto]',
    '[data-track-note]']) {
    ok(`local/ has ${sel}`, local.querySelector(sel) !== null);
  }
  ok('and the same three legend rows as the deployment page',
    local.querySelectorAll('.track-controls .row').length
      === deployment.querySelectorAll('.track-controls .row').length,
    `${local.querySelectorAll('.track-controls .row').length} rows`);
  ok('with the shared figure title',
    [...local.querySelectorAll('.figure-title')]
      .some((t) => t.textContent.trim() === 'Track'));
  /* The old caption said "coloured by time", which the legend now answers
     and which would be a lie the moment a reader changed it. */
  ok('and no stale hard-coded caption',
    !read('local/index.html').includes('coloured by time'));
}

section('the prototype figure is hidden');

{
  const doc = parse('deployment/index.html');
  const prototype = doc.querySelector('[data-figure="prototype"]');
  ok('a prototype is rendered for cloning', prototype !== null);
  const host = prototype?.closest('[data-prototype-host]');
  ok('and its host is hidden', host?.hasAttribute('hidden') === true);
}

section('the chrome');

{
  const doc = parse('index.html');
  ok('the page has a title', /Gliders/.test(doc.title), doc.title);
  ok('there is a skip link', doc.querySelector('.skip-link') !== null);
  ok('the theme is applied before paint',
    read('index.html').includes("localStorage.getItem('theme')"));
  /* Reading localStorage throws outright where a browser blocks site data,
     and this is the first script on every page. */
  ok('and the read is guarded', /try\s*\{[^}]*localStorage\.getItem\('theme'\)/.test(read('index.html')));

  const nav = [...doc.querySelectorAll('nav a')].map((a) => a.getAttribute('href'));
  ok('the nav points into the base path', nav.every((h) => h.startsWith(`${BASE}/`)),
    nav.join(', '));
}

done();
