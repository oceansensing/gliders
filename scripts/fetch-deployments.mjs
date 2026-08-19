/**
 * Refresh the committed catalog snapshot.
 *
 *   npm run data:deployments
 *
 * **A fallback, not the first paint.** The live catalog is 2,534 rows and
 * 572 KB, and it arrives in 0.25 s — measured — so the page asks the server
 * every time and is always current. This file is what it falls back to when
 * that request fails, and what the page tests read instead of the network.
 *
 * It lives in `public/` rather than `src/` for the same reason: inlined, it
 * would put 653 KB into the HTML of a page that will not normally read a
 * byte of it.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { listDatasets } from '../packages/erddap/index.ts';

const OUT = fileURLToPath(new URL('../public/data/deployments.json', import.meta.url));

const deployments = await listDatasets();
deployments.sort((a, b) => b.end - a.end);

const doc = {
  fetched: Math.floor(Date.now() / 1000),
  source: 'https://gliders.ioos.us/erddap',
  deployments,
};

writeFileSync(OUT, `${JSON.stringify(doc, null, 0)}\n`);
console.log(`${deployments.length} deployments → ${OUT}`);
