/**
 * Density contours behind a T–S diagram.
 *
 * The T–S diagram is the figure physical oceanography is drawn in, and what
 * makes it readable is the family of curved σ₀ contours behind the points:
 * two samples on the same line weigh the same however different they look,
 * and a water mass is a cluster along one. Without them it is a scatter plot
 * of two correlated numbers.
 *
 * The lines have no closed form — density is a polynomial in the wrong
 * variables — so they are traced with marching squares over a σ₀ field
 * evaluated on a grid, by `@c4po/teos10`'s own `contour`.
 *
 * Handed to the plot engine as an `underlay`, which receives the projection
 * and nothing else. That is what keeps seawater out of `@c4po/plot`: this
 * module knows what density is, the engine knows where things go, and they
 * meet over two functions.
 */

import { contour, levels } from '@c4po/teos10';
import type { Frame } from '@c4po/plot';
import { sigmaField } from './seawater.ts';

const NS = 'http://www.w3.org/2000/svg';

/**
 * An `underlay` that draws labelled σ₀ contours over the current window.
 *
 * Recomputed per draw, and that is affordable: 48×48 evaluations of the
 * Gibbs function is under a millisecond, against a window that changes only
 * when the reader moves it. Caching it would mean holding a grid keyed by
 * four floats and getting the invalidation right, to save a millisecond on
 * an interaction that already redraws thousands of points.
 *
 * Every stroke is a class rather than an attribute, so a theme switch
 * restyles the picture with no redraw — the rule the whole site keeps.
 */
export function isopycnalUnderlay(svg: SVGSVGElement, frame: Frame): void {
  const { xLo, xHi, yLo, yHi } = frame;
  if (!(xHi > xLo) || !(yHi > yLo)) return;

  const doc = svg.ownerDocument ?? document;
  const field = sigmaField(xLo, xHi, yLo, yHi, 48);

  /* The levels come from the σ₀ actually present in the window rather than
     from a fixed ladder: a shelf deployment spans 20–26 and an abyssal one
     27.0–27.9, and one step size cannot serve both. */
  let lo = Infinity;
  let hi = -Infinity;
  for (const row of field.v) {
    for (const v of row) {
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!Number.isFinite(lo) || !(hi > lo)) return;

  for (const level of levels(lo, hi, 10)) {
    const segments = contour(field, level);
    if (segments.length === 0) continue;

    let d = '';
    for (const s of segments) {
      d += `M ${frame.px(s.x1).toFixed(1)} ${frame.py(s.y1).toFixed(1)} `
        + `L ${frame.px(s.x2).toFixed(1)} ${frame.py(s.y2).toFixed(1)} `;
    }
    const path = doc.createElementNS(NS, 'path');
    path.setAttribute('class', 'isopycnal');
    path.setAttribute('d', d);
    svg.append(path);

    /* Labelled where the contour meets the top of the window, which is
       where a reader's eye already is and where the lines are furthest
       apart. A contour that never reaches the top is left unlabelled
       rather than labelled somewhere arbitrary in the middle of the
       cloud. */
    const top = segments.reduce<{ x: number; y: number } | null>((best, s) => {
      for (const p of [{ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }]) {
        if (!best || p.y > best.y) best = p;
      }
      return best;
    }, null);

    if (top && top.y > yHi - (yHi - yLo) * 0.03) {
      const label = doc.createElementNS(NS, 'text');
      label.setAttribute('class', 'isopycnal-label');
      label.setAttribute('x', String(frame.px(top.x) + 3));
      label.setAttribute('y', String(frame.py(top.y) + 10));
      label.textContent = round(level);
      svg.append(label);
    }
  }
}

/** `levels` snaps to its step, but 0.1 + 0.2 still prints as 0.30000000000000004
    if it is not asked to stop. */
function round(v: number): string {
  return String(Math.round(v * 100) / 100);
}
