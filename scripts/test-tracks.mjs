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
  TIME_UNIT, cleanTrack, decodeTimes, decodeTrack, encodeTimes, encodeTrack, mainRuns,
  reachable, shardPath, stepKm, swimRuns, swimTrack, trackYear,
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
  /* 30 km in six hours is 1.4 m/s. That is not a glider swimming, but it is a
     glider in the Gulf Stream, and the whole archive contains no impossible
     step below 30 km. The cut is above it deliberately. */
  ok('a fast but real Gulf Stream step still is',
    reachable([38, -74], [38.27, -74], 21600),
    `${stepKm([38, -74], [38.27, -74]).toFixed(1)} km in 6 h`);
  ok(`and ${MAX_STEP_KM} km in one step is not, whatever the clock says`,
    !reachable([38, -74], [38.55, -74], 30 * 86400),
    `${stepKm([38, -74], [38.55, -74]).toFixed(1)} km`);

  /* With the times known the bar is a speed, which catches a jump too short
     to trip the distance rule but far too fast for the minutes it took. */
  ok('a 5 km step in a minute is not swimming',
    !reachable([38, -74], [38.045, -74], 60),
    `${(stepKm([38, -74], [38.045, -74]) * 1000 / 60).toFixed(0)} m/s, over ${MAX_SPEED_MS}`);
  ok('the same 5 km over six hours is', reachable([38, -74], [38.045, -74], 21600));

  /**
   * **A long gap is not, by itself, evidence of anything.** A rule breaking
   * on one was tried and removed: 434 of the 474 steps it caught were slower
   * than 0.3 m/s, which is slower than a glider swims unaided — vehicles that
   * quietly kept going while the satellite link was down, not vehicles that
   * were carried. It doubled the missions that split and what it split were
   * the fast Spray gliders it was meant to protect.
   */
  ok('a week of silence with the glider still swimming is a path',
    reachable([38, -74], [38.25, -74], 5 * 86400),
    `${stepKm([38, -74], [38.25, -74]).toFixed(0)} km over 5 days — `
    + `${(stepKm([38, -74], [38.25, -74]) * 1000 / (5 * 86400)).toFixed(2)} m/s, it swam that`);
  /* What no speed test can catch, and why the distance cap has to stay: a
     vehicle flown across an ocean during a long silence looks slow. */
  ok('but a flight across an ocean during a silence is not',
    !reachable([38, -74], [38, -30], 20 * 86400),
    `${stepKm([38, -74], [38, -30]).toFixed(0)} km at `
    + `${(stepKm([38, -74], [38, -30]) * 1000 / (20 * 86400)).toFixed(2)} m/s — `
    + 'a plausible speed, an implausible journey');

  /**
   * **A day of silence is normal operations; a month is a recovery.** A
   * glider deployment does not go quiet for a season and resume, so past
   * `MAX_GAP_S` the record has stopped being one deployment whatever the two
   * ends look like. This is what separates the 86-day
   * `cp_374-20140416T1634-delayed` from the single fix, 760 days later, that
   * had it filed as an 846-day mission.
   */
  ok('a fortnight of silence still joins up',
    reachable([38, -74], [38.05, -74], 14 * 86400));
  ok('but two months does not, however short the step',
    !reachable([38, -74], [38.005, -74], 60 * 86400),
    `${stepKm([38, -74], [38.005, -74]).toFixed(1)} km — the distance is not the point`);
}

section('the clock');

{
  const secs = [1_700_000_000, 1_700_021_600, 1_700_043_200, 1_700_500_000];
  const back = decodeTimes(encodeTimes(secs));
  check('one entry per fix', back.length, secs.length);
  for (let i = 0; i < secs.length; i++) {
    ok(`fix ${i} lands within the quantisation`,
      Math.abs(back[i] - secs[i]) <= TIME_UNIT / 2,
      `${back[i]} vs ${secs[i]}, unit ${TIME_UNIT} s`);
  }
  /* The gaps are what the rules read, and they have to survive rounding well
     enough to be compared against six hours and a day. */
  const gap = back[1] - back[0];
  ok('a six-hour gap survives as one', Math.abs(gap - 21600) <= TIME_UNIT,
    `${(gap / 3600).toFixed(2)} h`);

  check('a track with no clock decodes to nothing', decodeTimes(undefined), undefined);
  check('and so does an empty one', decodeTimes([]), undefined);

  /* Rows without a position are dropped from the path, so the clock has to be
     dropped in the same places or every later fix is timed wrong. */
  const kept = [0, 2, 3];
  const aligned = decodeTimes(encodeTimes(secs, kept));
  check('the clock follows the fixes that survived', aligned.length, 3);
  ok('and stays aligned with them',
    Math.abs(aligned[1] - secs[2]) <= TIME_UNIT / 2, `${aligned[1]} vs ${secs[2]}`);
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
   * The clock has to survive the split with the fixes it belongs to, or a
   * stretch is coloured by when some *other* stretch happened. Dropping a bad
   * fix is where that goes wrong most easily: the position goes and the
   * timestamp has to go with it.
   */
  /* Six-hourly, because that is what the record is: a clock with the fixes
     seconds apart would make every ordinary 4 km step read as impossible,
     which is the speed rule working rather than a bug. */
  const clock = [0, 21600, 43200, 64800, 86400];
  const swum = swimTrack(spike, clock);
  check('a run carries a clock when the record has one', swum.length, 1);
  check('with one time per surviving fix', swum[0].at.length, swum[0].pts.length);
  ok('and the dropped fix takes its timestamp with it',
    !swum[0].at.includes(43200), JSON.stringify(swum[0].at));
  ok('the times left are the ones that belong to the positions left',
    JSON.stringify(swum[0].at) === JSON.stringify([0, 21600, 64800, 86400]),
    JSON.stringify(swum[0].at));
  check('and no clock means no clock',
    swimTrack(straight)[0].at, undefined);

  /**
   * `gp_276-20231024T0345-delayed`'s shape: five fixes at the institution's
   * dock off Cape Cod, then 671 in the Gulf of Alaska. Both are drawn; only
   * one of them is the mission, and it is the one the view should frame.
   */
  const dock = [Array.from({ length: 5 }, (_, i) => [41.5 + i * 0.001, -70.6]),
    Array.from({ length: 671 }, (_, i) => [47 + i * 0.001, -125])];
  const size = (r) => r.length;
  const main = mainRuns(dock, size);
  check('a handful of dockside fixes is not the mission', main.length, 1);
  check('and the mission is the other one', main[0].length, 671);
  check('two real legs both count', mainRuns([[1, 2, 3], [4, 5, 6]], size).length, 2);
  check('and nothing is dropped when everything is small',
    mainRuns([[1], [2], [3]], size).length, 3);
  check('an empty record is left alone', mainRuns([], size).length, 0);
}

section('a stretch is coloured by when it happened');

{
  /**
   * The colour runs over one absolute clock shared by every track on screen.
   * Read off the record it is a fact; interpolated from the fix index it
   * assumes the fixes are evenly spaced in time, and a mission with a gap in
   * it is exactly where that assumption fails and where the colour has
   * something to say.
   *
   * A mission that reported for a day, went quiet for three weeks, and came
   * back: two thirds of its fixes are in the first day. Three weeks rather
   * than a month deliberately — this is about colour, and a gap long enough
   * to end the record would split it and prove nothing.
   */
  const day = 86400;
  const t0 = 1_600_000_000;
  const pts = [];
  const at = [];
  for (let i = 0; i < 4; i++) { pts.push([38 + i * 0.02, -74]); at.push(t0 + i * 3600 * 6); }
  for (let i = 0; i < 2; i++) { pts.push([38.08 + i * 0.02, -74]); at.push(t0 + 21 * day + i * 3600 * 6); }

  const runs = swimTrack(pts, at);
  check('a silence short of a month keeps it one run', runs.length, 1);
  check('with every fix', runs[0].pts.length, 6);

  const span = at[at.length - 1] - t0;
  const byClock = (i) => (runs[0].at[i] - t0) / span;
  const byIndex = (i) => i / (pts.length - 1);

  /* The last fix before the silence is under a day into a 21-day record. */
  near('read off the clock, the pre-gap fix sits at the start', byClock(3), 0.035, 0.005);
  near('interpolated, it sits over half way', byIndex(3), 0.6, 0.001);
  ok('which is the whole difference',
    Math.abs(byClock(3) - byIndex(3)) > 0.5,
    `${(byClock(3) * 100).toFixed(1)}% of the mission's span against `
    + `${(byIndex(3) * 100).toFixed(1)}% of its fixes`);
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

      /* And the clock, without which a glider carried somewhere over a week
         is indistinguishable from one that drifted there. */
      const clockless = Object.entries(shard.tracks)
        .filter(([, b]) => b.p.length > 0 && (!b.t || b.t.length * 2 !== b.p.length))
        .map(([id]) => id);
      ok(`${file} carries a clock beside every path`, clockless.length === 0,
        clockless.slice(0, 3).join(', ') || 'one entry per fix');
      for (const baked of Object.values(shard.tracks)) {
        const path = decodeTrack(baked.p, shard.precision);
        if (path.length < 2) continue;
        missions++;
        fixes += path.length;
        for (let i = 1; i < path.length; i++) {
          rawWorst = Math.max(rawWorst, stepKm(path[i - 1], path[i]));
        }
        for (const run of cleanTrack(path, decodeTimes(baked.t))) {
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
