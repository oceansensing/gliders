/**
 * The archive's tracks, baked once and read as a file.
 *
 * **Why this exists.** A finished mission's path never changes again, and
 * there are 2,534 of them. Asking the DAC for one costs about 35 ms and 12 KB
 * — cheap enough that the map fetched a few dozen live and left the rest as
 * dots — but 2,534 of those, per reader, per visit, is not a request anyone
 * should make of somebody else's server to draw a background map. Baked, the
 * whole archive is **about 1.6 MB** and the DAC is asked for nothing that is
 * not still moving.
 *
 * **Split by the year the mission started**, which is the axis the reader
 * already filters on: looking at 2019 loads 2019. It is also what keeps the
 * refresh honest in git — a year that has ended is a file that will never be
 * written again, so a nightly re-bake rewrites one shard rather than all of
 * them.
 *
 * **Archived only.** A glider still reporting grows a few fixes every day,
 * and a baked path would show it stopped. The client fetches those live; this
 * is the part that cannot change.
 *
 * ## The encoding
 *
 * Positions as **deltas between fixed-point integers**, hundredths of a
 * millidegree — the same 11 m the client's `localStorage` cache rounds to,
 * and far finer than a six-hourly fix means anything at. A glider covers
 * about 6 km between fixes, so the deltas are three-digit numbers where the
 * absolute positions are seven-digit ones, and that is the whole trick.
 * Measured over 80 real missions, projected to the archive:
 *
 * | | brotli |
 * |---|---|
 * | `[lat, lon]` pairs at 4 dp | 1.98 MB |
 * | the same, delta-encoded | **1.59 MB** |
 * | deltas at 1e-3 (111 m) | 1.15 MB |
 * | deltas + simplified to 555 m | 0.97 MB |
 *
 * The last two are cheaper and were not taken: a coarser grid and a dropped
 * point are both a different track from the one the deployment page draws,
 * and 400 KB is not worth being unable to say the two are the same path.
 */

/** One shard: every archived mission that started in a given year. */
export interface TrackShard {
  year: number;
  /** The interval the DAC was asked to thin to, e.g. `6hours`. */
  every: string;
  /** Decimal places the integers represent. */
  precision: number;
  tracks: Record<string, BakedTrack>;
}

export interface BakedTrack {
  /**
   * The mission's last report when it was baked, rounded to the second.
   *
   * Not decoration: a deployment that was archived when it was baked and has
   * since reported again is a *different* path, and serving the old one
   * would be wrong rather than merely old. The client compares and refetches.
   */
  end: number;
  /** `[lat0, lon0, dlat, dlon, …]` as integers. Empty if the mission had no
      readable positions — kept so it is not asked for again. */
  p: number[];
  /**
   * When each fix was taken, as deltas in `TIME_UNIT` seconds.
   *
   * Carried because a third of the impossible steps in this archive are not
   * fast, they are *old* — a glider carried somewhere and put back in, whose
   * two ends are 50 km and 25 days apart. Without the clock that is
   * indistinguishable from an afternoon's drifting.
   *
   * Quantised to ten minutes, which costs 0.30 MB across the archive against
   * 1.02 MB at full precision, and is a 1.4% error on a six-hour step —
   * nothing against a threshold of 2.5 m/s. Absent on shards baked before
   * this existed, and everything degrades to the distance rule.
   */
  t?: number[];
}

/** The resolution baked timestamps are stored at. */
export const TIME_UNIT = 600;

/** What shards exist, written beside them so the client need not probe. */
export interface TrackIndex {
  baked: number;
  source: string;
  every: string;
  precision: number;
  years: Array<{ year: number; missions: number; points: number }>;
}

export const TRACK_PRECISION = 4;
export const TRACK_EVERY = '6hours';

/** Where a shard lives, relative to the site root. `withBase` still applies. */
export const shardPath = (year: number): string => `data/tracks/${year}.json`;
export const INDEX_PATH = 'data/tracks/index.json';

/**
 * The year a mission is filed under: the one it started in, in UTC.
 *
 * A deployment that runs through New Year is filed by its start, so it lands
 * in exactly one shard and the client can tell which from the catalog row it
 * already has.
 */
export function trackYear(startSeconds: number): number {
  return new Date(startSeconds * 1000).getUTCFullYear();
}

export function encodeTrack(path: ReadonlyArray<readonly [number, number]>,
  precision: number = TRACK_PRECISION): number[] {
  const e = 10 ** precision;
  const out: number[] = [];
  let pa = 0;
  let po = 0;
  for (const [lat, lon] of path) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const a = Math.round(lat * e);
    const o = Math.round(lon * e);
    out.push(a - pa, o - po);
    pa = a;
    po = o;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * A path the glider could have taken
 * ------------------------------------------------------------------ */

/**
 * **A glider's position record is not always the glider's position.**
 *
 * Drawn straight from the DAC, the archive map grew long straight lines
 * across open ocean — a track leaving the Gulf of Mexico for the mid-Atlantic
 * and back, another jumping from Cape Cod to Oregon. No glider did that.
 * A deployment's dataset is whatever was filed under that id, and that can
 * include a fix taken while the vehicle was on a ship between stations, a
 * shore station's position, a leg recovered and redeployed somewhere else, or
 * a corrupt GPS record.
 *
 * **A record fails in two different ways and they need two different tests.**
 * Sorting every long step in the archive by its *implied speed* separates
 * them cleanly. Steps whose fixes really are about six hours apart, so the
 * distance is a speed:
 *
 * | step | n | median m/s | physically impossible |
 * |---|---|---|---|
 * | 15–20 km | 3,873 | 0.80 | 0 |
 * | 20–25 | 1,851 | 1.00 | 0 |
 * | 25–30 | 718 | 1.14 | 0 |
 * | 30–40 | 531 | 1.37 | 3 |
 * | 40–50 | 137 | 1.94 | 3 |
 * | **50–100** | 118 | **3.17** | 12 |
 * | 100+ | 115 | 35.60 | 34 |
 *
 * **Nothing under 30 km in the entire archive is impossible**, and the first
 * band whose median is impossible is 50–100 km. A glider swims at about
 * 0.3 m/s and the strongest sustained current adds about 2, so the fastest
 * real thing measured — the 99.99th percentile of 24,873 steps — is 1.82 m/s.
 * Fifty kilometres in six hours is 2.31 m/s, which sits just above that and
 * well below the artefacts. This is why the cut is not tighter: an earlier
 * 20 km — 0.93 m/s — split 16.3% of missions, and what it was splitting was
 * Spray gliders and `silbo` riding the Gulf Stream for real.
 *
 * So two rules:
 *
 * - **over 50 km in one step** — impossible whatever the clock says, and the
 *   backstop that catches a vehicle flown somewhere during a long silence,
 *   which no speed test can (4,000 km over 30 days is 1.54 m/s);
 * - **over 2.5 m/s**, wherever the times are known — above the fastest
 *   current in the ocean. This is the physically meaningful test, and it is
 *   what the distance cut is a proxy for at six-hourly sampling. It does the
 *   real work on the deployment page, where fixes are seconds apart and no
 *   distance rule would ever trip.
 *
 * Together they break **239 steps, 0.047%, on 141 missions**, and 4.8% of
 * missions come out in more than one run.
 *
 * ## A rule that was tried and does not survive its own measurement
 *
 * A third of the long steps are not a speed at all — 2,523 of 7,343 follow a
 * gap of over nine hours — so a gap rule looked obviously right: four missed
 * reports and the vehicle has moved, therefore nobody watched it go. Breaking
 * on *a gap over 24 hours with more than 15 km covered* caught 474 steps that
 * the two rules above miss.
 *
 * Then those 474 were measured. Their median is **30 km over 2.1 days, which
 * is 0.16 m/s**, and **434 of them are slower than 0.3 m/s** — slower than a
 * glider swims unaided. They are not vehicles that were carried; they are
 * vehicles that quietly kept swimming while the satellite link was down. The
 * rule more than doubled the missions that split, 118 to 292, and what it was
 * splitting were exactly the fast Spray gliders it was meant to protect.
 *
 * The lesson is worth keeping: **a long gap is evidence that nobody was
 * watching, not evidence that anything happened.** It was removed.
 *
 * Both surviving rules **break the line rather than bridge it**, which is what
 * the plots do with a gap and for the same reason. And a fix unreachable from
 * *both* neighbours while they are reachable from each other is dropped
 * outright — that is one wrong position, not a vehicle that went somewhere.
 */
export const MAX_STEP_KM = 50;
export const MAX_SPEED_MS = 2.5;

/**
 * The runs that are the mission, rather than a handful of stray fixes.
 *
 * `gp_276-20231024T0345-delayed` is a Station Papa glider, and its record
 * opens with **five** fixes off Cape Cod — the institution's dock, three
 * thousand miles from the water it flew in — followed by 671 in the Gulf of
 * Alaska. Breaking the line stops the map ruling a route across North
 * America, but the deployment page still opened zoomed out to fit both, with
 * "deployed" pinned to Massachusetts.
 *
 * Everything is still drawn. This decides only what the view frames and where
 * the two end markers go, which is a question about the mission rather than
 * about the record. A run holding under 2% of the fixes is not the mission;
 * if that leaves nothing, nothing is dropped.
 */
export function mainRuns<T extends { length: number }>(runs: readonly T[],
  share = 0.02): T[] {
  const total = runs.reduce((n, r) => n + r.length, 0);
  if (!total) return [...runs];
  const main = runs.filter((r) => r.length >= total * share);
  return main.length ? main : [...runs];
}

/** Great-circle distance in kilometres. */
export function stepKm(a: readonly [number, number], b: readonly [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLon = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Whether a straight line between two fixes is a fair sketch of the path. */
export function reachable(a: readonly [number, number], b: readonly [number, number],
  dtSeconds?: number): boolean {
  const km = stepKm(a, b);
  if (!(km <= MAX_STEP_KM)) return false;
  if (dtSeconds === undefined || !(dtSeconds > 0)) return true;
  return (km * 1000) / dtSeconds <= MAX_SPEED_MS;
}

/**
 * A position record, split into the runs a glider could actually have swum.
 *
 * Returns runs of two or more fixes; a mission whose positions are all
 * unreachable from one another returns none, and its dot falls back to the
 * bounding box, which is where it was before there were tracks at all.
 *
 * `times` is optional because the baked archive does not carry them — at a
 * six-hourly cadence the distance rule is the binding one anyway, and the
 * seconds would be half the file for a test that has already been made.
 */
export function cleanTrack(
  points: ReadonlyArray<readonly [number, number]>,
  times?: ArrayLike<number>,
): Array<Array<[number, number]>> {
  return swimRuns(points.length, (i) => points[i], times && ((i) => times[i]))
    .map((run) => run.map((i) => [points[i][0], points[i][1]] as [number, number]));
}

/**
 * The same rule, over indices, for a caller carrying more than positions.
 *
 * The deployment page's track holds a value and a timestamp beside every fix
 * and colours by them, so it cannot take coordinates back — it needs to know
 * *which* fixes survived. `cleanTrack` is this with the lookups filled in.
 */
export function swimRuns(
  n: number,
  at: (i: number) => readonly [number, number],
  time?: (i: number) => number,
): number[][] {
  const gap = (i: number, j: number): number | undefined => {
    if (!time) return undefined;
    const a = time(i);
    const b = time(j);
    return Number.isFinite(a) && Number.isFinite(b) ? b - a : undefined;
  };
  const finite = (i: number): boolean => {
    const p = at(i);
    return Number.isFinite(p[0]) && Number.isFinite(p[1]);
  };

  /* One pass, carrying the last fix that was believed. A fix unreachable
     from it is dropped when the *next* one is reachable from it instead —
     that is the signature of a single wrong position rather than a vehicle
     that moved, and it handles a run of them, because each bad fix in turn
     is compared against the last good one. */
  const keep: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!finite(i)) continue;
    if (!keep.length) { keep.push(i); continue; }
    const prev = keep[keep.length - 1];
    if (reachable(at(prev), at(i), gap(prev, i))) { keep.push(i); continue; }
    if (i + 1 < n && finite(i + 1) && reachable(at(prev), at(i + 1), gap(prev, i + 1))) continue;
    keep.push(i);
  }

  const runs: number[][] = [];
  let run: number[] = [];
  for (let k = 0; k < keep.length; k++) {
    const i = keep[k];
    if (k > 0 && !reachable(at(keep[k - 1]), at(i), gap(keep[k - 1], i))) {
      if (run.length > 1) runs.push(run);
      run = [];
    }
    run.push(i);
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

export function decodeTrack(p: readonly number[],
  precision: number = TRACK_PRECISION): Array<[number, number]> {
  const e = 10 ** precision;
  const out: Array<[number, number]> = [];
  let a = 0;
  let o = 0;
  /* Accumulated as integers and divided at the end, never accumulated as
     floats: adding 0.0001 four hundred times drifts, adding 1 does not. */
  for (let i = 0; i + 1 < p.length; i += 2) {
    a += p[i];
    o += p[i + 1];
    out.push([a / e, o / e]);
  }
  return out;
}

/** Seconds since the epoch, as deltas in `TIME_UNIT`. Most of a mission's
    steps are the same number, which is what makes the series compress. */
export function encodeTimes(seconds: ArrayLike<number>, keep?: readonly number[]): number[] {
  const out: number[] = [];
  let prev = 0;
  const n = keep ? keep.length : seconds.length;
  for (let k = 0; k < n; k++) {
    const s = seconds[keep ? keep[k] : k];
    const u = Number.isFinite(s) ? Math.round(s / TIME_UNIT) : prev;
    out.push(u - prev);
    prev = u;
  }
  return out;
}

export function decodeTimes(t: readonly number[] | undefined): number[] | undefined {
  if (!t || !t.length) return undefined;
  const out: number[] = [];
  let u = 0;
  for (const d of t) {
    u += d;
    out.push(u * TIME_UNIT);
  }
  return out;
}
