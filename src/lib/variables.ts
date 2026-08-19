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
  /** Compact form for the pointer readout; the label when omitted. */
  short?: string;
  colormap: string;
  /** Sort key: lower comes first in the chip row. */
  rank: number;
  /** A value this quantity physically cannot go below. See `Plottable`. */
  floor?: number;
}

/** Matched on the column name first, then on `standard_name`. */
const BY_NAME: Record<string, Display> = {
  temperature: { label: 'Temperature', short: 'T', colormap: 'cmo.thermal', rank: 10 },
  salinity: { label: 'Practical salinity', short: 'SP', colormap: 'cmo.haline', rank: 20, floor: 0 },
  conductivity: { label: 'Conductivity', short: 'C', colormap: 'cmo.haline', rank: 60, floor: 0 },
  density: { label: 'Density (from the DAC)', short: 'ρ', colormap: 'cmo.dense', rank: 61, floor: 0 },
  pressure: { label: 'Pressure', short: 'p', colormap: 'cmo.deep', rank: 970, floor: 0 },
  depth: { label: 'Depth', short: 'depth', colormap: 'cmo.deep', rank: 960, floor: 0 },
  time: { label: 'Time', short: 'time', colormap: 'cmo.thermal', rank: 951 },
  latitude: { label: 'Latitude', short: 'lat', colormap: 'cmo.balance', rank: 980 },
  longitude: { label: 'Longitude', short: 'lon', colormap: 'cmo.balance', rank: 981 },
  potential_temperature: { label: 'Potential temperature (DAC)', colormap: 'cmo.thermal', rank: 62 },
  sound_speed: { label: 'Sound speed (from the DAC)', colormap: 'cmo.speed', rank: 63, floor: 0 },
  chlorophyll_a: { label: 'Chlorophyll a', short: 'chl', colormap: 'cmo.algae', rank: 30, floor: 0 },
  cdom: { label: 'CDOM', colormap: 'cmo.matter', rank: 32, floor: 0 },
  beta_700nm: { label: 'Backscatter, 700 nm', colormap: 'cmo.turbid', rank: 33, floor: 0 },
  bsipar_par: { label: 'PAR', colormap: 'plasma', rank: 34, floor: 0 },
  oxygen_concentration: { label: 'Dissolved oxygen', short: 'O₂', colormap: 'cmo.deep', rank: 25, floor: 0 },
  oxygen_saturation: { label: 'Oxygen saturation', colormap: 'cmo.deep', rank: 26, floor: 0 },
  u: { label: 'Eastward current (depth-averaged)', colormap: 'cmo.balance', rank: 80 },
  v: { label: 'Northward current (depth-averaged)', colormap: 'cmo.balance', rank: 81 },
};

const BY_STANDARD: Record<string, Display> = {
  sea_water_temperature: { label: 'Temperature', short: 'T', colormap: 'cmo.thermal', rank: 10 },
  sea_water_practical_salinity: { label: 'Practical salinity', short: 'SP', colormap: 'cmo.haline', rank: 20, floor: 0 },
  sea_water_electrical_conductivity: { label: 'Conductivity', short: 'C', colormap: 'cmo.haline', rank: 60, floor: 0 },
  sea_water_density: { label: 'Density (from the DAC)', short: 'ρ', colormap: 'cmo.dense', rank: 61, floor: 0 },
  sea_water_pressure: { label: 'Pressure', short: 'p', colormap: 'cmo.deep', rank: 70 },
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
  /**
   * A compact form for the pointer readout.
   *
   * The readout sits above the plot, and the plot's own axes already carry
   * the full label — so spelling "Conservative Temperature" there a second
   * time cost 80 characters, which wrapped onto three lines in a half-width
   * column and moved the figure 54 px out from under the pointer. The
   * symbols are what this audience reads anyway.
   */
  short: string;
  units: string;
  colormap: string;
  rank: number;
  /** True for a TEOS-10 quantity computed in the browser. */
  derived: boolean;
  /** For derived variables, the sentence explaining what it is. */
  note?: string;
  /**
   * A value the quantity physically cannot go below, where one exists.
   *
   * Used only to clamp an automatic *colour* limit — never to hide or alter
   * a sample. An optical sensor's dark counts put a few readings below zero,
   * so a chlorophyll colour bar computed from the data alone starts at
   * −0.03 µg/L: a negative concentration, spending part of the ramp on water
   * that cannot exist. The floor stops that without touching the numbers,
   * which stay exactly as the DAC published them and are still drawn.
   *
   * Absent where the quantity really can be negative: temperature reaches
   * −2 °C, spiciness and the current components are signed by construction.
   */
  floor?: number;

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
  /** Names this file names itself, which win a label collision. */
  const known = new Set<string>();

  for (const v of variables) {
    const axis = AXES.has(v.name);
    if (v.ancillary && !axis) continue;
    const hit = BY_NAME[v.name] ?? (v.standardName ? BY_STANDARD[v.standardName] : undefined);
    /* **Only an exact column-name match counts as ours.** A `standard_name`
       match does not, because the DAC's own metadata is not always right:
       `bsipar_temp` — `long_name: sci_bsipar_temp`, the PAR sensor's internal
       temperature — is published with `standard_name: sea_water_temperature`.
       Counting that as canonical made both it and the CTD's `temperature`
       claim the name "Temperature", and the tie-break had nothing to break
       the tie with. */
    if (BY_NAME[v.name]) known.add(v.name);
    const engineering = /^(commanded_|measured_|[cmfxsu]_)/.test(v.name);
    out.push({
      name: v.name,
      label: hit?.label ?? (v.longName && v.longName !== v.name ? v.longName : humanise(v.name)),
      short: hit?.short ?? abbreviate(
        hit?.label ?? (v.longName && v.longName !== v.name ? v.longName : humanise(v.name))),
      units: normaliseUnits(v.units),
      colormap: colormapFor(v.name, v.standardName),
      rank: hit?.rank ?? (axis ? 950 : engineering ? 900 : 500),
      floor: hit?.floor ?? floorFor(v.name, v.standardName),
      derived: false,
      section: !axis,
    });
  }

  for (const d of DERIVED) {
    out.push({
      name: d.name,
      label: d.label,
      short: d.short,
      units: d.units,
      colormap: d.colormap,
      rank: DERIVED_RANK[d.name] ?? 50,
      floor: DERIVED_FLOOR[d.name],
      derived: true,
      note: d.note,
      section: true,
    });
  }

  for (const d of DERIVED) known.add(d.name);
  disambiguate(out, known);
  return out.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
}

/**
 * Two variables must not arrive on screen under one name.
 *
 * `bsipar_temp` is the PAR sensor's own housekeeping temperature and the DAC
 * publishes it with `long_name` "Temperature" — the same name the seawater
 * measurement carries. So the chip row offered two chips reading
 * "Temperature", the colour menu two identical entries, and a reader picking
 * one of them had no way to know which they had picked or that they had
 * chosen the inside of an instrument.
 *
 * Where a label collides, the entry this file names *by column* keeps it and
 * the others fall back to their own column name — the one thing about them
 * that is unique and that the file itself chose. A `standard_name` match is
 * not enough to win, because that is exactly the metadata that was wrong.
 */
function disambiguate(out: Plottable[], known: Set<string>): void {
  const byLabel = new Map<string, Plottable[]>();
  for (const v of out) {
    const group = byLabel.get(v.label) ?? [];
    group.push(v);
    byLabel.set(v.label, group);
  }
  for (const group of byLabel.values()) {
    if (group.length < 2) continue;
    for (const v of group) {
      if (known.has(v.name)) continue;
      v.label = humanise(v.name);
      v.short = v.label.length <= 12 ? v.label : `${v.label.slice(0, 11)}…`;
    }
  }
}

/**
 * Physical floors for the computed properties.
 *
 * Absolute Salinity and the densities cannot be negative; Conservative and
 * potential temperature can, and spiciness is signed by construction, so
 * they are absent rather than floored at a value that would be wrong.
 */
const DERIVED_FLOOR: Record<string, number> = {
  sa: 0,
  rho: 0,
  soundSpeed: 0,
};

/** A floor for the many sensor channels no table can enumerate. Counts,
    concentrations and intensities cannot be negative whatever they are
    called. */
function floorFor(name: string, standard?: string): number | undefined {
  const hay = `${name} ${standard ?? ''}`;
  if (/chlor|cdom|fdom|fluor|backscatter|\bbb\d|beta|turbid|scatter|\bpar\b|irradiance|oxygen|salin|conduct|density|pressure|depth/i.test(hay)) {
    return 0;
  }
  return undefined;
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

/**
 * A last-resort short form, for the hundreds of sensor names no table can
 * enumerate. Kept to 12 characters so the readout cannot grow without bound
 * — the figure's height is reserved for one line and a long name would push
 * the plot down, which is the bug this whole field exists to fix.
 */
function abbreviate(label: string): string {
  return label.length <= 12 ? label : `${label.slice(0, 11)}…`;
}

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
