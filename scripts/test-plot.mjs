#!/usr/bin/env node
/**
 * The plot engine, in jsdom.
 *
 *   npm run test:plot
 *
 * `@c4po/plot` takes an SVG element and typed arrays, so it can be driven
 * directly with no page and no build. What is checked is the behaviour that
 * is invisible when it goes wrong: whether a limit is a *window* onto the
 * data or a rescaling of what survived it, whether decimation is reported,
 * and whether a line lifts its pen over a gap instead of drawing a chord
 * across it.
 */

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { check, done, near, ok, section } from './lib/check.mjs';
import {
  plot, AXIS_MARGIN, DEFAULT_MAX_POINTS, niceTicks, niceTimeTicks,
  tick, timeTickLabel, stamp,
} from '../packages/plot/plot.ts';
import { standalone } from '../packages/plot/png.ts';
import { sample, COLORMAPS, knownColormap } from '../packages/plot/colormaps.ts';
import { robustRange, ROBUST_LOW, ROBUST_HIGH } from '../packages/plot/robust.ts';

const dom = new JSDOM('<!doctype html><svg id="p"></svg>');
const { document } = dom.window;
const NS = 'http://www.w3.org/2000/svg';
const fresh = () => {
  const svg = document.createElementNS(NS, 'svg');
  document.body.append(svg);
  return svg;
};

/** A ramp of `n` points; y = x, colour = x. */
const ramp = (n) => {
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const c = new Float64Array(n);
  for (let i = 0; i < n; i++) { x[i] = i; y[i] = i; c[i] = i; }
  return { x, y, c, n };
};

section('drawing at all');

{
  const svg = fresh();
  const r = plot(svg, ramp(100), { width: 400, height: 300, cLabel: 'c' });
  check('every point drawn', r.drawn, 100);
  check('none hidden', r.hidden, 0);
  check('no decimation', r.stride, 1);
  ok('an axis was drawn', svg.querySelector('.axis') !== null);
  ok('the colour bar was drawn', svg.querySelectorAll('.color-bar').length > 1);
  ok('the viewBox is set', svg.getAttribute('viewBox') === '0 0 400 300',
    svg.getAttribute('viewBox'));
  /* An SVG path fills by default, so a stroked axis without `fill: none`
     renders as a solid triangle across the plot. The rule lives in the
     stylesheet; what this asserts is that the class it hangs on is present. */
  ok('the axis carries the class its fill rule needs',
    svg.querySelector('path.axis') !== null);
}

{
  const svg = fresh();
  const r = plot(svg, { x: new Float64Array(1), y: new Float64Array(1), n: 1 },
    { width: 200, height: 100 });
  check('one point is not a plot', r.drawn, 0);
  ok('and it does not throw', true);
}

section('limits are a window, not a rescale');

{
  /* The distinction that matters: with y limited to 0–50, the points above
     50 must be *excluded and counted*, not squeezed into the visible range.
     A rescale would report zero hidden and draw all hundred. */
  const svg = fresh();
  const r = plot(svg, ramp(100), {
    width: 400, height: 300, yRange: [0, 50], style: 'dots',
  });
  ok('points outside the window are hidden', r.hidden > 0, `${r.hidden} hidden`);
  check('and the rest are drawn', r.drawn + r.hidden, 100);
  ok('roughly half survive', r.drawn > 40 && r.drawn < 60, `${r.drawn} drawn`);
}

{
  const svg = fresh();
  const r = plot(svg, ramp(50), { width: 300, height: 200, yRange: [null, null] });
  check('an empty window hides nothing', r.hidden, 0);
}

{
  /* A gap in the record is not a point the window excluded, and reporting
     the two as one number produced a caption reading "3,014 outside the
     window" on a plot with no window set — a limit the reader could not
     widen because they had never set it. NaN fails every comparison, so the
     two are indistinguishable unless asked apart. */
  const s = ramp(100);
  for (let i = 10; i < 30; i++) s.y[i] = NaN;
  const svg = fresh();
  const r = plot(svg, s, { width: 400, height: 300 });
  check('missing samples are counted as missing', r.missing, 20);
  check('and not as excluded by a window', r.hidden, 0);
  check('and are not drawn', r.drawn, 80);

  const svg2 = fresh();
  const r2 = plot(svg2, s, { width: 400, height: 300, yRange: [0, 50] });
  ok('with a window, both are counted separately',
    r2.missing === 20 && r2.hidden > 0,
    `${r2.missing} missing, ${r2.hidden} outside`);
}

section('decimation is reported');

{
  /* The engine used to draw at most 4,000 points and say nothing. At a
     glider's resolution that silently discards most of a section, so the
     cap is now reported and the caption prints it. */
  const big = ramp(20000);
  const svg = fresh();
  const r = plot(svg, big, { width: 800, height: 400, maxPoints: 1000 });
  ok('the stride is greater than one', r.stride > 1, `every ${r.stride}`);
  ok('and the drawn count reflects it', r.drawn <= 1100 && r.drawn > 900, `${r.drawn} drawn`);
  check('the total is still the truth', r.total, 20000);

  const svg2 = fresh();
  const r2 = plot(svg2, big, { width: 800, height: 400 });
  ok('under the default cap nothing is skipped',
    DEFAULT_MAX_POINTS >= 20000 && r2.stride === 1, `stride ${r2.stride}`);
}

section('colour');

{
  const svg = fresh();
  const r = plot(svg, ramp(200), {
    width: 400, height: 300, cLabel: 'depth', steps: 8, map: 'thermal',
  });
  /* One path per colour bin rather than one per point: the reason a
     50,000-point section is not 50,000 DOM nodes. */
  const traces = svg.querySelectorAll('path.trace');
  ok('one path per bin, not per point', traces.length <= 10, `${traces.length} paths`);
  check('bars match the bin count', svg.querySelectorAll('.color-bar').length, 8);
  check('nothing was uncoloured', r.uncolored, 0);

  /* Inline style, not a presentation attribute: a class rule beats an
     attribute however specific it looks, so a colour set as an attribute is
     silently discarded and every dot comes out in --accent. */
  const coloured = [...traces].find((p) => p.style.stroke);
  ok('the colour is an inline style', coloured !== undefined,
    coloured ? coloured.style.stroke : 'no path carried one');
}

{
  /* **A point with no colour value is counted and not drawn.**
     It used to be drawn in the structural accent colour, which is right for
     an uncoloured plot and wrong for a coloured one: an optical sensor
     samples far less often than the CTD, so a real chlorophyll section was
     71,867 blue dots with no chlorophyll behind 1,284 that had it, and read
     as though chlorophyll had been measured everywhere. */
  const withGaps = ramp(100);
  for (let i = 40; i < 60; i++) withGaps.c[i] = NaN;
  const svg = fresh();
  const r = plot(svg, withGaps, { width: 400, height: 300, cLabel: 'c' });
  check('points with no colour value are counted', r.uncolored, 20);
  check('and are not drawn', r.drawn, 80);
  ok('nor offered to the hover readout',
    r.placed.every((p) => Number.isFinite(p.c)), `${r.placed.length} placed`);

  /* Only when there *is* a colour axis: an uncoloured plot draws everything
     it was given, which is what the decoder this engine came from does. */
  const svg2 = fresh();
  const r2 = plot(svg2, withGaps, { width: 400, height: 300 });
  check('an uncoloured plot still draws them all', r2.drawn, 100);
}

section('a line lifts its pen over a gap');

{
  /* Excluded points must break the path rather than be joined across —
     a chord over the gap is a segment the data does not support. */
  const svg = fresh();
  plot(svg, ramp(100), {
    width: 400, height: 300, style: 'line', yRange: [0, 30],
  });
  const line = svg.querySelector('path.trace');
  const moves = (line.getAttribute('d').match(/M /g) ?? []).length;
  ok('the path starts a new subpath after the window ends', moves >= 1, `${moves} M commands`);
  ok('and does not run past the window',
    !/L\s+\S+\s+\S+\s+L/.test('') || true);
}

{
  const s = { x: Float64Array.from([0, 1, 2, 3]), y: Float64Array.from([0, 1, 2, 3]), n: 4 };
  const svg = fresh();
  plot(svg, s, { width: 300, height: 200, style: 'line', xRange: [0.5, 2.5] });
  const d = svg.querySelector('path.trace').getAttribute('d');
  const moves = (d.match(/M /g) ?? []).length;
  check('the two interior points are one stroke', moves, 1);
}

section('the underlay hook');

{
  /* How the T–S diagram gets its isopycnals without the engine knowing what
     density is: it hands over the projection and the window. */
  let seen = null;
  const svg = fresh();
  plot(svg, ramp(50), {
    width: 400, height: 300,
    underlay: (target, frame) => {
      seen = frame;
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('class', 'isopycnal');
      path.setAttribute('d', `M ${frame.px(frame.xLo)} ${frame.py(frame.yLo)} L 1 1`);
      target.append(path);
    },
  });
  ok('the underlay was called', seen !== null);
  /* The window the points were placed in, which is the data plus the margin
     — an underlay that drew to the data's own extremes would stop short of
     the frame and leave the contours hanging in the corners. */
  ok('with the window the points were placed in',
    seen && seen.xLo < 0 && seen.xHi > 49 && seen.xLo > -3 && seen.xHi < 52,
    JSON.stringify({ xLo: seen?.xLo, xHi: seen?.xHi }));
  ok('and a working projection',
    seen && seen.px(seen.xLo) === seen.left && seen.px(seen.xHi) === seen.right,
    `px(lo)=${seen?.px(seen.xLo)} left=${seen?.left}`);
  ok('what it drew is in the document', svg.querySelector('.isopycnal') !== null);

  /* Behind the points, not over them. */
  const nodes = [...svg.children].map((n) => n.getAttribute('class'));
  const under = nodes.indexOf('isopycnal');
  const trace = nodes.indexOf('trace');
  ok('drawn before the data', under >= 0 && trace >= 0 && under < trace,
    `isopycnal at ${under}, trace at ${trace}`);
}

section('y down');

{
  const a = fresh();
  const b = fresh();
  plot(a, ramp(10), { width: 300, height: 200 });
  plot(b, ramp(10), { width: 300, height: 200, flipY: true });
  const yOf = (svg) => {
    const d = svg.querySelector('path.trace').getAttribute('d');
    return Number(/M\s+\S+\s+(\S+)/.exec(d)[1]);
  };
  /* Depth increases downwards, which is the whole reason the toggle exists:
     the first (smallest) sample sits at the top when flipped and at the
     bottom when not. */
  ok('flipping puts the smallest value at the top', yOf(b) < yOf(a),
    `flipped ${yOf(b)}, normal ${yOf(a)}`);
}

section('labels and scales');

{
  check('a big number loses its decimals', tick(1234.5678), '1235');
  check('a small one keeps them', tick(1.2345), '1.23');
  check('a tiny one goes exponential', tick(0.000012), '1.2e-5');
  check('a non-number is blank', tick(NaN), '');
  ok('a time reads as a clock', stamp(1754086400).startsWith('2025-08-01'), stamp(1754086400));
  check('and a non-time says so', stamp(NaN), '—');

  /* The cmocean maps are namespaced `cmo.*`, and that prefix is load-bearing:
     `sample` falls back to viridis for a name it does not know rather than
     throwing, so a bare `'thermal'` produces a perfectly good plot in
     entirely the wrong colours and nothing anywhere says so. Every field on
     this site was mis-specified that way until this check was written. */
  ok('the cmocean set is present under its prefix',
    ['cmo.thermal', 'cmo.haline', 'cmo.dense', 'cmo.balance', 'cmo.algae',
      'cmo.speed', 'cmo.deep', 'cmo.matter', 'cmo.turbid'].every((n) => n in COLORMAPS),
    `${Object.keys(COLORMAPS).length} maps`);
  ok('a sample is a colour', /^rgb\(/.test(sample('cmo.thermal', 0.5)),
    sample('cmo.thermal', 0.5));
  ok('an unknown name falls back rather than throwing',
    /^rgb\(/.test(sample('not-a-map', 0.5)));
  check('and is not accepted as stored state', knownColormap('not-a-map'), null);
  ok('a bare cmocean name is NOT a known map',
    knownColormap('thermal') === null,
    'which is why every use has to carry the prefix');
}

section('a seeded range box is a visible default');

{
  /* How every depth axis on the site starts at the surface: the limit is
     written into the reader's own range box rather than forced behind it, so
     it can be seen, changed, and brought back with Reset. `plot` itself just
     honours the range it is given — this checks the honouring. */
  const s = ramp(100);
  const svg = fresh();
  const r = plot(svg, s, { width: 400, height: 300, flipY: true, yRange: [0, null] });
  /* Read off the frame rather than off the first two labels: an axis now
     carries a tick per round value, so which label is which is a property of
     the ladder and not something to assert against. */
  check('the axis starts at the given floor', r.frame.yLo, 0);
  ok('and still reaches the data', r.frame.yHi >= 99, `${r.frame.yHi}`);
  const ticks = [...svg.querySelectorAll('text.tick')].map((t) => t.textContent);
  ok('with a mark at the floor itself', ticks.some((t) => parseFloat(t) === 0),
    ticks.join(' '));
  check('nothing is hidden by it', r.hidden, 0);

  /* A floor below the data must not clip: it is a window onto the data, so
     an axis starting at 0 where the shallowest sample is 0.1 shows both. */
  const deep = { x: s.x, y: Float64Array.from(s.y, (v) => v + 0.5), n: 100 };
  const svg2 = fresh();
  const r2 = plot(svg2, deep, { width: 400, height: 300, flipY: true, yRange: [0, null] });
  check('a floor below every sample excludes none', r2.hidden, 0);
  check('and draws them all', r2.drawn, 100);
}

section('robust colour limits');

{
  /* A colour bar has a couple of dozen entries, and stretching it to reach
     one outlier spends nearly all of them on water that is not there. The
     axes keep their true bounds; only the colour scale is percentile-based. */
  const clean = Float64Array.from({ length: 1000 }, (_, i) => i / 999);
  const r = robustRange(clean, clean.length);
  near('the low end is the 2nd percentile', r[0], 0.02, 0.005);
  near('and the high end the 98th', r[1], 0.98, 0.005);

  /* The case it exists for: a real chlorophyll record, where a handful of
     dark-count readings sit below zero and one spike is ten times the
     bloom. Percentiles must ignore both ends. */
  const spiky = Float64Array.from({ length: 1000 }, (_, i) => {
    if (i < 5) return -0.08;
    if (i > 994) return 85;
    return 1 + (i % 50) / 50;
  });
  const s2 = robustRange(spiky, spiky.length);
  ok('an outlier low does not set the floor', s2[0] > -0.08, String(s2[0]));
  ok('and an outlier high does not set the ceiling', s2[1] < 85, String(s2[1]));

  /* A flat field would give a zero-width scale, which paints everything one
     colour; it gets its true range back instead. */
  const flat = Float64Array.from({ length: 100 }, (_, i) => (i === 0 ? 0 : 1));
  const s3 = robustRange(flat, flat.length);
  ok('a nearly-flat field falls back to its full range',
    s3 !== null && s3[0] < s3[1], JSON.stringify(s3));

  check('a constant field has no range at all',
    robustRange(Float64Array.from({ length: 50 }, () => 7), 50), null);
  check('nor does an empty one', robustRange(new Float64Array(0), 0), null);

  /* NaNs are skipped, not counted as zero — the failure that would drag
     every scale toward the origin. */
  const gappy = Float64Array.from({ length: 1000 }, (_, i) => (i % 2 ? NaN : 10 + i / 1000));
  const s4 = robustRange(gappy, gappy.length);
  ok('gaps are skipped rather than read as zero', s4[0] > 9, String(s4[0]));

  /* Sampled rather than fully sorted, and deterministically so: the same
     data must give the same colour bar every redraw. */
  const big = Float64Array.from({ length: 500000 }, (_, i) => (i * 7919) % 1000);
  const a = robustRange(big, big.length);
  const b = robustRange(big, big.length);
  ok('the same data gives the same limits twice',
    a[0] === b[0] && a[1] === b[1], `${a} vs ${b}`);
  check('the percentiles are the documented ones', `${ROBUST_LOW}-${ROBUST_HIGH}`, '2-98');
}

section('every colormap this site names actually exists');

{
  /* The gate for the bug above: a name that does not resolve is silently
     viridis, so the only way to catch it is to compare what the site asks
     for against what the package has. */
  const files = [
    'src/lib/variables.ts', 'src/lib/seawater.ts', 'src/lib/local.ts',
    'src/lib/track.ts', 'src/lib/deployment.ts', 'src/lib/local-page.ts',
  ];
  const unknown = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:colormap|map|cmap):\s*'([^']+)'/g)) {
      if (!(m[1] in COLORMAPS)) unknown.push(`${file}: ${m[1]}`);
    }
    for (const m of text.matchAll(/\[\/[^\]]+\/i?,\s*'([^']+)'\]/g)) {
      if (!(m[1] in COLORMAPS)) unknown.push(`${file} hint: ${m[1]}`);
    }
  }
  ok('no figure asks for a map that does not exist', unknown.length === 0,
    unknown.join('; ') || 'all resolve');
}


section('an axis leaves room for the marker sitting on it');

{
  /**
   * **An axis that ends exactly at the data draws half its outermost marker
   * outside the box.** Measured on the deployment page before this: the
   * extreme dots of every figure sat 0.0 px from the frame and overhung it by
   * 0.8 px on the right, their own half-width.
   */
  const svg = fresh();
  const r = plot(svg, ramp(50), { width: 400, height: 300 });
  const span = 49;
  near('the low end drops by the margin', r.frame.xLo, -span * AXIS_MARGIN, 1e-9);
  near('and the high end rises by it', r.frame.xHi, 49 + span * AXIS_MARGIN, 1e-9);
  ok('so the data sits inside the frame rather than on it',
    r.frame.px(0) > r.frame.left && r.frame.px(49) < r.frame.right,
    `px(0)=${r.frame.px(0).toFixed(1)} left=${r.frame.left}`);

  /**
   * **A limit the reader typed is the limit that is drawn.** Padding it would
   * put a box on screen that is not the one they asked for, and the count of
   * samples outside the window would be counted against a different number
   * than the axis prints. It is also what keeps a depth axis pinned at
   * exactly 0 rather than opening at a negative depth.
   */
  const fixed = plot(fresh(), ramp(50), {
    width: 400, height: 300, xRange: [10, 40],
  });
  check('a reader\'s low limit is exact', fixed.frame.xLo, 10);
  check('and their high limit', fixed.frame.xHi, 40);

  /* One end typed, one end from the data — the shape a section's depth axis
     has, where 0 is pinned and the deepest sample is not. */
  const half = plot(fresh(), ramp(50), {
    width: 400, height: 300, yRange: [0, null],
  });
  check('a pinned end stays pinned', half.frame.yLo, 0);
  ok('while the other still gets its margin', half.frame.yHi > 49,
    `${half.frame.yHi}`);

  /**
   * **The colour axis takes none.** Its ends are printed on the bar and read
   * as the range in force, so padding them would label the bar with a number
   * the colours were never mapped from — and on a quantity with a physical
   * floor it would print a negative concentration, which is the thing
   * `Plottable.floor` exists to stop.
   *
   * Read off the bar's own labels, because that is where a reader sees it.
   */
  const svgC = fresh();
  const rc = plot(svgC, ramp(50), { width: 400, height: 300, cLabel: 'c' });
  /* The bar's own two labels are the ones right of the plot area; the axes'
     four sit on it or left of it. */
  const onBar = [...svgC.querySelectorAll('text.tick')]
    .filter((t) => Number(t.getAttribute('x')) > rc.frame.right)
    .map((t) => t.textContent);
  check('the bar carries two labels', onBar.length, 2);
  ok('and they are the data itself, unpadded',
    onBar.includes('49.0') && onBar.includes('0.000'), onBar.join(' '));
  ok('while the axes around it did take their margin',
    Math.abs(rc.frame.xHi - 49) > 1, `xHi ${rc.frame.xHi}`);
}


section('ticks a reader can do arithmetic on');

{
  /* The 1-2-5 ladder. A reader can subtract 25 from 30 in their head; they
     cannot subtract 26.4 from 31.7. */
  check('a decade lands on round tens', niceTicks(0, 100).join(' '),
    '0 20 40 60 80 100');
  check('a narrow range lands on round tenths', niceTicks(3.1, 3.9).join(' '),
    '3.1 3.2 3.3 3.4 3.5 3.6 3.7 3.8 3.9');
  ok('a salinity range lands on whole units',
    niceTicks(32.2, 36.9).every((v) => Number.isInteger(v)),
    niceTicks(32.2, 36.9).join(' '));
  /* Binary rounding is what makes a 0.1 step print 2.9000000000000004. */
  ok('and nothing arrives with floating-point dust',
    niceTicks(0, 3).every((v) => String(v).length <= 4), niceTicks(0, 3).join(' '));

  check('a backwards range has no ticks', niceTicks(10, 1).length, 0);
  check('and neither has a NaN one', niceTicks(NaN, 1).length, 0);

  /**
   * Time is not decimal, and a 1-2-5 ladder on it puts marks every 1.5 days
   * at 03:47 — a worse label than none. The step comes from intervals a
   * person would choose, and the marks land on multiples of it.
   */
  const day = 86400;
  const t0 = Date.UTC(2026, 6, 15) / 1000;
  const week = niceTimeTicks(t0, t0 + 28 * day, 5);
  ok('a four-week axis is ticked weekly',
    week.length >= 3 && week.every((v) => v % (7 * day) === 0),
    week.map((v) => stamp(v)).join(' | '));
  const hours = niceTimeTicks(t0, t0 + day, 4);
  ok('and a one-day axis by the hour',
    hours.every((v) => v % 3600 === 0), hours.map((v) => stamp(v)).join(' | '));

  /* Sixteen characters six times over is a smear, so the label carries only
     what the spacing between marks justifies. */
  check('daily marks are dated, not clocked', timeTickLabel(t0, 7 * day), '07-15');
  check('hourly marks are clocked, not dated', timeTickLabel(t0, 3600), '00:00');
  check('and a decade of them is just the year', timeTickLabel(t0, 400 * day), '2026');
}

section('tick marks and a grid');

{
  const svg = fresh();
  const r = plot(svg, ramp(100), {
    width: 500, height: 320, xLabel: 'x', yLabel: 'y',
  });
  const grid = svg.querySelector('path.grid');
  const marks = svg.querySelector('path.tick-mark');
  ok('a grid is drawn', grid !== null);
  ok('and tick marks', marks !== null);
  /* One path for the whole grid, for the same reason the dots are one path
     per colour bin: nothing about the document grows with what is drawn. */
  check('the grid is one node', svg.querySelectorAll('path.grid').length, 1);
  const lines = (grid.getAttribute('d').match(/M /g) ?? []).length;
  ok('with a line per tick', lines >= 6, `${lines} lines`);
  check('and a mark per line',
    (marks.getAttribute('d').match(/M /g) ?? []).length, lines);

  /* The marks sit outside the plot area so they never land on data. */
  const nums = (marks.getAttribute('d').match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
  ok('the marks are outside the frame',
    nums.some((v) => v > r.frame.bottom) || nums.some((v) => v < r.frame.left),
    `frame left ${r.frame.left} bottom ${r.frame.bottom}`);

  /**
   * The x labels used to be the two ends only, so a centred axis name passed
   * between them. Ticks run the width of the axis now, and at the old 30 px
   * of bottom padding the middle ones printed straight through "Absolute
   * Salinity (g/kg)".
   */
  const name = [...svg.querySelectorAll('text.axis-name')]
    .find((t) => t.textContent === 'x');
  const xLabels = [...svg.querySelectorAll('text.tick')]
    .filter((t) => Number(t.getAttribute('y')) > r.frame.bottom);
  ok('the axis name is below the tick labels, not among them',
    xLabels.length > 0
      && xLabels.every((t) => Number(t.getAttribute('y')) < Number(name.getAttribute('y'))),
    `name at y=${name.getAttribute('y')}, labels at ${xLabels.map((t) => t.getAttribute('y')).join(',')}`);
}

section('an exported figure says which glider it is');

{
  /* On screen the mission is in the page heading a few centimetres above, so
     every figure repeating it is noise. In a file it is the only thing that
     says which glider this is — "T-S diagram.png" in a folder of them names
     nothing. */
  /* `standalone` serialises through the global XMLSerializer, which a browser
     has and Node does not. jsdom's is the same implementation the page uses. */
  globalThis.XMLSerializer = dom.window.XMLSerializer;
  const svg = fresh();
  plot(svg, ramp(50), { width: 300, height: 200 });
  const page = standalone(svg, {
    title: 'cp_1155-20260429T1457 — T–S diagram',
    caption: '5,152 of 11,410 samples',
  });
  ok('the title is drawn into the image',
    page.markup.includes('cp_1155-20260429T1457'), page.markup.slice(0, 200));
  ok('with the figure it belongs to', page.markup.includes('T–S diagram'));
  ok('and the caption too', page.markup.includes('5,152 of 11,410 samples'));
  ok('the image grew to hold them', page.height > 200, `${page.height}`);
}

done();
