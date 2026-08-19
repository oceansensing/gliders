#!/usr/bin/env node
/**
 * Bake every archived mission's track into files this site serves itself.
 *
 *   npm run data:tracks            # only what is missing or has changed
 *   npm run data:tracks -- --all   # ignore what is already baked
 *
 * **Incremental by default, and that is the point.** A shard is keyed on each
 * mission's last report, so a re-bake fetches the handful of deployments that
 * have finished since the last one and rewrites only the shards they fall in.
 * A year that has ended is a file that is never written again — which is what
 * makes running this on a schedule cost nothing, in DAC requests or in git.
 *
 * Measured on the real archive: a track is one request of about 35 ms and
 * 12 KB, so a cold bake of all 2,534 is roughly 20 s at six at a time. The
 * DAC is asked once, here, rather than by every reader.
 *
 * See `src/lib/tracks.ts` for the format and why it is that one.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BASE, listDatasets, parseJsonlCsvStream, request, tabledapUrl }
  from '../packages/erddap/index.ts';
import { TRACK_EVERY, TRACK_PRECISION, encodeTrack, trackYear }
  from '../src/lib/tracks.ts';

const OUT = fileURLToPath(new URL('../public/data/tracks/', import.meta.url));
const ACTIVE_DAYS = 7;          // the client's rule, and it has to be the same
const CONCURRENCY = 6;          // measured: more does not help, the DAC queues
const ALL = process.argv.includes('--all');

fs.mkdirSync(OUT, { recursive: true });

const now = Math.floor(Date.now() / 1000);
const catalog = await listDatasets();

/**
 * Only the missions that have stopped.
 *
 * A glider still reporting grows a few fixes a day, so a baked path would
 * show a reader a glider that had stopped moving — the one thing a live map
 * must not do. Those are fetched by the browser, every visit.
 *
 * The epoch guard is not hypothetical: one deployment in the catalog carries
 * a 1970 start, which would otherwise open a shard of its own.
 */
const archived = catalog.filter((d) =>
  Number.isFinite(d.start) && Number.isFinite(d.end)
  && d.start > 1e9 && d.end > d.start
  && now - d.end >= ACTIVE_DAYS * 86400);

console.log(`${catalog.length} deployments, ${archived.length} archived`);

/** What is already on disk, so a re-bake asks for as little as possible. */
const shards = new Map();
for (const d of archived) {
  const year = trackYear(d.start);
  if (shards.has(year)) continue;
  const file = path.join(OUT, `${year}.json`);
  let existing = { year, every: TRACK_EVERY, precision: TRACK_PRECISION, tracks: {} };
  if (!ALL && fs.existsSync(file)) {
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      /* A shard written at a different resolution is not a shard that can be
         merged into this one — take the whole year again rather than serve
         two encodings under one precision field. */
      if (doc.precision === TRACK_PRECISION && doc.every === TRACK_EVERY) existing = doc;
    } catch {
      /* Unreadable is the same as absent. */
    }
  }
  shards.set(year, existing);
}

const todo = archived.filter((d) => {
  const have = shards.get(trackYear(d.start)).tracks[d.id];
  return !have || have.end !== Math.round(d.end);
});

console.log(`${todo.length} to fetch, ${archived.length - todo.length} already baked`);

let done = 0;
let failed = 0;
let next = 0;
const t0 = Date.now();

async function worker() {
  for (;;) {
    const d = todo[next++];
    if (!d) return;
    let p = [];
    try {
      const url = tabledapUrl(DEFAULT_BASE, d.id, 'jsonlCSV',
        ['time', 'latitude', 'longitude'], { every: TRACK_EVERY });
      const res = await request(url);
      const { columns, rows } = await parseJsonlCsvStream(res, {
        names: ['time', 'latitude', 'longitude'],
        timeColumns: new Set(['time']),
      });
      const lat = columns.get('latitude');
      const lon = columns.get('longitude');
      const pairs = [];
      for (let i = 0; i < rows; i++) {
        if (Number.isFinite(lat[i]) && Number.isFinite(lon[i])) pairs.push([lat[i], lon[i]]);
      }
      p = encodeTrack(pairs, TRACK_PRECISION);
    } catch (err) {
      /* A deployment whose positions cannot be read is recorded as empty
         rather than skipped, so the next bake does not ask again — and so the
         browser does not either. ERDDAP answers an empty result with a 404,
         which is the commonest reason to land here. */
      failed++;
      void err;
    }
    shards.get(trackYear(d.start)).tracks[d.id] = { end: Math.round(d.end), p };
    if (++done % 200 === 0) {
      console.log(`  ${done}/${todo.length}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

/* Written sorted so a re-bake that changes nothing produces no diff. */
const years = [...shards.keys()].sort((a, b) => a - b);
let missions = 0;
let points = 0;
let bytes = 0;
const summary = [];

for (const year of years) {
  const shard = shards.get(year);
  const ids = Object.keys(shard.tracks).sort();
  const tracks = {};
  let pts = 0;
  for (const id of ids) {
    tracks[id] = shard.tracks[id];
    pts += tracks[id].p.length / 2;
  }
  const doc = { year, every: TRACK_EVERY, precision: TRACK_PRECISION, tracks };
  const text = `${JSON.stringify(doc)}\n`;
  fs.writeFileSync(path.join(OUT, `${year}.json`), text);
  missions += ids.length;
  points += pts;
  bytes += Buffer.byteLength(text);
  summary.push({ year, missions: ids.length, points: pts });
}

const index = {
  baked: now,
  source: DEFAULT_BASE,
  every: TRACK_EVERY,
  precision: TRACK_PRECISION,
  years: summary,
};
fs.writeFileSync(path.join(OUT, 'index.json'), `${JSON.stringify(index)}\n`);

/* Any shard for a year that no longer has archived missions — the catalog
   only grows, so this is a rename or a withdrawal rather than routine. */
for (const file of fs.readdirSync(OUT)) {
  const m = /^(\d{4})\.json$/.exec(file);
  if (m && !shards.has(Number(m[1]))) fs.rmSync(path.join(OUT, file));
}

console.log(`${missions} missions, ${Math.round(points).toLocaleString()} fixes, `
  + `${(bytes / 1024 / 1024).toFixed(2)} MB across ${years.length} shards`);
if (failed) console.log(`${failed} had no readable positions and are baked empty`);
console.log(`→ ${OUT}`);
