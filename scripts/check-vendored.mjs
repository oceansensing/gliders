#!/usr/bin/env node
/**
 * Whether the vendored packages have drifted from their source.
 *
 *   npm run check:vendored
 *
 * `packages/slocum` and `packages/teos10` are **copies** of the packages in
 * the oceansensing.github.io repository. Copying was the deliberate choice
 * over a submodule or an npm release: both are zero-dependency TypeScript
 * written to be lifted whole, this repository stays self-contained, and CI
 * needs nothing but a checkout.
 *
 * The cost of a copy is drift, and the answer to drift is a check rather
 * than a promise. This one reports; it does not fail the build, because the
 * source repository is not present in CI and its absence is not an error.
 * Run it locally before releasing, or after pulling the other repository.
 *
 * `packages/plot/colormaps.ts` is also compared, against the copy inside
 * `packages/slocum` that it was lifted from.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SOURCE = process.env.OCEANSENSING_REPO
  ?? path.resolve(process.env.HOME ?? '', 'GitHub/oceansensing.github.io');

const VENDORED = ['teos10', 'slocum'];

const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Files that are expected to differ, with the reason. */
const EXPECTED = new Map([
  ['plot/colormaps.ts', 'the header names this repository rather than the other one'],
]);

if (!fs.existsSync(SOURCE)) {
  console.log(`The source repository is not here (${SOURCE}).`);
  console.log('Nothing to compare — set OCEANSENSING_REPO if it lives elsewhere.');
  process.exit(0);
}

let drifted = 0;
let compared = 0;

for (const name of VENDORED) {
  const mine = path.join('packages', name);
  const theirs = path.join(SOURCE, 'packages', name);
  if (!fs.existsSync(theirs)) {
    console.log(`?  packages/${name} — no counterpart in the source repository`);
    continue;
  }

  const files = fs.readdirSync(mine).filter((f) => /\.(ts|json|md)$/.test(f));
  for (const file of files) {
    const a = path.join(mine, file);
    const b = path.join(theirs, file);
    if (!fs.existsSync(b)) {
      console.log(`+  packages/${name}/${file} — only here`);
      drifted++;
      continue;
    }
    compared++;
    if (digest(a) !== digest(b)) {
      console.log(`!  packages/${name}/${file} — differs from the source`);
      drifted++;
    }
  }

  for (const file of fs.readdirSync(theirs).filter((f) => /\.(ts|json|md)$/.test(f))) {
    if (!fs.existsSync(path.join(mine, file))) {
      console.log(`-  packages/${name}/${file} — in the source, missing here`);
      drifted++;
    }
  }
}

/* The colormap tables, against the copy they were lifted from. Compared by
   the tables alone rather than the whole file: the prose above them is
   deliberately different, and comparing bytes would report a difference
   every time either header is edited. */
{
  const tables = (file) => {
    const text = fs.readFileSync(file, 'utf8');
    const from = text.indexOf('export const STANDARD');
    const to = text.indexOf('export const COLORMAPS');
    return from >= 0 && to > from ? text.slice(from, to) : null;
  };
  const mine = tables('packages/plot/colormaps.ts');
  const theirs = fs.existsSync(path.join(SOURCE, 'packages/slocum/colormaps.ts'))
    ? tables(path.join(SOURCE, 'packages/slocum/colormaps.ts'))
    : null;
  if (mine && theirs) {
    compared++;
    if (mine === theirs) {
      console.log('ok packages/plot/colormaps.ts — the tables match the source');
    } else {
      console.log('!  packages/plot/colormaps.ts — the colour tables differ from the source');
      drifted++;
    }
  }
}

console.log('');
console.log(drifted === 0
  ? `${compared} files compared, none drifted.`
  : `${compared} files compared, ${drifted} differ. See the notes above; `
    + `${[...EXPECTED.keys()].join(', ')} are expected to.`);
