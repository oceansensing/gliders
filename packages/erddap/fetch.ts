/**
 * Fetching a deployment, in pieces.
 *
 * **Why in pieces, when one request would do.** Measured against the DAC on
 * `electa-20260807T1633`, an 11-day coastal deployment of 142,378 rows:
 *
 *   whole deployment, one request     11.3 MB   14.8 s
 *   whole deployment, depth-binned     1.6 MB   15.3 s
 *   one day, one request              0.58 MB    1.1 s
 *   one day, depth-binned             0.09 MB    1.2 s
 *
 * The shape of that is the whole design. Server time is roughly **constant
 * per request** and does not fall when the answer gets smaller — the binning
 * happens after the read, so a decimated whole-deployment request costs the
 * same fifteen seconds as the full one. What binning buys is bytes and parse
 * time; what *chunking* buys is the first picture, which arrives in about a
 * second instead of after fifteen.
 *
 * So both, and for different reasons: chunks so something is on screen
 * quickly and keeps growing, binning so each chunk is small enough that the
 * network and the parser are never the thing being waited on.
 *
 * **Windows are sized by elapsed time, not by row count**, and that is the
 * correction the first version needed. Sizing by rows looks obviously right
 * and is wrong for exactly the reason the table above shows: binning cuts
 * the rows by eight and the server time not at all. So a row-sized planner
 * fed a binned request concludes it can afford a thirty-day window, and the
 * reader waits eleven seconds for the second half of an eleven-day mission.
 * The cost being divided up is the server's read, which scales with the
 * *span asked for* — about 1.35 s per day of deployment here — and rows are
 * only a proxy for it that binning breaks. Caught by running it.
 *
 * Concurrency is 3. Four parallel one-day requests measured 4.3 s wall
 * against ~4.4 s of serial time, so the server is queueing rather than
 * parallelising — the concurrency is there to keep a request in flight while
 * another is parsed, not to multiply throughput, and pushing it higher only
 * lengthens the queue in front of the chunk the reader is waiting on.
 */

import type { DatasetInfo, Resolution, TableData } from './types.ts';
import { request, type RequestOptions } from './catalog.ts';
import { ErddapError } from './catalog.ts';
import { parseJsonlCsvStream } from './parse.ts';
import { tabledapUrl } from './url.ts';
import { applyFlags, DEFAULT_REJECT, qcColumnFor } from './qc.ts';

const HOUR = 3600;
const DAY = 86400;

export interface FetchOptions extends RequestOptions {
  /** Columns to ask for. Time, position and depth are added automatically. */
  variables: readonly string[];
  start?: number;
  end?: number;
  /**
   * One row per this many metres of depth per profile. Omit for full rate.
   *
   * Treated as the *finest* bin to try: if the deployment would blow
   * `targetRows` at it, `fetchData` coarsens through `binCandidates` and
   * reports which bin it settled on in `TableData.resolution`.
   */
  binMetres?: number;
  /** Coarser bins to fall back through, finest first. */
  binCandidates?: readonly number[];
  /** Row budget for the whole deployment, used to pick the bin. */
  targetRows?: number;
  /** Blank values their own QARTOD flag rejects. Default true. */
  applyQc?: boolean;
  /** Which flag values to reject. Default: fail (4) and missing (9). */
  reject?: readonly number[];
  /** Called with everything fetched so far, each time a chunk lands. */
  onChunk?: (data: TableData, progress: Progress) => void;
  /** Seconds of wall time to aim for per chunk. The planner scales the probe
      window by how long the probe actually took. */
  targetSeconds?: number;
  /** The first window, whose duration is the measurement everything else is
      sized from — and which is also the first thing drawn, so it is kept
      short enough to be worth looking at quickly. */
  probeSeconds?: number;
  /** Ceiling on the number of requests, so a multi-year deployment does not
      become four hundred of them. */
  maxChunks?: number;
  concurrency?: number;
  /** Injectable clock, so the planner is testable without waiting. */
  now?: () => number;
}

export interface Progress {
  done: number;
  total: number;
  rows: number;
  /** Windows whose response could not be read: a gap in the record, or a
      server that did not answer. `fetchData` throws only when every one of
      them was unreadable and nothing arrived at all. */
  unread: number;
}

/**
 * A deployment, or the part of one asked for.
 *
 * Resolves when every chunk has been tried. A chunk that fails is reported
 * and skipped rather than failing the whole fetch — an hour the server
 * cannot read should cost that hour, not the deployment. `partial` says so
 * on the result, and the page says it on screen.
 *
 * Aborting rejects, because a caller that aborted has something else in
 * flight and does not want this one's half-answer landing on top of it. What
 * was fetched before the abort has already gone out through `onChunk`.
 */
export async function fetchData(
  id: string,
  info: DatasetInfo,
  opts: FetchOptions,
): Promise<TableData> {
  const columns = columnsFor(info, opts);
  const start = pick(opts.start, info.start);
  const end = pick(opts.end, info.end);

  if (!(end > start)) {
    /* A dataset whose coverage attributes are missing or crossed. One
       request for everything is the only honest plan. */
    const only = await chunk(id, info, columns, undefined, undefined, opts, opts.binMetres);
    const parts = [only].filter(nonNull);
    const res: Resolution = opts.binMetres
      ? { kind: 'binned', binMetres: opts.binMetres }
      : { kind: 'full' };
    return finish(parts, columns, info, opts, res, only?.unreadable ?? true);
  }

  /* The probe. How long it takes sizes every window after it, so it is a
     measurement — but it is also the first thing on screen, which is why it
     is six hours rather than the day the first version used. */
  const clock = opts.now ?? (() => Date.now());
  const probeSpan = Math.min(opts.probeSeconds ?? 6 * HOUR, end - start);

  /**
   * **The bin is chosen from the glider, not from a constant**, and the
   * measurements say why a constant cannot work. Vertical sampling varies by
   * an order of magnitude across the archive, and a fixed bin is wrong at
   * both ends of it:
   *
   *   electa   171 m shelf, 11 days   full 142,376 rows   ~2.5 m native
   *            5 m bin →  18,673 (13% of the record)
   *            1 m bin →  71,968 (51%)
   *
   *   ru29     961 m deep, 2 months                       ~5.3 m native
   *            5 m bin → 147,464
   *            1 m bin → 184,868 (only 1.25× more — there is no more)
   *
   * A 5 m bin throws away seven eighths of a shelf glider's profile, where
   * the thermocline it is cutting through is metres thick, and takes almost
   * nothing off a deep glider, which was never sampled that finely. So the
   * finest bin is tried first and coarsened only if the deployment would
   * actually be too large — which is a property of the mission, not a guess
   * made in advance.
   *
   * Rows do **not** scale as 1/bin, so the projection cannot be computed:
   * halving the bin took electa from 18,673 to 44,592 rather than to 93,000,
   * because below the native spacing a finer bin has nothing to return. Each
   * candidate is therefore measured with its own probe rather than
   * extrapolated, at the cost of one short request per step — and the step
   * is rare.
   */
  const candidates = opts.binMetres
    ? [opts.binMetres, ...(opts.binCandidates ?? [])
        .filter((b) => b > opts.binMetres!)]
    : [undefined];
  const target = opts.targetRows ?? 250_000;

  let bin = candidates[0];
  let probe: Part | null = null;
  let probeTook = 1;

  for (let attempt = 0; attempt < candidates.length; attempt++) {
    bin = candidates[attempt];
    const at = clock();
    probe = await chunk(id, info, columns, start, start + probeSpan, opts, bin);
    probeTook = Math.max(clock() - at, 1) / 1000;
    if (!probe || probe.rows === 0) break;
    const projected = probe.rows * ((end - start) / probeSpan);
    if (projected <= target || attempt === candidates.length - 1) break;
  }

  const resolution: Resolution = bin
    ? { kind: 'binned', binMetres: bin }
    : { kind: 'full' };

  const parts: (Part | null)[] = [probe];
  let rows = probe?.rows ?? 0;
  /* Windows whose response could not be read. On this server that is both
     "no rows here" and "the server did not answer" — see `chunk` — so it is
     counted rather than interpreted, and read in aggregate at the end. */
  let unreadable = probe && !probe.unreadable ? 0 : 1;

  /* Seconds of deployment per second of waiting, from the one request just
     made. A failed probe measures nothing, so the fallback is a day — the
     span this was tuned at. */
  const rate = probe && !probe.unreadable ? probeSpan / probeTook : DAY;
  const remaining = end - (start + probeSpan);
  let span = clamp(rate * (opts.targetSeconds ?? 3), HOUR, 30 * DAY);
  /* The ceiling turns a long mission into fewer, larger requests rather than
     into a queue nobody watches drain. */
  const maxChunks = Math.max(1, opts.maxChunks ?? 40);
  if (remaining / span > maxChunks) span = remaining / maxChunks;

  const windows: Array<[number, number]> = [];
  for (let t = start + probeSpan; t < end; t += span) {
    windows.push([t, Math.min(t + span, end)]);
  }

  const total = windows.length + 1;
  opts.onChunk?.(
    finish(parts.filter(nonNull), columns, info, opts, resolution, unreadable > 0),
    { done: 1, total, rows, unread: unreadable },
  );

  const slots: (Part | null)[] = new Array(windows.length).fill(null);
  let done = 1;
  let next = 0;
  const width = Math.max(1, opts.concurrency ?? 3);

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= windows.length) return;
      const [a, b] = windows[i];
      const part = await chunk(id, info, columns, a, b, opts, bin);
      slots[i] = part;
      done++;
      rows += part?.rows ?? 0;
      if (!part || part.unreadable) unreadable++;

      if (opts.onChunk) {
        const have = [probe, ...slots].filter(nonNull);
        opts.onChunk(
          finish(have, columns, info, opts, resolution, unreadable > 0),
          { done, total, rows, unread: unreadable },
        );
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(width, windows.length || 1) }, worker));

  /* **Every window unreadable and nothing to show for it is an outage, not a
     deployment full of gaps**, and the difference has to be told to the
     reader rather than shown as an empty plot. One request cannot
     distinguish them; the whole set can. */
  if (rows === 0 && unreadable === total) {
    throw new ErddapError(
      'the server returned nothing for any part of this deployment',
      0, false,
    );
  }

  return finish(
    [probe, ...slots].filter(nonNull),
    columns, info, opts, resolution, unreadable > 0,
  );
}

interface Part {
  columns: Map<string, Float64Array>;
  rows: number;
  /** The response could not be read at all — which for this server means
      either an empty window or an outage, indistinguishable from one
      request. See `chunk`. */
  unreadable: boolean;
}

/**
 * One request.
 *
 * **An empty window is a 404 whose body a browser is not allowed to read**,
 * and that is the single most surprising thing about this API. ERDDAP
 * answers a query matching no rows with `404` and `nRows = 0` — and its
 * error responses, unlike its successful ones, carry **no
 * `Access-Control-Allow-Origin` header**. So in a browser `fetch` rejects
 * with a bare network `TypeError` before any of this code sees a status, and
 * the `ErddapError.empty` path below only ever runs under Node, where CORS
 * is not enforced.
 *
 * That matters because an empty window is *normal*: a glider on the surface,
 * a day without telemetry, a mission that starts late. Measured on a real
 * deployment, several one-hour windows return nothing at all.
 *
 * So an unreadable chunk is reported as **empty and unreadable** rather than
 * as a failure, and `fetchData` decides what that means in aggregate: some
 * unreadable windows are gaps, all of them unreadable is a server that is
 * not answering. Neither is guessed at on the evidence of one request.
 */
async function chunk(
  id: string,
  info: DatasetInfo,
  columns: readonly string[],
  start: number | undefined,
  end: number | undefined,
  opts: FetchOptions,
  bin: number | undefined,
): Promise<Part | null> {
  const url = tabledapUrl(opts.base ?? 'https://gliders.ioos.us/erddap', id, 'jsonlCSV', columns, {
    start,
    end,
    timeVar: info.timeVar,
    depthVar: bin ? binColumn(info) : undefined,
    binMetres: bin,
  });

  const nothing = (unreadable: boolean): Part => ({
    columns: new Map(columns.map((c) => [c, new Float64Array(0)])),
    rows: 0,
    unreadable,
  });

  try {
    const res = await request(url, opts);
    const parsed = await parseJsonlCsvStream(res, {
      names: columns,
      timeColumns: timeColumns(info, columns),
    });
    return { ...parsed, unreadable: false };
  } catch (err) {
    /* An abort has to propagate: the caller wants it stopped, not skipped. */
    if ((err as Error)?.name === 'AbortError') throw err;
    /* Node's path: the status was readable and said no rows. */
    if (err instanceof ErddapError && err.empty) return nothing(false);
    /* A browser's path for the same server response, and also what a real
       outage looks like. Counted, not judged. */
    return nothing(true);
  }
}

/** Which column the depth bin is taken over. Pressure where a dataset has no
    depth — binning by 5 dbar is close enough to 5 m for an overview, and
    getting an overview beats getting none. */
function binColumn(info: DatasetInfo): string | undefined {
  return info.depthVar ?? info.pressureVar;
}

function timeColumns(info: DatasetInfo, columns: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const c of columns) {
    const v = info.variables.find((x) => x.name === c);
    if (c === info.timeVar || /(^|_)time($|_)/.test(c) || v?.category === 'Time') out.add(c);
  }
  return out;
}

/** The columns a request asks for: what the caller wants, plus what every
    figure needs, plus the flag column of anything being filtered. */
function columnsFor(info: DatasetInfo, opts: FetchOptions): string[] {
  const have = new Set(info.variables.map((v) => v.name));
  const out: string[] = [];
  const add = (name: string | undefined): void => {
    if (name && have.has(name) && !out.includes(name)) out.push(name);
  };

  add(info.timeVar);
  add(info.latVar);
  add(info.lonVar);
  add(info.depthVar);
  add(info.pressureVar);
  for (const v of opts.variables) add(v);

  if (opts.applyQc !== false) {
    for (const v of [...out]) {
      add(qcColumnFor(v, have));
    }
  }
  return out;
}

/** Join the parts, apply the flags, and label the result. */
function finish(
  parts: readonly Part[],
  columns: readonly string[],
  info: DatasetInfo,
  opts: FetchOptions,
  resolution: Resolution,
  partial: boolean,
): TableData {
  const rows = parts.reduce((n, p) => n + p.rows, 0);
  const merged = new Map<string, Float64Array>();

  for (const name of columns) {
    const out = new Float64Array(rows);
    let at = 0;
    for (const p of parts) {
      const src = p.columns.get(name);
      if (src) out.set(src.subarray(0, p.rows), at);
      at += p.rows;
    }
    merged.set(name, out);
  }

  if (opts.applyQc !== false) {
    const have = new Set(columns);
    for (const name of columns) {
      const flagName = qcColumnFor(name, have);
      const values = merged.get(name);
      const flags = flagName ? merged.get(flagName) : undefined;
      if (values && flags) applyFlags(values, flags, opts.reject ?? DEFAULT_REJECT);
    }
  }

  const units = new Map<string, string>();
  for (const name of columns) {
    const v = info.variables.find((x) => x.name === name);
    if (v?.units) units.set(name, v.units);
  }

  return { rows, columns: merged, units, resolution, partial };
}

const nonNull = <T>(x: T | null): x is T => x !== null;
const pick = (a: number | undefined, b: number): number =>
  a !== undefined && Number.isFinite(a) ? a : b;
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
