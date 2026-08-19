/**
 * The catalog: what deployments exist, and what is in one.
 */

import type { DatasetInfo, DeploymentSummary, VariableInfo } from './types.ts';
import { catalogUrl, infoUrl, parseIsoTime } from './url.ts';
import { isFlagColumn, qcColumnFor } from './qc.ts';

export const DEFAULT_BASE = 'https://gliders.ioos.us/erddap';

export interface RequestOptions {
  base?: string;
  signal?: AbortSignal;
  /** Injectable for tests, which have no network. */
  fetchImpl?: typeof fetch;
}

/**
 * ERDDAP answers an empty result with **HTTP 404** and a JSON error body,
 * not with an empty 200. Measured on the DAC: a query matching no rows
 * returns `404` and `message="Not Found: Your query produced no matching
 * results. (nRows = 0)"`. Treating that as a transport failure is the bug
 * this function exists to prevent — a deployment with a gap in it would come
 * back as an error instead of as a gap.
 */
export class ErddapError extends Error {
  readonly status: number;
  /** True when the server said "no rows", which is data, not a failure. */
  readonly empty: boolean;

  constructor(message: string, status: number, empty: boolean) {
    super(message);
    this.name = 'ErddapError';
    this.status = status;
    this.empty = empty;
  }
}

export async function request(
  url: string,
  opts: RequestOptions = {},
): Promise<Response> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(url, { signal: opts.signal });
  if (res.ok) return res;

  let body = '';
  try {
    body = await res.text();
  } catch {
    /* the status is the whole story then */
  }
  const empty = res.status === 404 && /nRows\s*=\s*0/.test(body);
  throw new ErddapError(
    empty ? 'no rows matched' : `${res.status} ${res.statusText}`.trim(),
    res.status,
    empty,
  );
}

/**
 * Every dataset the server currently serves.
 *
 * `allDatasets` carries a row for itself, which is dropped: it is the
 * catalog, not a deployment, and leaving it in puts a fake glider at 0°N 0°E
 * on the map.
 */
export async function listDatasets(
  opts: RequestOptions & { since?: number } = {},
): Promise<DeploymentSummary[]> {
  const base = opts.base ?? DEFAULT_BASE;
  const res = await request(catalogUrl(base, { since: opts.since }), opts);
  const doc = (await res.json()) as {
    table: { columnNames: string[]; rows: unknown[][] };
  };
  const at = index(doc.table.columnNames);
  const out: DeploymentSummary[] = [];

  for (const row of doc.table.rows) {
    const id = String(row[at('datasetID')] ?? '');
    if (!id || id === 'allDatasets') continue;
    const start = time(row[at('minTime')]);
    const end = time(row[at('maxTime')]);
    out.push({
      id,
      title: String(row[at('title')] ?? id),
      institution: String(row[at('institution')] ?? ''),
      start,
      end,
      west: num(row[at('minLongitude')]),
      east: num(row[at('maxLongitude')]),
      south: num(row[at('minLatitude')]),
      north: num(row[at('maxLatitude')]),
    });
  }
  return out;
}

/** Everything `info/<id>/index.json` says, in the shape the page wants. */
export async function datasetInfo(
  id: string,
  opts: RequestOptions = {},
): Promise<DatasetInfo> {
  const base = opts.base ?? DEFAULT_BASE;
  const res = await request(infoUrl(base, id), opts);
  const doc = (await res.json()) as {
    table: { columnNames: string[]; rows: unknown[][] };
  };
  return parseInfo(id, doc);
}

/** Split out so tests can feed it a saved document. */
export function parseInfo(
  id: string,
  doc: { table: { columnNames: string[]; rows: unknown[][] } },
): DatasetInfo {
  const at = index(doc.table.columnNames);
  const rowType = at('Row Type');
  const varName = at('Variable Name');
  const attrName = at('Attribute Name');
  const dataType = at('Data Type');
  const value = at('Value');

  const types = new Map<string, string>();
  const attrs = new Map<string, Record<string, string>>();
  const global: Record<string, string> = {};

  for (const row of doc.table.rows) {
    const kind = String(row[rowType] ?? '');
    const name = String(row[varName] ?? '');
    if (kind === 'variable') {
      types.set(name, String(row[dataType] ?? ''));
    } else if (kind === 'attribute') {
      const key = String(row[attrName] ?? '');
      const val = row[value] === null || row[value] === undefined ? '' : String(row[value]);
      if (name === 'NC_GLOBAL') global[key] = val;
      else {
        const bag = attrs.get(name) ?? {};
        bag[key] = val;
        attrs.set(name, bag);
      }
    }
  }

  const names = new Set(types.keys());
  const variables: VariableInfo[] = [];
  for (const [name, type] of types) {
    const a = attrs.get(name) ?? {};
    variables.push({
      name,
      type,
      units: a.units || undefined,
      longName: a.long_name || undefined,
      standardName: a.standard_name || undefined,
      category: a.ioos_category || undefined,
      range: parseRange(a.actual_range),
      qcColumn: qcColumnFor(name, names),
      ancillary: isAncillary(name, type, a),
    });
  }

  /* `precise_time` is the per-sample clock and `time` the profile's own
     timestamp, repeated down the profile. Both are useful and they are not
     interchangeable: a section drawn against `time` puts a whole profile on
     one vertical line, which is what a section *should* look like, while a
     track drawn against it would stair-step. The section is the main figure,
     so `time` is the default and `precise_time` is what the profile explorer
     asks for.
     Not assumed present: the older datasets carry it, but a future one need
     not, and a missing column is a 404 for the whole request rather than a
     missing column in the result. */
  const pick = (...candidates: string[]): string | undefined =>
    candidates.find((c) => names.has(c));

  const timeVar = pick('time') ?? pick('precise_time') ?? 'time';
  const latVar = pick('latitude', 'precise_lat', 'lat') ?? 'latitude';
  const lonVar = pick('longitude', 'precise_lon', 'lon') ?? 'longitude';

  return {
    id,
    title: global.title || id,
    institution: global.institution || '',
    summary: global.summary || '',
    start: time(global.time_coverage_start),
    end: time(global.time_coverage_end),
    bounds: {
      west: num(global.geospatial_lon_min),
      east: num(global.geospatial_lon_max),
      south: num(global.geospatial_lat_min),
      north: num(global.geospatial_lat_max),
    },
    variables,
    timeVar,
    latVar,
    lonVar,
    depthVar: pick('depth'),
    pressureVar: pick('pressure'),
    attributes: global,
  };
}

/**
 * Columns a reader would never choose to plot.
 *
 * Flags, identifiers and the string columns, plus the position and time
 * columns the page places itself. `ioos_category` does most of the work and
 * is filled in across the DAC; the name patterns catch what it misses.
 *
 * The flight-computer variables — `commanded_*`, `measured_*` — are **not**
 * excluded. They are legitimately interesting (a pilot reading a mission is
 * exactly who wants `measured_avg_climb_rate` against depth), so they stay
 * plottable and simply sort below the science.
 */
function isAncillary(name: string, type: string, a: Record<string, string>): boolean {
  if (type === 'String') return true;
  if (isFlagColumn(name)) return true;
  if (a.ioos_category === 'Quality' || a.ioos_category === 'Identifier') return true;
  if (a.ioos_category === 'Time' || a.ioos_category === 'Location') return true;
  return /^(trajectory|profile_id|wmo_id|crs|platform|instrument_|source_file)/.test(name);
}

function parseRange(s: string | undefined): [number, number] | undefined {
  if (!s) return undefined;
  const parts = s.split(/[,\s]+/).filter(Boolean).map(Number);
  if (parts.length !== 2 || parts.some((p) => p !== p)) return undefined;
  return [parts[0], parts[1]];
}

/** Column lookup by name, so a reordered response cannot shift the fields. */
function index(names: readonly string[]): (name: string) => number {
  const map = new Map(names.map((n, i) => [n, i]));
  return (name: string) => map.get(name) ?? -1;
}

function num(v: unknown): number {
  if (v === null || v === undefined || v === '') return NaN;
  const n = Number(v);
  return n === n ? n : NaN;
}

function time(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v) return parseIsoTime(v);
  return NaN;
}
