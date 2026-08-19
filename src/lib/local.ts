/**
 * Raw Slocum files, read on the reader's own machine.
 *
 * The decode is `@c4po/slocum`'s, unchanged — a validated port of
 * `SlocumIO.jl`, checked against `dbdreader`. What this module adds is the
 * adapter: a decoded `Table` becomes the same `Source` the DAC path
 * produces, so the map, the sections, the T–S diagram and the profile
 * explorer are literally the same components. That equivalence is the point
 * of the whole local page, and it is why `lib/deployment.ts` takes columns
 * rather than an ERDDAP response.
 *
 * **Nothing is uploaded.** Files are read with `FileReader`/`arrayBuffer`
 * and decoded in this tab. The page says so, and the CSP has no endpoint to
 * send them to.
 *
 * Exports are deliberately absent. The decoder on oceansensing.org already
 * writes CSV, netCDF-3 and OG1.0 from these same files and is tested against
 * a reference; a second implementation here would be a second thing to keep
 * right. The page links to it.
 */

import {
  openDbd, readSeries, buildTable, splitDeployments, deriveSeawater,
  nmeaToDecimal, isLatLonSensor, isLatitudeSensor,
  type Deployment, type Series, type Table,
} from '@c4po/slocum';
import { spiciness0, zFromP } from '@c4po/teos10';
import type { SalinityAtlas } from '@c4po/teos10/atlas';
import type { Source } from './figure.ts';
import type { Plottable } from './variables.ts';

/** A file the reader handed over, decoded or not. */
export interface Loaded {
  name: string;
  series: Series[];
}

export interface DecodeReport {
  deployments: Deployment[];
  /** Files that needed a `.cac` nobody supplied, by the CRC they asked for. */
  missingCaches: Map<string, string[]>;
  /** Files that failed for any other reason. */
  failed: Array<{ name: string; reason: string }>;
  /** Files with no usable clock, which cannot be placed in a deployment. */
  undated: string[];
}

/** `<crc>.cac` sensor lists, by CRC. Slocum files are factored: without the
    matching cache a file has no sensor names at all. */
export type CacheStore = Map<string, string>;

const CACHE_NAME = /([0-9a-f]{8})\.(cac|ccc)$/i;

/** Sort the reader's files into caches and data, then decode. */
export async function decodeFiles(
  files: readonly File[],
  caches: CacheStore,
): Promise<DecodeReport> {
  const data: File[] = [];
  for (const file of files) {
    const match = CACHE_NAME.exec(file.name);
    if (match) caches.set(match[1].toLowerCase(), await file.text());
    else data.push(file);
  }

  const loaded: Loaded[] = [];
  const missingCaches = new Map<string, string[]>();
  const failed: Array<{ name: string; reason: string }> = [];

  for (const file of data) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      /* Opened twice in the worst case: once to learn which cache it wants,
         and again with it. `openDbd` throws `MissingCacheError` carrying the
         CRC, which is the only way to know which file to ask for. */
      let dbd;
      try {
        dbd = openDbd(bytes, { name: file.name });
      } catch (error) {
        const crc = crcOf(error);
        if (!crc) throw error;
        const text = caches.get(crc.toLowerCase());
        if (!text) {
          const wanted = missingCaches.get(crc) ?? [];
          wanted.push(file.name);
          missingCaches.set(crc, wanted);
          continue;
        }
        dbd = openDbd(bytes, { name: file.name, cache: text });
      }
      loaded.push({ name: file.name, series: readSeries(dbd) });
    } catch (error) {
      failed.push({ name: file.name, reason: (error as Error).message });
    }
  }

  const { deployments, undated } = splitDeployments(
    loaded.map((l) => ({ file: l.name, series: l.series })),
  );
  return { deployments, missingCaches, failed, undated };
}

/** `MissingCacheError` carries the CRC it wanted; read it without importing
    the class, which is not part of the package's public surface. */
function crcOf(error: unknown): string | null {
  const e = error as { crc?: string | number; name?: string; message?: string };
  if (e?.crc !== undefined) return String(e.crc);
  const m = /([0-9a-f]{8})/i.exec(e?.message ?? '');
  return m ? m[1] : null;
}

/**
 * A decoded deployment, as the figures want it.
 *
 * The science computer and the flight computer keep separate clocks and
 * separate sample rates, so a rectangular table needs one time base and
 * everything interpolated onto it — `buildTable`'s `interpolate` join, whose
 * default base is the densest series, which is the honest choice.
 *
 * Position needs care that the DAC path does not: a Slocum writes latitude
 * and longitude as NMEA `DDDMM.MMMM`, which is a number, so nothing about
 * the value says it is not degrees. `3936.313` is 39.605°N, and read
 * naively it is a latitude off the map. The decoder knows which sensors are
 * NMEA; this converts them.
 */
export function toSource(
  deployment: Deployment,
  atlas: SalinityAtlas | null,
): { source: Source; table: Table; notes: string[] } {
  const table = buildTable(deployment.series, { join: 'interpolate' });
  const notes = [...table.notes];

  /* The seawater properties, from the package that knows this format's unit
     traps — conductivity in S/m and pressure in bar, both ×10 from what
     TEOS-10 wants, both silent when wrong. Its notes are shown rather than
     swallowed, including the one that says when SA is really SR. */
  const derived = deriveSeawater(table, { atlas });
  notes.push(...derived.notes);
  const columns = [...table.columns, ...derived.columns];

  /* Spiciness is the one property the decoder's own derivation does not
     produce, and it is a pure function of the SA and CT it just did — so it
     is computed from those rather than by running a second chain from the
     conductivity, which would mean a second copy of this format's unit
     traps. `salinity_absolute` or `salinity_reference` depending on whether
     the atlas answered; either is what SA means here, and the note above
     already says which. */
  const sa = derived.columns.find((c) => c.name.startsWith('salinity_'))?.values;
  const ct = derived.columns.find((c) => c.name === 'temperature_conservative')?.values;
  if (sa && ct) {
    const spice = new Float64Array(table.rows).fill(NaN);
    for (let i = 0; i < table.rows; i++) {
      if (sa[i] === sa[i] && ct[i] === ct[i]) spice[i] = spiciness0(sa[i], ct[i]);
    }
    columns.push({
      name: 'spice0', unit: 'kg/m^3', values: spice, source: 'derived',
      from: 'derived from Absolute Salinity and Conservative Temperature',
    });
  }

  const out = new Map<string, Float64Array>();
  out.set('time', table.time);
  for (const column of columns) out.set(column.name, column.values);

  /* NMEA → decimal degrees, under names the rest of the page recognises.
     The originals stay, because a reader who wants to see what the glider
     actually wrote should be able to. */
  const lat = pickPosition(columns, true);
  const lon = pickPosition(columns, false);
  const latitude = lat ? decimalDegrees(lat.values) : undefined;
  if (latitude) out.set('latitude', latitude);
  if (lon) out.set('longitude', decimalDegrees(lon.values));

  /**
   * A depth axis, in metres.
   *
   * Three things make this necessary rather than a convenience. A Slocum
   * writes pressure in **bar**, so the raw column plotted as a y-axis is a
   * section labelled in a unit no oceanographer reads depth in and a tenth
   * of the number they expect. `m_depth` — the flight computer's own answer
   * — looks like the obvious substitute and is not: it is sampled at the
   * flight computer's slow rate, and on the fixture segment here it covers
   * 3.1 to 4.0 m across a profile whose temperature moves 9 °C, because the
   * dive itself was never sampled. And `buildTable` renames a sensor both
   * computers wrote to `sci_water_pressure_tbd` / `_sbd`, so a lookup by
   * bare name finds neither.
   *
   * So depth is computed, from the science pressure, through TEOS-10's own
   * pressure-to-depth with the latitude it happened at — which is the same
   * quantity the DAC publishes as `depth`, under the same name, so the
   * figures do not need to know which page they are on.
   */
  const pressure = pickPressure(columns);
  if (pressure) {
    const scale = /^bar$/i.test(pressure.unit) ? 10 : 1;
    const depth = new Float64Array(table.rows).fill(NaN);
    for (let i = 0; i < table.rows; i++) {
      const p = pressure.values[i] * scale;
      if (!(p === p)) continue;
      const phi = latitude && latitude[i] === latitude[i] ? latitude[i] : 0;
      depth[i] = -zFromP(p, phi);
    }
    out.set('depth', depth);
    if (scale === 10) {
      notes.push(
        `Depth is computed from ${pressure.name}, read as bar and converted to `
        + 'dbar, then through TEOS-10 at the latitude of each sample.',
      );
    }
  }

  /* The variable list is built from what `out` actually holds, not from the
     decoded table — otherwise the columns computed just above (depth, and
     the decimal-degree position) would have no entry and could not be put on
     an axis. */
  const described = [...out.keys()].map((name) => {
    const column = columns.find((c) => c.name === name);
    return {
      name,
      unit: column?.unit ?? (name === 'depth' ? 'm' : name.startsWith('lat') || name.startsWith('lon') ? 'deg' : ''),
      source: column?.source ?? (name === 'time' ? 'recorded' : 'derived'),
    };
  });

  return {
    source: {
      columns: out,
      rows: table.rows,
      variables: variablesForTable(described),
      timeVar: 'time',
    },
    table,
    notes,
  };
}

/**
 * What a decoded file offers, as the figures' `Plottable`s.
 *
 * A Slocum table is a different world from a DAC dataset: hundreds of
 * sensors with names like `sci_water_cond` and `m_de_oil_vol`, units in the
 * glider's own spelling (`degc`, `nodim`, `bar`), and no `ioos_category` to
 * sort them by. So the ranking is by what a reader actually opens first —
 * the derived seawater properties and the CTD — with everything else after,
 * and nothing hidden.
 */
export function variablesForTable(
  columns: readonly { name: string; unit: string; source: string }[],
): Plottable[] {
  const KNOWN: Record<string, { label: string; map: string; rank: number }> = {
    depth: { label: 'Depth', map: 'cmo.deep', rank: 960 },
    temperature_conservative: { label: 'Conservative Temperature', map: 'cmo.thermal', rank: 11 },
    salinity_absolute: { label: 'Absolute Salinity', map: 'cmo.haline', rank: 21 },
    salinity_reference: { label: 'Reference Salinity', map: 'cmo.haline', rank: 21 },
    salinity_practical: { label: 'Practical salinity', map: 'cmo.haline', rank: 22 },
    sigma0: { label: 'Potential density anomaly σ₀', map: 'cmo.dense', rank: 40 },
    density: { label: 'In-situ density', map: 'cmo.dense', rank: 41 },
    spice0: { label: 'Spiciness π₀', map: 'cmo.balance', rank: 42 },
    sound_speed: { label: 'Sound speed', map: 'cmo.speed', rank: 43 },
    sci_water_temp: { label: 'Temperature', map: 'cmo.thermal', rank: 10 },
    sci_rbrctd_temperature_00: { label: 'Temperature (RBR)', map: 'cmo.thermal', rank: 10 },
    sci_water_cond: { label: 'Conductivity', map: 'cmo.haline', rank: 60 },
    sci_water_pressure: { label: 'Pressure', map: 'cmo.deep', rank: 970 },
    m_depth: { label: 'Depth (flight)', map: 'cmo.deep', rank: 960 },
    latitude: { label: 'Latitude', map: 'cmo.balance', rank: 980 },
    longitude: { label: 'Longitude', map: 'cmo.balance', rank: 981 },
    time: { label: 'Time', map: 'cmo.thermal', rank: 951 },
  };
  const AXIS = new Set(['time', 'latitude', 'longitude', 'sci_water_pressure', 'm_depth', 'depth']);

  const out: Plottable[] = [{
    name: 'time', label: 'Time', units: '', colormap: 'cmo.thermal',
    rank: 951, derived: false, section: false,
  }];

  for (const c of columns) {
    const known = KNOWN[c.name];
    out.push({
      name: c.name,
      label: known?.label ?? c.name,
      units: prettyUnit(c.unit),
      colormap: known?.map ?? 'viridis',
      rank: known?.rank ?? (c.source === 'derived' ? 100 : 500),
      derived: c.source === 'derived',
      section: !AXIS.has(c.name),
    });
  }
  return out.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
}

/** The glider's own unit spellings, as they should be printed. */
function prettyUnit(unit: string): string {
  const table: Record<string, string> = {
    degc: '°C', nodim: '', 'kg/m^3': 'kg/m³', 'm/s': 'm/s',
    'g/kg': 'g/kg', PSU: '', bar: 'bar', 's/m': 'S/m', rad: 'rad',
  };
  return table[unit] ?? (unit === 'X' ? '' : unit);
}

/**
 * The pressure column to measure depth against.
 *
 * The science CTD's, where there is one: the flight computer's copy is what
 * was relayed to it, at its own slower rate. `buildTable` suffixes a sensor
 * both computers wrote with `_tbd` / `_sbd`, so the match has to allow for
 * that — a bare-name lookup finds nothing on exactly the files that carry
 * both, which is most of them.
 */
function pickPressure(
  columns: readonly { name: string; unit: string; values: Float64Array }[],
): { name: string; unit: string; values: Float64Array } | undefined {
  const candidates = columns.filter((c) => /pressure|_pres(_|$)/i.test(c.name));
  const science = candidates.filter((c) => /^sci_/.test(c.name));
  const pool = science.length ? science : candidates;
  return pool.find((c) => /_tbd$/.test(c.name))
    ?? pool.find((c) => !/_sbd$/.test(c.name))
    ?? pool[0];
}

function pickPosition(
  columns: readonly { name: string; values: Float64Array }[],
  wantLatitude: boolean,
): { name: string; values: Float64Array } | undefined {
  const candidates = columns.filter(
    (c) => isLatLonSensor(c.name) && isLatitudeSensor(c.name) === wantLatitude,
  );
  /* `m_gps_*` is a fix; `m_*` is the dead-reckoned estimate between fixes.
     Preferring the fix keeps the track on the positions the glider actually
     measured. */
  return candidates.find((c) => /gps/.test(c.name)) ?? candidates[0];
}

function decimalDegrees(values: Float64Array): Float64Array {
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = nmeaToDecimal(values[i]);
  return out;
}
