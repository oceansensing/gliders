#!/usr/bin/env node
/**
 * The derived seawater properties, on both paths into this site.
 *
 *   npm run test:derive
 *
 * `test:teos10` already proves the thermodynamics against GSW. What is
 * checked here is everything *around* it — the part this site wrote, and the
 * part where a wrong answer looks entirely plausible:
 *
 *  - Absolute Salinity uses the atlas and the sample's own position, and
 *    says so when it cannot.
 *  - The DAC path applies no unit conversion, because the DAC's units are
 *    already TEOS-10's; the Slocum path applies ×10 twice, because its are
 *    not. Both are silent when wrong.
 *  - NMEA `DDDMM.MMMM` becomes decimal degrees.
 *  - The isopycnal grid is σ₀ of the point on the axes, not of some other
 *    parcel.
 */

import fs from 'node:fs';
import zlib from 'node:zlib';
import { check, done, near, ok, section } from './lib/check.mjs';
import { decodeAtlas } from '../packages/teos10/atlas.ts';
import { contour, levels } from '../packages/teos10/contour.ts';
import { derive, sigmaField, DERIVED } from '../src/lib/seawater.ts';
import { decodeFiles, toSource } from '../src/lib/local.ts';
import { plottable } from '../src/lib/variables.ts';
import { binIsTheLimit, medianVerticalStep, spokenMetres } from '../src/lib/sampling.ts';
import { parseInfo } from '../packages/erddap/catalog.ts';

const atlas = decodeAtlas(
  zlib.gunzipSync(fs.readFileSync('public/teos10/saar.bin.gz')).buffer,
);

section('the derived set');

{
  ok('every entry has a label, units and a map',
    DERIVED.every((d) => d.label && d.colormap && d.note), `${DERIVED.length} properties`);
  const names = DERIVED.map((d) => d.name);
  ok('the ones the site promises are all there',
    ['sa', 'ct', 'rho', 'sigma0', 'spice0', 'soundSpeed', 'pt'].every((n) => names.includes(n)),
    names.join(', '));
  check('no duplicates', new Set(names).size, names.length);
}

section('Atlantic shelf water');

{
  /* One sample of Mid-Atlantic Bight shelf water, at a real position. The
     expected values are what TEOS-10 gives; what is being checked is that
     this module feeds it the right things in the right units. */
  const sp = Float64Array.from([32.0]);
  const t = Float64Array.from([12.0]);
  const p = Float64Array.from([50.0]);
  const lon = Float64Array.from([-73.8]);
  const lat = Float64Array.from([39.1]);

  const r = derive({ sp, t, p, lon, lat },
    ['sa', 'ct', 'pt', 'rho', 'sigma0', 'spice0', 'soundSpeed'], atlas);

  ok('the atlas was used', !r.referenceOnly);
  const sa = r.columns.get('sa')[0];
  /* SA exceeds SP by about 0.13–0.16 g/kg on this shelf. The sign is the
     whole point of TEOS-10 and a mistake here would be invisible. */
  ok('SA is greater than SP', sa > sp[0], `SA ${sa.toFixed(4)} vs SP ${sp[0]}`);
  near('and by the amount the Atlantic anomaly gives', sa - sp[0], 0.15, 0.05);

  near('CT is close to t at 50 dbar', r.columns.get('ct')[0], 12.0, 0.05);
  near('θ is a little below t', r.columns.get('pt')[0], 11.99, 0.05);
  ok('θ ≤ t at depth', r.columns.get('pt')[0] <= t[0],
    `θ ${r.columns.get('pt')[0].toFixed(4)} vs t ${t[0]}`);

  near('in-situ density', r.columns.get('rho')[0], 1024.4, 1.0);
  near('σ₀', r.columns.get('sigma0')[0], 24.2, 0.5);
  /* σ₀ is ρ(0 dbar) − 1000, so it must be below the in-situ density by
     roughly the pressure effect — never above it. */
  ok('σ₀ is below in-situ density less 1000',
    r.columns.get('sigma0')[0] < r.columns.get('rho')[0] - 1000,
    `${r.columns.get('sigma0')[0].toFixed(3)} vs ${(r.columns.get('rho')[0] - 1000).toFixed(3)}`);
  near('sound speed', r.columns.get('soundSpeed')[0], 1500, 20);
  ok('spice is finite', Number.isFinite(r.columns.get('spice0')[0]),
    String(r.columns.get('spice0')[0]));
}

section('no position means Reference Salinity, and it says so');

{
  const one = { sp: Float64Array.from([35]), t: Float64Array.from([10]), p: Float64Array.from([0]) };
  const withPos = derive({ ...one, lon: Float64Array.from([-30]), lat: Float64Array.from([40]) },
    ['sa'], atlas);
  const without = derive(one, ['sa'], atlas);

  ok('without a position it is flagged', without.referenceOnly);
  ok('with one it is not', !withPos.referenceOnly);
  /* The two are genuinely different numbers — which is exactly why
     reporting SR under SA's name would be a silent error rather than a
     rounding one. */
  ok('and the values differ',
    Math.abs(without.columns.get('sa')[0] - withPos.columns.get('sa')[0]) > 1e-4,
    `SR ${without.columns.get('sa')[0].toFixed(5)} vs SA ${withPos.columns.get('sa')[0].toFixed(5)}`);

  const noAtlas = derive({ ...one, lon: Float64Array.from([-30]), lat: Float64Array.from([40]) },
    ['sa'], null);
  ok('a missing atlas is flagged the same way', noAtlas.referenceOnly);
}

section('missing inputs stay missing');

{
  const r = derive({
    sp: Float64Array.from([35, NaN, 35]),
    t: Float64Array.from([10, 10, NaN]),
    p: Float64Array.from([0, 0, 0]),
  }, ['sa', 'ct', 'sigma0'], atlas);
  const sa = r.columns.get('sa');
  ok('a good row is computed', Number.isFinite(sa[0]));
  /* Not zero, not carried forward from the row above: a gap has to stay a
     gap or the plot draws a line through a number nobody measured. */
  check('a row with no salinity is NaN', sa[1], NaN);
  check('a row with no temperature is NaN', r.columns.get('ct')[2], NaN);
  check('and the count reflects it', r.counts.get('sa'), 1);
}

section('isopycnals');

{
  const field = sigmaField(31, 36.5, 5, 28, 40);
  ok('the grid is filled', field.v.length === 40 && field.v[0].length === 40);
  ok('σ₀ rises with salinity', field.v[0][39] > field.v[0][0],
    `${field.v[0][0].toFixed(2)} → ${field.v[0][39].toFixed(2)}`);
  ok('and falls with temperature', field.v[39][0] < field.v[0][0],
    `${field.v[0][0].toFixed(2)} → ${field.v[39][0].toFixed(2)}`);
  /* The grid is σ₀ of the point on the axes — SA and CT — which means
     converting Θ back to the in-situ temperature at the reference pressure.
     Getting that wrong shifts every contour by a few hundredths and looks
     entirely plausible. Spot-checked against the same path `derive` takes. */
  const point = derive({
    sp: Float64Array.from([35]), t: Float64Array.from([10]), p: Float64Array.from([0]),
    lon: Float64Array.from([-30]), lat: Float64Array.from([40]),
  }, ['sa', 'ct', 'sigma0'], atlas);
  const sa = point.columns.get('sa')[0];
  const ct = point.columns.get('ct')[0];
  const grid = sigmaField(sa - 0.001, sa + 0.001, ct - 0.001, ct + 0.001, 2);
  near('the grid agrees with a directly computed σ₀',
    grid.v[0][0], point.columns.get('sigma0')[0], 0.01);

  const ls = levels(23, 27, 10);
  ok('levels are round numbers', ls.every((l) => Math.abs(l * 2 - Math.round(l * 2)) < 1e-9),
    ls.join(', '));
  ok('contours are traced', contour(field, 25).length > 5,
    `${contour(field, 25).length} segments at σ₀ 25`);
}

section('no two variables share a name on screen');

{
  /* `bsipar_temp` is the PAR sensor's own housekeeping temperature, and the
     DAC publishes it with `long_name` "Temperature" — the seawater
     measurement's name. Unresolved, the chip row offered two chips reading
     "Temperature" and the map's colour menu two identical entries, with
     nothing to say that one of them was the inside of an instrument. */
  const info = parseInfo('electa-20260807T1633',
    JSON.parse(fs.readFileSync('scripts/fixtures/erddap/info-electa.json', 'utf8')));
  const vars = plottable(info.variables);

  const labels = vars.map((v) => v.label);
  const dupes = labels.filter((l, i) => labels.indexOf(l) !== i);
  ok('every label is unique', dupes.length === 0, dupes.join(', ') || 'no collisions');

  /* The seawater measurement keeps the plain name; the instrument's own
     falls back to the column name, which is the unique thing about it. */
  check('the CTD keeps "Temperature"',
    vars.find((v) => v.name === 'temperature')?.label, 'Temperature');
  check('and the sensor housekeeping channel does not',
    vars.find((v) => v.name === 'bsipar_temp')?.label, 'Bsipar temp');

  const shorts = vars.filter((v) => v.short.length > 13);
  ok('no short form can overflow the readout slot', shorts.length === 0,
    shorts.map((v) => v.short).join(', ') || 'all within 12 characters');
}

section('physical floors on the colour scale');

{
  /* A percentile alone cannot fix a negative concentration: an optical
     sensor's dark counts put real readings below zero, so the 2nd percentile
     of a chlorophyll record is still about −0.03 µg/L. The floor clamps the
     automatic colour limit without touching a single sample. */
  const info = parseInfo('electa-20260807T1633',
    JSON.parse(fs.readFileSync('scripts/fixtures/erddap/info-electa.json', 'utf8')));
  const vars = plottable(info.variables);
  const floor = (name) => vars.find((v) => v.name === name)?.floor;

  for (const name of ['chlorophyll_a', 'cdom', 'beta_700nm', 'salinity', 'density',
    'conductivity', 'pressure', 'depth', 'sa', 'rho', 'soundSpeed']) {
    check(`${name} cannot go below zero`, floor(name), 0);
  }

  /* Absent where the quantity really is signed — a floor there would be a
     lie about the ocean, not a defence against a sensor. */
  for (const name of ['temperature', 'ct', 'pt', 'spice0', 'u', 'v']) {
    check(`${name} has no floor`, floor(name), undefined);
  }
}

section('raw Slocum files, end to end');

{
  /* The real fixture pair — one flight file, one science file, and the two
     sensor lists they were written against. */
  const dir = 'scripts/fixtures/slocum';
  const names = ['electa-2025-120-1-169.sbd', 'electa-2025-120-1-169.tbd',
    '0f682cb2.cac', '92610b65.cac'];
  const files = names.map((name) => {
    const buf = fs.readFileSync(`${dir}/${name}`);
    return {
      name,
      async text() { return buf.toString('latin1'); },
      async arrayBuffer() {
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      },
    };
  });

  const report = await decodeFiles(files, new Map());
  check('one deployment', report.deployments.length, 1);
  check('nothing failed', report.failed.length, 0);
  check('no cache went missing', report.missingCaches.size, 0);

  const { source, table, notes } = toSource(report.deployments[0], atlas);
  ok('rows were built', table.rows > 500, `${table.rows} rows`);

  /* NMEA `DDDMM.MMMM` is a perfectly ordinary number, so a raw value reads
     as a latitude that does not exist — 3812.0 rather than 38.2. This is
     the conversion, checked by the answer landing on the shelf the glider
     was actually on. */
  const lat = source.columns.get('latitude');
  const lon = source.columns.get('longitude');
  const finite = (a) => [...a].filter(Number.isFinite);
  const lats = finite(lat);
  const lons = finite(lon);
  ok('latitude is in decimal degrees',
    Math.min(...lats) > 37 && Math.max(...lats) < 40,
    `${Math.min(...lats).toFixed(4)}…${Math.max(...lats).toFixed(4)}`);
  ok('longitude likewise',
    Math.min(...lons) > -75 && Math.max(...lons) < -73,
    `${Math.min(...lons).toFixed(4)}…${Math.max(...lons).toFixed(4)}`);

  /* Depth is computed from the *science* pressure, in bar, through TEOS-10.
     `m_depth` is the tempting substitute and is wrong: on this segment it
     covers 3–4 m across a profile whose temperature moves 9 °C. */
  const depth = finite(source.columns.get('depth'));
  ok('depth spans a real profile',
    Math.max(...depth) > 100, `to ${Math.max(...depth).toFixed(1)} m`);
  ok('and starts at the surface', Math.min(...depth) < 2,
    `from ${Math.min(...depth).toFixed(2)} m`);

  const sp = finite(source.columns.get('salinity_practical'));
  ok('practical salinity is shelf water',
    Math.min(...sp) > 30 && Math.max(...sp) < 36,
    `${Math.min(...sp).toFixed(2)}…${Math.max(...sp).toFixed(2)}`);

  const saCol = source.columns.get('salinity_absolute') ?? source.columns.get('salinity_reference');
  const sa = finite(saCol);
  ok('and Absolute Salinity exceeds it', Math.min(...sa) > Math.min(...sp),
    `SA from ${Math.min(...sa).toFixed(3)}, SP from ${Math.min(...sp).toFixed(3)}`);

  const c = finite(source.columns.get('sound_speed'));
  ok('sound speed is in range',
    Math.min(...c) > 1400 && Math.max(...c) < 1600,
    `${Math.min(...c).toFixed(1)}…${Math.max(...c).toFixed(1)} m/s`);

  ok('spiciness was computed', finite(source.columns.get('spice0')).length > 100);

  /* The decoder's notes are the reader's only warning about interpolation
     and about the dual-computer columns, so they must survive the adapter. */
  ok('the decoder’s notes came through', notes.length >= 3, `${notes.length} notes`);
  ok('including the one about the computed depth',
    notes.some((n) => /Depth is computed/.test(n)), notes.join(' | ').slice(0, 120));

  const sections = source.variables.filter((v) => v.section);
  ok('there are sections to draw', sections.length > 20, `${sections.length} plottable`);
  ok('and depth is an axis, not a section',
    source.variables.find((v) => v.name === 'depth')?.section === false);
}


section('how finely the glider itself sampled');

{
  /**
   * The second limit on a section's vertical resolution, and the one the page
   * never used to report. `cp_1155-20260429T1457` samples every 9.8 m, so its
   * 1 m bin, a 5 m bin and every sample it took are within 3% of each other —
   * a reader who narrows the window sees no improvement and, until this,
   * no reason for it.
   */
  const dive = (step, n, from = 0) =>
    Float64Array.from({ length: n }, (_, i) => from + i * step);

  const ten = medianVerticalStep(dive(10, 200), 200);
  near('a glider sampling every 10 m reads as 10 m', ten, 10, 1e-9);
  near('and one sampling every 0.5 m as 0.5', medianVerticalStep(dive(0.5, 200), 200), 0.5, 1e-9);

  /**
   * The median rather than the mean, because the turn at the bottom of every
   * profile contributes one large step per dive. Thirty dives of 30 samples
   * at 10 m, each followed by a 300 m jump back to the surface: the mean is
   * dragged to 19.7 m, a spacing the glider never sampled at.
   */
  const sawtooth = [];
  for (let d = 0; d < 30; d++) for (let i = 0; i < 30; i++) sawtooth.push(i * 10);
  const arr = Float64Array.from(sawtooth);
  const steps = [];
  for (let i = 1; i < arr.length; i++) if (Math.abs(arr[i] - arr[i - 1]) > 0) steps.push(Math.abs(arr[i] - arr[i - 1]));
  const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
  near('the median steps over the profile turns', medianVerticalStep(arr, arr.length), 10, 1e-9);
  ok('where the mean does not', mean > 15, `the mean of the same steps is ${mean.toFixed(1)} m`);

  /* Gaps in the depth column are skipped, not counted as a zero step. */
  const holed = Float64Array.from({ length: 300 }, (_, i) => (i % 3 === 1 ? NaN : Math.floor(i / 3) * 6));
  ok('missing depths are skipped rather than read as no movement',
    medianVerticalStep(holed, 300) > 0, `${medianVerticalStep(holed, 300)}`);

  check('too few samples has no typical spacing', medianVerticalStep(dive(10, 10), 10), null);
  check('and no depth column at all has none either', medianVerticalStep(undefined, 100), null);

  /* Which of the two limits is in force, which is what the caption turns on. */
  ok('a 5 m bin over 1 m sampling is the limit', binIsTheLimit(5, 1));
  ok('a 1 m bin over 9.8 m sampling is not', !binIsTheLimit(1, 9.8));
  ok('and neither is 1 m over 1.2 m — nobody would see the difference',
    !binIsTheLimit(1, 1.2));
  ok('full rate is never the limit', !binIsTheLimit(0, 9.8));
  ok('with no measured spacing, the old advice stands', binIsTheLimit(5, null));

  check('spacings are spoken to the precision they deserve', spokenMetres(9.83), '9.8');
  check('a coarse one loses its decimal', spokenMetres(12.4), '12');
  check('and a fine one keeps two', spokenMetres(0.42), '0.42');
}

done();
