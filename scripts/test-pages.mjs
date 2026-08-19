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
  /* Astro inlines a small stylesheet into the page rather than emitting a
     file for it, so both places have to be read — a check that looked only
     at `_astro/*.css` would pass on a build that shipped no rules at all. */
  const css = [
    ...fs.readdirSync(`${DIST}/_astro`).filter((f) => f.endsWith('.css'))
      .map((f) => read(`_astro/${f}`)),
    read('deployment/index.html'),
    read('local/index.html'),
    read('index.html'),
  ].join('\n');

  ok('the trace rule is global and anchored on the figure',
    /\[data-figure\][^{]*\.trace\s*\{/.test(css), 'found in the built CSS');
  /* An SVG path fills by default: without this the two-legged axis renders
     as a solid triangle across every plot. */
  ok('the axis has fill:none', /\[data-figure\][^{]*\.axis\s*\{[^}]*fill:\s*none/.test(css));
  ok('and so does the trace', /\[data-figure\][^{]*\.trace\s*\{[^}]*fill:\s*none/.test(css));
  ok('isopycnals are styled', /\[data-figure\][^{]*\.isopycnal\s*\{/.test(css));
  ok('runtime-built chips are styled globally',
    /\[data-chips\][^{]*\.chip\s*\{/.test(css));
  ok('runtime-built table rows too', /\[data-rows\]\s*tr\s*\{/.test(css));

  /* Leaflet's own stylesheet is what clips the tile pane to the container.
     Without it the map draws over the page's title — which it did. */
  ok('Leaflet’s stylesheet was bundled',
    /\.leaflet-container\s*\{/.test(css) && /overflow:\s*hidden/.test(css));
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
