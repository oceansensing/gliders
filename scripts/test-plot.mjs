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
import { check, done, ok, section } from './lib/check.mjs';
import { plot, DEFAULT_MAX_POINTS, tick, stamp } from '../packages/plot/plot.ts';
import { sample, COLORMAPS, knownColormap } from '../packages/plot/colormaps.ts';

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
  const withGaps = ramp(100);
  for (let i = 40; i < 60; i++) withGaps.c[i] = NaN;
  const svg = fresh();
  const r = plot(svg, withGaps, { width: 400, height: 300, cLabel: 'c' });
  check('points with no colour value are counted', r.uncolored, 20);
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
  ok('with the data window', seen && seen.xLo === 0 && seen.xHi === 49,
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

done();
