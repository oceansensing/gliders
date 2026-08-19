/**
 * What a variable is called on screen, and what it should be drawn in.
 *
 * The DAC's own `long_name` is often the bare column name (`electa`'s
 * temperature is "temperature"), so a small table of the fields anyone
 * actually reads a glider section in is worth having. Everything not in it
 * falls back to the dataset's `long_name`, then to the column name — no
 * variable is ever hidden for being unrecognised.
 *
 * The colormaps are cmocean's, matched to the field the way that library
 * intends: `thermal` for temperature, `haline` for salinity, `dense` for
 * density, `balance` for a diverging quantity like spice, `oxy` for oxygen,
 * `algae` for chlorophyll, `matter` for CDOM, `turbid` for backscatter,
 * `speed` for sound speed and currents. A section drawn in viridis is
 * readable; drawn in the map its field is conventionally read in, it is
 * comparable with every other section the reader has seen.
 */

import type { VariableInfo } from '@c4po/erddap';
import { DERIVED } from './seawater.ts';

interface Display {
  label: string;
  colormap: string;
  /** Sort key: lower comes first in the chip row. */
  rank: number;
}

/** Matched on the column name first, then on `standard_name`. */
const BY_NAME: Record<string, Display> = {
  temperature: { label: 'Temperature', colormap: 'cmo.thermal', rank: 10 },
  salinity: { label: 'Practical salinity', colormap: 'cmo.haline', rank: 20 },
  conductivity: { label: 'Conductivity', colormap: 'cmo.haline', rank: 60 },
  density: { label: 'Density (from the DAC)', colormap: 'cmo.dense', rank: 61 },
  pressure: { label: 'Pressure', colormap: 'cmo.deep', rank: 970 },
  depth: { label: 'Depth', colormap: 'cmo.deep', rank: 960 },
  time: { label: 'Time', colormap: 'cmo.thermal', rank: 951 },
  latitude: { label: 'Latitude', colormap: 'cmo.balance', rank: 980 },
  longitude: { label: 'Longitude', colormap: 'cmo.balance', rank: 981 },
  potential_temperature: { label: 'Potential temperature (DAC)', colormap: 'cmo.thermal', rank: 62 },
  sound_speed: { label: 'Sound speed (from the DAC)', colormap: 'cmo.speed', rank: 63 },
  chlorophyll_a: { label: 'Chlorophyll a', colormap: 'cmo.algae', rank: 30 },
  cdom: { label: 'CDOM', colormap: 'cmo.matter', rank: 32 },
  beta_700nm: { label: 'Backscatter, 700 nm', colormap: 'cmo.turbid', rank: 33 },
  bsipar_par: { label: 'PAR', colormap: 'plasma', rank: 34 },
  oxygen_concentration: { label: 'Dissolved oxygen', colormap: 'cmo.deep', rank: 25 },
  oxygen_saturation: { label: 'Oxygen saturation', colormap: 'cmo.deep', rank: 26 },
  u: { label: 'Eastward current (depth-averaged)', colormap: 'cmo.balance', rank: 80 },
  v: { label: 'Northward current (depth-averaged)', colormap: 'cmo.balance', rank: 81 },
};

const BY_STANDARD: Record<string, Display> = {
  sea_water_temperature: { label: 'Temperature', colormap: 'cmo.thermal', rank: 10 },
  sea_water_practical_salinity: { label: 'Practical salinity', colormap: 'cmo.haline', rank: 20 },
  sea_water_electrical_conductivity: { label: 'Conductivity', colormap: 'cmo.haline', rank: 60 },
  sea_water_density: { label: 'Density (from the DAC)', colormap: 'cmo.dense', rank: 61 },
  sea_water_pressure: { label: 'Pressure', colormap: 'cmo.deep', rank: 70 },
  moles_of_oxygen_per_unit_mass_in_sea_water: { label: 'Dissolved oxygen', colormap: 'cmo.deep', rank: 25 },
  mass_concentration_of_oxygen_in_sea_water: { label: 'Dissolved oxygen', colormap: 'cmo.deep', rank: 25 },
  mass_concentration_of_chlorophyll_a_in_sea_water: { label: 'Chlorophyll a', colormap: 'cmo.algae', rank: 30 },
};

/** Words in a name that suggest a field, for the many sensor-specific
    columns nobody can enumerate (`sci_flbbcd_chlor_units`, and so on). */
const HINTS: Array<[RegExp, string]> = [
  [/chlor|chl_?a|fluor/i, 'cmo.algae'],
  [/cdom|fdom/i, 'cmo.matter'],
  [/oxygen|_do_|dissolved_ox/i, 'cmo.deep'],
  [/backscatter|bb\d|beta|turbid|scatter/i, 'cmo.turbid'],
  [/\bpar\b|irradiance|solar/i, 'plasma'],
  [/temp/i, 'cmo.thermal'],
  [/salin/i, 'cmo.haline'],
  [/dens|sigma/i, 'cmo.dense'],
  [/depth|pressure|_bar\b/i, 'cmo.deep'],
  [/speed|velocity|current/i, 'cmo.speed'],
];

export interface Plottable {
  name: string;
  label: string;
  units: string;
  colormap: string;
  rank: number;
  /** True for a TEOS-10 quantity computed in the browser. */
  derived: boolean;
  /** For derived variables, the sentence explaining what it is. */
  note?: string;
  /**
   * Whether this belongs in the chip row, as a variable to draw a section
   * of. Time, depth, pressure and position are `false`: they are the *axes*
   * a section is drawn against, and a section of depth against depth is not
   * a figure. They are still offered in the axis menus, which is the whole
   * reason they are in this list — the first version excluded them entirely
   * and the T–S diagram silently lost its depth colour axis, falling back to
   * whatever happened to be first.
   */
  section: boolean;
}

/** Title-case a column name as a last resort: `sci_water_temp` → "Sci water
    temp". Better than showing the raw identifier, honest about being a
    fallback because it keeps the words the file used. */
function humanise(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function colormapFor(name: string, standard?: string): string {
  const hit = BY_NAME[name] ?? (standard ? BY_STANDARD[standard] : undefined);
  if (hit) return hit.colormap;
  for (const [pattern, map] of HINTS) {
    if (pattern.test(name) || (standard && pattern.test(standard))) return map;
  }
  return 'viridis';
}

/**
 * Everything the reader can put on an axis, derived quantities included.
 *
 * Sorted so the fields a section is normally read in come first, the
 * derived TEOS-10 set next, then the rest of the science, then the
 * flight-computer channels — which are kept rather than filtered, because a
 * pilot reading a mission wants them and nobody else has to click them.
 */
/** The axes a section is drawn against: offered in the menus, kept out of
    the chip row. Named rather than inferred, because `ioos_category` groups
    them with the identifiers this list must not readmit. */
const AXES = new Set([
  'time', 'precise_time', 'depth', 'pressure',
  'latitude', 'longitude', 'precise_lat', 'precise_lon',
]);

export function plottable(variables: readonly VariableInfo[]): Plottable[] {
  const out: Plottable[] = [];

  for (const v of variables) {
    const axis = AXES.has(v.name);
    if (v.ancillary && !axis) continue;
    const hit = BY_NAME[v.name] ?? (v.standardName ? BY_STANDARD[v.standardName] : undefined);
    const engineering = /^(commanded_|measured_|[cmfxsu]_)/.test(v.name);
    out.push({
      name: v.name,
      label: hit?.label ?? (v.longName && v.longName !== v.name ? v.longName : humanise(v.name)),
      units: normaliseUnits(v.units),
      colormap: colormapFor(v.name, v.standardName),
      rank: hit?.rank ?? (axis ? 950 : engineering ? 900 : 500),
      derived: false,
      section: !axis,
    });
  }

  for (const d of DERIVED) {
    out.push({
      name: d.name,
      label: d.label,
      units: d.units,
      colormap: d.colormap,
      rank: DERIVED_RANK[d.name] ?? 50,
      derived: true,
      note: d.note,
      section: true,
    });
  }

  return out.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
}

/** Interleaved with the native fields rather than grouped after them: a
    reader looking for temperature should find Conservative Temperature
    beside it, not in a separate list further down. */
const DERIVED_RANK: Record<string, number> = {
  ct: 11,
  pt: 12,
  sa: 21,
  sigma0: 40,
  rho: 41,
  spice0: 42,
  soundSpeed: 43,
};

/** CF units are written for machines. These are the same units, written the
    way they are printed on an axis. */
function normaliseUnits(units: string | undefined): string {
  if (!units || units === '1' || units === '-') return '';
  /* A CF time unit is an epoch definition — "seconds since
     1970-01-01T00:00:00Z" — which is true, machine-readable, and absurd
     under an axis whose ticks already read as dates. The axis is time; the
     epoch is not what it is measured in as far as a reader is concerned. */
  if (/\bsince\b/.test(units)) return '';
  if (units === 'UTC') return '';
  const table: Record<string, string> = {
    'degrees_C': '°C',
    'degree_C': '°C',
    'Celsius': '°C',
    'S m-1': 'S/m',
    'kg m-3': 'kg/m³',
    'm s-1': 'm/s',
    'ug L-1': 'µg/L',
    'umol L-1': 'µmol/L',
    'umol kg-1': 'µmol/kg',
    'm-1 sr-1': 'm⁻¹ sr⁻¹',
    'degrees_north': '°N',
    'degrees_east': '°E',
  };
  return table[units] ?? units;
}

/** The label and its units, as one string for an axis. */
export function axisLabel(v: Plottable): string {
  return v.units ? `${v.label} (${v.units})` : v.label;
}
