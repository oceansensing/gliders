/**
 * Building tabledap URLs.
 *
 * ERDDAP's query syntax is not a normal query string and cannot be built with
 * `URLSearchParams`. The variable list is the *whole* query before the first
 * `&`, unnamed and comma-separated, and each `&` after it is a constraint
 * written as an expression — `time>=2026-08-10T00:00:00Z` — where the
 * operator is part of the text rather than a separator. `URLSearchParams`
 * would percent-encode the commas and the `>=` into something the server
 * reads as one nonsense variable name, and then return a 404 that looks like
 * an empty deployment.
 *
 * So the parts are encoded by hand, and only where they must be: `>` `<` `=`
 * and `"` inside constraints, commas never.
 */

/** Percent-encode a constraint's value without touching the operator. */
const enc = (s: string): string =>
  s.replace(/[%"<>&#+ ]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);

/** ERDDAP wants ISO 8601 with a trailing Z, to the second. */
export function isoTime(epochSeconds: number): string {
  return `${new Date(epochSeconds * 1000).toISOString().slice(0, 19)}Z`;
}

/** Parse ERDDAP's `2026-08-10T00:03:51Z` to epoch seconds.
 *
 * By hand rather than `Date.parse`, because this runs once per row and a
 * long deployment is a million of them. The format is fixed-width and the
 * server emits nothing else, so the digits are read by position; anything
 * that does not match falls back to `Date.parse` rather than being guessed
 * at, which covers the few datasets that publish fractional seconds. */
export function parseIsoTime(s: string): number {
  if (s.length === 20 && s.charCodeAt(19) === 90 /* Z */) {
    const y = +s.slice(0, 4);
    const mo = +s.slice(5, 7);
    const d = +s.slice(8, 10);
    const h = +s.slice(11, 13);
    const mi = +s.slice(14, 16);
    const sec = +s.slice(17, 19);
    if (y === y && mo === mo && d === d) {
      return Date.UTC(y, mo - 1, d, h, mi, sec) / 1000;
    }
  }
  const t = Date.parse(s);
  return t === t ? t / 1000 : NaN;
}

export interface QueryOptions {
  /** Epoch seconds, inclusive. */
  start?: number;
  end?: number;
  /** One row per `binMetres` of depth per profile. See `CLAUDE.md` — this is
      the decimation that keeps the section's shape while cutting the rows. */
  binMetres?: number;
  /** The column the depth bin is taken over; `depth` unless a dataset only
      publishes pressure. */
  depthVar?: string;
  /** The column the bin groups by — the profile's own timestamp. */
  timeVar?: string;
  /**
   * One row per interval of the time column — an ERDDAP interval string such
   * as `6hours` or `1day`. Used for a coarse track: a whole mission's path in
   * a few dozen points, which is 3 KB and a fifth of a second rather than the
   * megabytes a full record costs.
   *
   * Ignored when `binMetres` is set; a query takes one `orderByClosest`.
   */
  every?: string;
  /** Extra constraints, already written as ERDDAP expressions. */
  extra?: string[];
}

/**
 * A tabledap URL.
 *
 * `format` is the extension: `csv`, `jsonlCSV`, `json`, `nc`, `csvp`.
 */
export function tabledapUrl(
  base: string,
  id: string,
  format: string,
  variables: readonly string[],
  opts: QueryOptions = {},
): string {
  const root = base.replace(/\/+$/, '');
  const parts: string[] = [variables.join(',')];

  if (opts.start !== undefined && Number.isFinite(opts.start)) {
    parts.push(`${opts.timeVar ?? 'time'}%3E=${isoTime(opts.start)}`);
  }
  if (opts.end !== undefined && Number.isFinite(opts.end)) {
    parts.push(`${opts.timeVar ?? 'time'}%3C=${isoTime(opts.end)}`);
  }
  for (const c of opts.extra ?? []) parts.push(enc(c));

  /* Last, and it has to be: ERDDAP applies the orderBy after the
     constraints, and rejects the query outright if one follows it. */
  if (opts.binMetres && opts.depthVar) {
    const group = `${opts.timeVar ?? 'time'},${opts.depthVar}/${opts.binMetres}`;
    parts.push(`orderByClosest(%22${group}%22)`);
  } else if (opts.every) {
    parts.push(`orderByClosest(%22${opts.timeVar ?? 'time'}/${opts.every}%22)`);
  }

  return `${root}/tabledap/${id}.${format}?${parts.join('&')}`;
}

/** The `info/<id>/index.json` document. */
export function infoUrl(base: string, id: string): string {
  return `${base.replace(/\/+$/, '')}/info/${id}/index.json`;
}

/** The human-facing dataset page, for a "see it on the DAC" link. */
export function datasetPageUrl(base: string, id: string): string {
  return `${base.replace(/\/+$/, '')}/tabledap/${id}.html`;
}

/**
 * The catalog query.
 *
 * `allDatasets` is a real tabledap dataset with a row per active dataset, so
 * it takes constraints like any other. It does **not** take `page` or
 * `itemsPerPage` — those are the *web form's* parameters, and passing them
 * to tabledap is a 400.
 */
export function catalogUrl(base: string, opts: { since?: number } = {}): string {
  const columns = [
    'datasetID', 'title', 'institution',
    'minTime', 'maxTime',
    'minLongitude', 'maxLongitude', 'minLatitude', 'maxLatitude',
  ];
  const parts = [columns.join(',')];
  if (opts.since !== undefined) parts.push(`maxTime%3E=${isoTime(opts.since)}`);
  return `${base.replace(/\/+$/, '')}/tabledap/allDatasets.json?${parts.join('&')}`;
}
