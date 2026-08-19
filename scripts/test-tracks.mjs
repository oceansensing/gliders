#!/usr/bin/env node
/**
 * The baked archive: its encoding, and the rule that decides what is drawable.
 *
 *   npm run test:tracks
 *
 * Two halves. The first is the codec and `cleanTrack` against cases built by
 * hand, including the shapes that were actually found in the DAC's positions.
 * The second reads **the committed shards themselves** and asserts the thing
 * the map promises: that no line it draws crosses more ground than a glider
 * could have swum. That one is worth more than any hand-built case — it is
 * checked against 2,476 real missions rather than against my idea of them.
 */

import fs from 'node:fs';
import { check, done, near, ok, section } from './lib/check.mjs';
import {
  INDEX_PATH, MAX_SPEED_MS, MAX_STEP_KM, TRACK_EVERY, TRACK_PRECISION,
  cleanTrack, decodeTrack, encodeTrack, mainRuns, reachable, shardPath, stepKm, swimRuns,
  trackYear,
} from '../src/lib/tracks.ts';

section('the encoding');

{
  const path = [[38.5, -74.5], [38.5123, -74.4987], [38.52, -74.49]];
  const p = encodeTrack(path);
  check('two integers per fix', p.length, path.length * 2);
  ok('the first pair is absolute', p[0] === 385000 && p[1] === -745000, `${p[0]}, ${p[1]}`);
  ok('and the rest are deltas', Math.abs(p[2]) < 200 && Math.abs(p[3]) < 200,
    `${p[2]}, ${p[3]} — the whole point: small numbers where the positions are large ones`);

  const back = decodeTrack(p);
  check('round-trips to the same number of fixes', back.length, path.length);
  for (let i = 0; i < path.length; i++) {
    near(`fix ${i} latitude survives`, back[i][0], path[i][0], 1e-4);
    near(`fix ${i} longitude survives`, back[i][1], path[i][1], 1e-4);
  }

  /* Accumulating deltas as floats drifts; accumulating them as integers and
     dividing once does not. A long mission is where it would show. */
  const long = Array.from({ length: 2000 }, (_, i) => [38 + i * 1e-4, -74 - i * 1e-4]);
  const far = decodeTrack(encodeTrack(long)).at(-1);
  near('two thousand fixes later, still exact', far[0], long.at(-1)[0], 1e-9);

  check('an empty path encodes to nothing', encodeTrack([]).length, 0);
  check('and a fix with no position is skipped', encodeTrack([[NaN, 1], [2, 2]]).length, 2);
  check('a mission is filed by the year it started', trackYear(Date.UTC(2019, 6, 4) / 1000), 2019);
  check('where the shard lives', shardPath(2019), 'data/tracks/2019.json');
}

section('how far a glider gets');

{
  /* A degree of latitude is 111.19 km, everywhere. */
  near('a degree of latitude', stepKm([0, 0], [1, 0]), 111.19, 0.05);
  near('and one of longitude at 60°N is half of one at the equator',
    stepKm([60, 0], [60, 1]), stepKm([0, 0], [0, 1]) / 2, 0.2);
  check('a fix against itself is nowhere', stepKm([38, -74], [38, -74]), 0);

  ok('a normal six-hourly step is reachable', reachable([38, -74], [38.04, -74]),
    `${stepKm([38, -74], [38.04, -74]).toFixed(1)} km`);
  ok(`and ${MAX_STEP_KM} km is not`, !reachable([38, -74], [38.3, -74]),
    `${stepKm([38, -74], [38.3, -74]).toFixed(1)} km — 25 km/day is a glider, 130 is not`);

  /* With the times known the bar is a speed, which catches a jump too short
     to trip the distance rule but far too fast for the minutes it took. */
  ok('a 5 km step in a minute is not swimming',
    !reachable([38, -74], [38.045, -74], 60),
    `${(stepKm([38, -74], [38.045, -74]) * 1000 / 60).toFixed(0)} m/s, over ${MAX_SPEED_MS}`);
  ok('the same 5 km over six hours is', reachable([38, -74], [38.045, -74], 21600));
}

section('a record split into what was swum');

{
  const straight = Array.from({ length: 10 }, (_, i) => [38 + i * 0.04, -74]);
  check('a clean track is one run', cleanTrack(straight).length, 1);
  check('and keeps every fix', cleanTrack(straight)[0].length, 10);

  /**
   * One wrong position, the shape `sp062-20250702T1440` has: the record
   * leaves the shelf for the eastern Atlantic and comes straight back. The
   * fix is dropped rather than the line broken twice, because the vehicle
   * did not go anywhere.
   */
  const spike = [[38, -74], [38.04, -74], [36.27, 37.14], [38.08, -74], [38.12, -74]];
  const cleaned = cleanTrack(spike);
  check('a single bad fix leaves one run', cleaned.length, 1);
  check('with the bad fix dropped', cleaned[0].length, 4);
  ok('and nothing near it left behind',
    cleaned[0].every(([, lon]) => lon < 0), JSON.stringify(cleaned[0]));

  /**
   * The alternating shape, which `ng1116-20240711T0000` has 164 fixes of:
   * the Gulf of Mexico and the mid-Atlantic, back and forth. Every one of
   * the intruders goes, because each is judged against the last fix that was
   * believed rather than against its neighbour.
   */
  const alternating = [];
  for (let i = 0; i < 8; i++) {
    alternating.push([25.7 + i * 0.02, -87.1]);
    alternating.push([13.0, -44.2]);
  }
  const settled = cleanTrack(alternating);
  check('an alternating record comes back as one run', settled.length, 1);
  check('holding only the real half', settled[0].length, 8);

  /**
   * A relocation — `gp_276-20231024T0345-delayed` is off Cape Cod and then
   * off Oregon. Both halves are real; the line between them is not.
   */
  const moved = [
    [39.8, -70.9], [39.84, -70.88], [39.88, -70.86],
    [44.4, -125.3], [44.44, -125.28], [44.48, -125.26],
  ];
  const legs = cleanTrack(moved);
  check('a relocation comes back as two runs', legs.length, 2);
  check('three fixes in the first', legs[0].length, 3);
  check('and three in the second', legs[1].length, 3);
  ok('with no line ruled between them',
    legs[0].at(-1)[1] < -70 && legs[1][0][1] < -125,
    'the pen lifts rather than crossing a continent');

  check('a fix with no position is skipped',
    cleanTrack([[38, -74], [NaN, NaN], [38.04, -74]])[0].length, 2);
  check('a run of one is not a line', cleanTrack([[38, -74], [10, 10]]).length, 0);
  check('and neither is nothing', cleanTrack([]).length, 0);

  /* The index form the deployment page uses, which has to agree with the
     coordinate form the catalog uses. */
  const idx = swimRuns(moved.length, (i) => moved[i]);
  check('swimRuns returns the same split', idx.length, 2);
  check('as indices into the original', idx[1][0], 3);

  /**
   * `gp_276-20231024T0345-delayed`'s shape: five fixes at the institution's
   * dock off Cape Cod, then 671 in the Gulf of Alaska. Both are drawn; only
   * one of them is the mission, and it is the one the view should frame.
   */
  const dock = [Array.from({ length: 5 }, (_, i) => [41.5 + i * 0.001, -70.6]),
    Array.from({ length: 671 }, (_, i) => [47 + i * 0.001, -125])];
  const main = mainRuns(dock);
  check('a handful of dockside fixes is not the mission', main.length, 1);
  check('and the mission is the other one', main[0].length, 671);
  check('two real legs both count', mainRuns([[1, 2, 3], [4, 5, 6]]).length, 2);
  check('and nothing is dropped when everything is small',
    mainRuns([[1], [2], [3]]).length, 3);
  check('an empty record is left alone', mainRuns([]).length, 0);
}

section('the shards that ship');

{
  const dir = 'public/data/tracks';
  ok('the archive is baked', fs.existsSync(`${dir}/index.json`),
    'run `npm run data:tracks` — the map falls back to the DAC without it');

  if (fs.existsSync(`${dir}/index.json`)) {
    const index = JSON.parse(fs.readFileSync(`${dir}/index.json`, 'utf8'));
    check('the index is where the client looks', INDEX_PATH, 'data/tracks/index.json');
    check('baked at the resolution the decoder assumes', index.precision, TRACK_PRECISION);
    check('and the interval it was asked for', index.every, TRACK_EVERY);
    ok('it covers the archive', index.years.length > 15, `${index.years.length} years`);

    const files = new Set(fs.readdirSync(dir).filter((f) => /^\d{4}\.json$/.test(f)));
    const listed = new Set(index.years.map((y) => `${y.year}.json`));
    ok('every shard listed is present',
      [...listed].every((f) => files.has(f)),
      [...listed].filter((f) => !files.has(f)).join(', ') || 'all there');
    ok('and every shard present is listed',
      [...files].every((f) => listed.has(f)),
      [...files].filter((f) => !listed.has(f)).join(', ') || 'nothing stray');

    /**
     * The promise the map makes, checked against the whole archive rather
     * than against a fixture: **no line it draws covers more ground than a
     * glider could have swum**. Every long jump in the DAC's positions has to
     * come out either dropped or as a break.
     */
    let missions = 0;
    let fixes = 0;
    let runs = 0;
    let worst = 0;
    let worstAt = '';
    let rawWorst = 0;
    for (const file of files) {
      const shard = JSON.parse(fs.readFileSync(`${dir}/${file}`, 'utf8'));
      check(`${file} declares the precision it was written at`, shard.precision, TRACK_PRECISION);
      /* The staleness key, without which a mission that reported again would
         be served its old path. Checked over every entry, reported once. */
      const undated = Object.entries(shard.tracks)
        .filter(([, b]) => !(Number.isFinite(b.end) && b.end > 1e9))
        .map(([id]) => id);
      ok(`${file} keys every track on its last report`, undated.length === 0,
        undated.slice(0, 3).join(', ') || `${Object.keys(shard.tracks).length} tracks`);
      for (const baked of Object.values(shard.tracks)) {
        const path = decodeTrack(baked.p, shard.precision);
        if (path.length < 2) continue;
        missions++;
        fixes += path.length;
        for (let i = 1; i < path.length; i++) {
          rawWorst = Math.max(rawWorst, stepKm(path[i - 1], path[i]));
        }
        for (const run of cleanTrack(path)) {
          runs++;
          for (let i = 1; i < run.length; i++) {
            const km = stepKm(run[i - 1], run[i]);
            if (km > worst) { worst = km; worstAt = `${run[i - 1]} → ${run[i]}`; }
          }
        }
      }
    }

    ok('there is an archive to check', missions > 2000 && fixes > 400_000,
      `${missions} missions, ${fixes.toLocaleString()} fixes, ${runs.toLocaleString()} runs`);
    ok('the raw record does contain impossible steps', rawWorst > 1000,
      `the longest is ${rawWorst.toFixed(0)} km — which is why any of this exists`);
    ok('and not one survives into a drawn line', worst <= MAX_STEP_KM,
      `the longest drawn step is ${worst.toFixed(1)} km, cap ${MAX_STEP_KM}  ${worst > MAX_STEP_KM ? worstAt : ''}`);
  }
}

done();
