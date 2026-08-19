#!/usr/bin/env node
/**
 * The documentation, checked against the repository it describes.
 *
 *   npm run check:docs
 *
 * Not a spell-check and not a word count. It asserts the few things that go
 * stale silently: a package added without a note saying what it is for, a
 * test suite that `verify` runs but no table lists, a page that exists and is
 * documented nowhere. Each of those is invisible until somebody needs the
 * document and finds a hole in it.
 */

import fs from 'node:fs';
import { check, done, ok, section } from './lib/check.mjs';

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

section('the documents exist');

for (const doc of ['README.md', 'CLAUDE.md', 'PLAN.md', 'LICENSE']) {
  ok(`${doc} is present`, read(doc).length > 200, `${read(doc).length} bytes`);
}

section('every package says what it is for');

{
  /* A package with no note is a package the next person has to read in full
     to find out whether it is the one they want. */
  const packages = fs.readdirSync('packages').filter(
    (name) => fs.existsSync(`packages/${name}/package.json`),
  );
  ok('there are packages to check', packages.length >= 4, packages.join(', '));

  for (const name of packages) {
    const notes = read(`packages/${name}/CLAUDE.md`) + read(`packages/${name}/README.md`);
    ok(`packages/${name} is documented`, notes.length > 500,
      `${notes.length} bytes of notes`);
  }

  /* The root document points at the package ones rather than repeating them,
     so it has to actually name them. */
  const root = read('CLAUDE.md') + read('README.md');
  for (const name of packages) {
    ok(`the root docs mention packages/${name}`, root.includes(`packages/${name}`));
  }
}

section('every suite `verify` runs is written down');

{
  const pkg = JSON.parse(read('package.json'));
  const suites = Object.keys(pkg.scripts).filter((s) => s.startsWith('test:'));
  const claude = read('CLAUDE.md');
  ok('there are suites to check', suites.length >= 6, suites.join(', '));
  for (const suite of suites) {
    ok(`${suite} appears in CLAUDE.md`, claude.includes(suite));
  }

  /* And `verify` actually runs all of them — a suite that exists but is not
     chained is a suite nobody runs. */
  const verify = pkg.scripts.verify ?? '';
  const missing = suites.filter((s) => !verify.includes(s));
  ok('and verify runs every one', missing.length === 0,
    missing.join(', ') || 'all chained');
}

section('every page is described');

{
  const pages = fs.readdirSync('src/pages')
    .filter((f) => f.endsWith('.astro'))
    .map((f) => f.replace(/\.astro$/, ''));
  const docs = read('README.md') + read('CLAUDE.md') + read('PLAN.md');
  for (const page of pages) {
    if (page === '404') continue;
    const route = page === 'index' ? '/' : `/${page}/`;
    ok(`${route} is described`, docs.includes(route), route);
  }
}

section('the live URL is stated the same way everywhere');

{
  const live = 'https://oceansensing.org/gliders/';
  for (const doc of ['README.md', 'PLAN.md']) {
    ok(`${doc} names the live site`, read(doc).includes(live));
  }
  /* The base path the build uses and the URL the docs promise have to agree,
     or the documents send people to a 404. */
  const config = read('astro.config.mjs');
  const base = /base:\s*'([^']+)'/.exec(config)?.[1];
  check('and the build serves it there', `https://oceansensing.org${base}/`, live);
}

done();
