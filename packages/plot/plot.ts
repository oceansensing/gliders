/**
 * A small scatter/line plot with a color axis.
 *
 * Extracted from `SlocumDecoder.astro` in the oceansensing.github.io
 * repository, where it was 250 lines inside a 3,700-line component and could
 * not be used by anything else. The drawing is that engine's, comments and
 * hard-won details included; three things are new, and each is here because
 * this site asks something of it that the decoder did not.
 *
 * **1. Columns, not rows.** The decoder built a `number[][]` — one small
 * array per point. This site's data arrives as `Float64Array` columns
 * straight out of the ERDDAP parser and the TEOS-10 worker, and a
 * 700,000-row deployment would mean 700,000 array allocations to hand it
 * over in the old shape. `Series` is three typed arrays and a length, which
 * is what both producers already have.
 *
 * **2. An `underlay` hook.** A T–S diagram is unreadable without density
 * contours behind the points, and those contours are traced by TEOS-10 in
 * data coordinates. The hook is handed the projection and draws before the
 * points, so the engine never learns what density is.
 *
 * **3. Honest decimation.** The decoder drew at most 4,000 points, silently.
 * At that limit a glider section loses its structure — 18,000 binned samples
 * is a normal overview here — so the cap is a parameter, higher by default,
 * and the number actually drawn comes back in the result for the caption to
 * report. A picture that has quietly dropped nine tenths of its data and
 * says nothing is the failure this whole file is otherwise careful about.
 *
 * Structural color — the axes, the ticks, the uncolored trace — is a class,
 * so a theme switch restyles the plot with no redraw. The color axis is the
 * one exception and has to be: it encodes a value rather than a role, and a
 * value cannot be named in a stylesheet.
 */

import { DEFAULT_COLORMAP, sample } from './colormaps.ts';

const NS = 'http://www.w3.org/2000/svg';

export const DEFAULT_STEPS = 24;
/**
 * Points drawn before the engine starts skipping.
 *
 * **200,000, and the number is measured rather than felt.** Timed in a
 * browser on a 1240×360 section with a colour axis and 24 steps:
 *
 *   19,000 → 6.8 ms    75,000 → 18 ms    200,000 → 53 ms    400,000 → 148 ms
 *
 * and the DOM node count is **57 at every one of them**, because the dots
 * are one path per colour bin rather than one element per point. That is the
 * whole reason this ceiling can be where it is: nothing about the document
 * grows with the data, only the length of a path string.
 *
 * It was 50,000, inherited from a decoder whose limit was 4,000. At that
 * ceiling a deep two-month deployment — 147,000 samples at 5 m bins — was
 * being drawn at every third point before anyone had chosen anything.
 */
export const DEFAULT_MAX_POINTS = 200000;

export type PlotStyle = 'dots' | 'line' | 'both';

/** Columnar input. `n` is how many entries of each array are meaningful. */
export interface Series {
  x: Float64Array | readonly number[];
  y: Float64Array | readonly number[];
  /** The color axis. Omit for an uncolored plot. */
  c?: Float64Array | readonly number[];
  n: number;
}

/**
 * A point as drawn: what it says, and where the projection put it.
 *
 * The hover readout needs both. It cannot ask the DOM where a point is,
 * because the dots are a path per color step rather than an element per
 * point — there is nothing for `elementFromPoint` to return.
 */
export interface Placed {
  x: number;
  y: number;
  /** NaN where the plot has no color axis, or the row has no value. */
  c: number;
  sx: number;
  sy: number;
  /** Row index in the source series, so a caller can look up anything else
      it holds about that sample. */
  i: number;
}

/** The projection and the window, handed to `underlay`. */
export interface Frame {
  /** Data x to screen x. */
  px: (x: number) => number;
  /** Data y to screen y. Already accounts for `flipY`. */
  py: (y: number) => number;
  xLo: number;
  xHi: number;
  yLo: number;
  yHi: number;
  /** The plot area in screen units, for a clip or a label placement. */
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface PlotOptions {
  width: number;
  height: number;
  flipY?: boolean;
  style?: PlotStyle;
  dot?: number;
  map?: string;
  /** How many steps the color scale is quantized into. */
  steps?: number;
  xRange?: [number | null, number | null];
  yRange?: [number | null, number | null];
  cRange?: [number | null, number | null];
  cLabel?: string;
  xLabel?: string;
  yLabel?: string;
  xTime?: boolean;
  yTime?: boolean;
  cTime?: boolean;
  /** Drawn after the axes and before the points. */
  underlay?: (svg: SVGSVGElement, frame: Frame) => void;
  maxPoints?: number;
  /** The document to build nodes from. Defaults to the global one; passed
      explicitly by the tests, which have no global document. */
  doc?: Document;
}

export interface PlotResult {
  /**
   * Points that fell outside the reader's window.
   *
   * **Finite points only.** A sample with no x or no y is not "outside the
   * window", it is missing, and counting the two together produced a
   * caption reading "3,014 outside the window" on a plot with no window set
   * — which is not a limit the reader could widen, and reads as if the
   * figure were hiding something they asked to see.
   */
  hidden: number;
  /** Points with no value on the x or y axis: a gap in the record. */
  missing: number;
  /** Points with no value on the color axis. Counted, and **not drawn** —
      see the note in `plot`. */
  uncolored: number;
  placed: Placed[];
  /** Every nth point was drawn. 1 when nothing was skipped. */
  stride: number;
  /** How many were drawn, after the stride. */
  drawn: number;
  /** How many were considered. */
  total: number;
  /**
   * The projection and the window this draw used.
   *
   * Returned because a caller that wants to interpret a pointer position —
   * a drag across a section, say — needs the same mapping the points were
   * placed with, and recomputing it outside would be a second copy of the
   * padding arithmetic that could drift from this one.
   */
  frame: Frame;
}

/** Enough digits to read the scale, few enough to fit the gutter reserved
    for it — an overlong label is not wrapped or shrunk, it is clipped, which
    turns 125 m into 25 m and looks like data rather than a rendering fault. */
export function tick(v: number): string {
  if (!Number.isFinite(v)) return '';
  const size = Math.abs(v);
  if (size !== 0 && (size < 1e-2 || size >= 1e5)) return v.toExponential(1);
  const decimals = size >= 100 ? 0 : size >= 10 ? 1 : size >= 1 ? 2 : 3;
  return v.toFixed(decimals);
}

/** An instant, as a label. */
export function stamp(epochSeconds: number): string {
  if (!Number.isFinite(epochSeconds)) return '—';
  return new Date(epochSeconds * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

export function plot(
  svg: SVGSVGElement,
  series: Series,
  options: PlotOptions,
): PlotResult {
  const doc = options.doc ?? svg.ownerDocument ?? globalThis.document;
  const { width, height } = options;
  const coloring = options.cLabel !== undefined && series.c !== undefined;
  const ramp = (t: number): string => sample(options.map ?? DEFAULT_COLORMAP, t);

  // The color bar and its labels live outside the plot area, so the right
  // margin has to make room for them when there is one. A clock label is
  // wider than a number, so the axis gutters follow suit.
  const pad = {
    top: 12,
    right: coloring ? (options.cTime ? 132 : 92) : 14,
    bottom: 30,
    left: options.yTime ? 108 : 58,
  };

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  while (svg.lastChild && (svg.lastChild as Element).tagName !== 'title') svg.lastChild.remove();

  const n = Math.min(series.n, series.x.length, series.y.length);
  const blankFrame: Frame = {
    px: (x) => x, py: (y) => y, xLo: 0, xHi: 1, yLo: 0, yHi: 1,
    left: pad.left, right: width - pad.right, top: pad.top, bottom: height - pad.bottom,
  };
  const empty: PlotResult = {
    hidden: 0, missing: 0, uncolored: 0, placed: [], stride: 1, drawn: 0,
    total: n, frame: blankFrame,
  };
  if (n < 2) return empty;

  const xs = series.x;
  const ys = series.y;
  const cs = series.c;

  // A limit the reader set wins; the rest come from the data. Both are
  // computed before anything is clipped, so a limit is a window onto the
  // data rather than a re-scaling of whatever survived it.
  const bound = (
    values: Float64Array | readonly number[],
    range: [number | null, number | null] | undefined,
  ): [number, number] => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (lo === Infinity) { lo = 0; hi = 1; }
    if (range?.[0] !== null && range?.[0] !== undefined) lo = range[0];
    if (range?.[1] !== null && range?.[1] !== undefined) hi = range[1];
    // A zero-width axis divides by zero and puts every point in one place.
    if (hi === lo) hi = lo + 1;
    return [lo, hi];
  };

  const [xLoV, xHiV] = bound(xs, options.xRange);
  const [yLoV, yHiV] = bound(ys, options.yRange);
  const [cLoV, cHiV] = coloring && cs ? bound(cs, options.cRange) : [0, 1];

  /** An axis label: a clock where the axis is time, a number otherwise. */
  const mark = (v: number, isTime?: boolean): string =>
    (isTime ? stamp(v).slice(0, 16) : tick(v));

  const px = (x: number): number =>
    pad.left + ((x - xLoV) / (xHiV - xLoV)) * (width - pad.left - pad.right);
  const py = (y: number): number => {
    const t = (y - yLoV) / (yHiV - yLoV);
    const up = options.flipY ? t : 1 - t;
    return pad.top + up * (height - pad.top - pad.bottom);
  };

  /* **A closed box, not two legs.** A frame on all four sides is what a
     scientific figure wears, and it is what makes the plot area legible when
     the figure is dropped into a document that has its own background: two
     legs leave the top and right of the data floating against whatever is
     behind them. Drawn as one path, so it is still a single node. */
  const axis = doc.createElementNS(NS, 'path');
  axis.setAttribute('class', 'axis');
  axis.setAttribute(
    'd',
    `M ${pad.left} ${pad.top} `
    + `L ${pad.left} ${height - pad.bottom} `
    + `L ${width - pad.right} ${height - pad.bottom} `
    + `L ${width - pad.right} ${pad.top} Z`,
  );
  svg.append(axis);

  const label = (text: string, x: number, y: number, anchor: string, cls = 'tick'): void => {
    const el = doc.createElementNS(NS, 'text');
    el.setAttribute('class', cls);
    el.setAttribute('x', String(x));
    el.setAttribute('y', String(y));
    el.setAttribute('text-anchor', anchor);
    el.textContent = text;
    svg.append(el);
  };

  // The y labels sit outside the plot area, so `pad.left` has to be wide
  // enough for the longest of them. It was 46 with values printed to four
  // decimals, so a depth of 125.2447 m ran off the left of the viewBox and
  // was silently clipped to "25.2447" — a chart reporting a fifth of the
  // dive it had just drawn, with nothing to say it had been cut.
  label(mark(yLoV, options.yTime), pad.left - 5, py(yLoV) + 4, 'end');
  label(mark(yHiV, options.yTime), pad.left - 5, py(yHiV) + 4, 'end');
  label(mark(xLoV, options.xTime), pad.left, height - pad.bottom + 14, 'start');
  label(mark(xHiV, options.xTime), width - pad.right, height - pad.bottom + 14, 'end');
  // Naming the axes is what stops a plot of two chosen variables being a
  // picture of nothing in particular.
  if (options.xLabel) {
    label(options.xLabel, (pad.left + width - pad.right) / 2, height - 6, 'middle', 'axis-name');
  }
  if (options.yLabel) {
    const name = doc.createElementNS(NS, 'text');
    name.setAttribute('class', 'axis-name');
    name.setAttribute('text-anchor', 'middle');
    const mid = (pad.top + height - pad.bottom) / 2;
    name.setAttribute('x', '12');
    name.setAttribute('y', String(mid));
    name.setAttribute('transform', `rotate(-90 12 ${mid})`);
    name.textContent = options.yLabel;
    svg.append(name);
  }

  const frame: Frame = {
    px, py,
    xLo: xLoV, xHi: xHiV, yLo: yLoV, yHi: yHiV,
    left: pad.left, right: width - pad.right,
    top: pad.top, bottom: height - pad.bottom,
  };

  /* Between the axes and the points, so contours sit behind the data they
     describe. Given the projection rather than the values: what it draws is
     its own business, which is what keeps density out of this file. */
  options.underlay?.(svg, frame);

  let hidden = 0;
  let missing = 0;
  let uncolored = 0;
  /* Split deliberately: a sample with no value is not a sample the window
     excluded, and the caption says so separately. NaN fails every comparison,
     so the two are indistinguishable unless asked apart. */
  const present = (i: number): boolean =>
    Number.isFinite(xs[i]) && Number.isFinite(ys[i]);
  const inside = (i: number): boolean =>
    present(i) && xs[i] >= xLoV && xs[i] <= xHiV && ys[i] >= yLoV && ys[i] <= yHiV;

  const cap = Math.max(1000, options.maxPoints ?? DEFAULT_MAX_POINTS);
  const step = Math.max(1, Math.ceil(n / cap));

  const drawsLine = options.style === 'line' || options.style === 'both';
  const drawsDots = options.style !== 'line';

  // Where every drawn point ended up, for the hover readout. Collected in a
  // pass of its own rather than inside either drawing loop, because a
  // line-only plot runs neither of them for its points and a reader pointing
  // at a line still expects to be told what is under the pointer. Same
  // decimation as the drawing, so the readout can only ever name a point
  // that is actually on screen.
  /**
   * **A point with no value on the colour axis is not drawn.**
   *
   * It used to be, in the structural trace colour, on the reasoning that a
   * reader should see where samples exist. That is right for an uncoloured
   * plot and wrong for a coloured one, and a real case shows how wrong: an
   * optical sensor samples far less often than the CTD, so a chlorophyll
   * section was 71,867 accent-blue dots with no chlorophyll behind 1,284
   * that had it. The figure showed the CTD's sampling pattern and read as
   * though chlorophyll had been measured everywhere.
   *
   * Omitting them is also what every plotting library does with a NaN in the
   * colour array. They are still counted, and the caption still reports
   * them, so nothing is hidden — it is just not painted as data.
   */
  const skip = (i: number): boolean => coloring && !!cs && !Number.isFinite(cs[i]);

  const placed: Placed[] = [];
  let drawn = 0;
  for (let i = 0; i < n; i += step) {
    if (!inside(i)) continue;
    /* Out of the hover search too: pointing at a gap should name the nearest
       real measurement, not a point that was never drawn. */
    if (skip(i)) continue;
    drawn++;
    placed.push({
      x: xs[i], y: ys[i], c: cs ? cs[i] : NaN, sx: px(xs[i]), sy: py(ys[i]), i,
    });
  }

  if (drawsLine) {
    let d = '';
    let pen = 'M';
    for (let i = 0; i < n; i += step) {
      // A line has to lift its pen over a gap rather than draw a chord
      // straight across the excluded stretch, which would be a segment the
      // data does not support.
      if (!inside(i) || skip(i)) {
        if (!inside(i)) { if (present(i)) hidden++; else missing++; }
        pen = 'M';
        continue;
      }
      d += `${pen} ${px(xs[i]).toFixed(1)} ${py(ys[i]).toFixed(1)} `;
      pen = 'L';
    }
    const line = doc.createElementNS(NS, 'path');
    line.setAttribute('class', 'trace');
    line.setAttribute('d', d);
    svg.append(line);
  }

  // The dots are what carry the color — a single path holds one stroke, and
  // a color axis needs one per bin — so a colored line plot draws its dots
  // too, at the size the reader set. Only a plain `line` skips them, and
  // then the color axis has nothing to paint, which is why the style menu
  // offers `both` and defaults a time series to it.
  // One path per color step rather than one per point: 50,000 dots is 50,000
  // DOM nodes and a visible pause, where two dozen steps is two dozen nodes.
  // How many steps is the reader's, and the color bar is drawn with the same
  // number — a legend showing a smooth ramp beside a plot drawn in five
  // colors describes a picture that is not on screen.
  const BINS = Math.min(256, Math.max(2, Math.round(options.steps ?? DEFAULT_STEPS)));

  if (drawsDots || coloring) {
    const bins: string[] = new Array(coloring ? BINS : 0).fill('');
    let plain = '';
    for (let i = 0; i < n; i += step) {
      if (!inside(i)) {
        if (!drawsLine) { if (present(i)) hidden++; else missing++; }
        continue;
      }
      const d = `M ${px(xs[i]).toFixed(1)} ${py(ys[i]).toFixed(1)} h 0.8 `;
      if (!coloring || !cs) { if (drawsDots) plain += d; continue; }
      if (!Number.isFinite(cs[i])) { uncolored++; continue; }
      const t = (cs[i] - cLoV) / (cHiV - cLoV);
      bins[Math.min(BINS - 1, Math.max(0, Math.floor(t * BINS)))] += d;
    }

    /**
     * One path of dots.
     *
     * **Inline styles, not presentation attributes**, and that is the whole
     * of it: `.trace` sets `stroke` and `stroke-width` in the stylesheet,
     * and a CSS declaration beats a presentation attribute however specific
     * the attribute looks. Set as attributes, both the color axis and the
     * point size were silently discarded — the dots came out in `--accent`
     * at 1.5px whatever the reader chose. An inline style wins over any
     * class rule, so it is what a value-driven property has to use here.
     *
     * The line keeps taking its stroke from the class, which is why the
     * class still sets one: a line is structural and follows the theme.
     */
    const dot = (d: string, stroke?: string): void => {
      if (!d) return;
      const path = doc.createElementNS(NS, 'path');
      path.setAttribute('class', 'trace');
      path.setAttribute('stroke-linecap', 'round');
      path.style.strokeWidth = String(options.dot ?? 2.5);
      if (stroke) path.style.stroke = stroke;
      path.setAttribute('d', d);
      svg.append(path);
    };
    dot(plain);
    bins.forEach((d, i) => dot(d, ramp((i + 0.5) / BINS)));
  }

  if (coloring) {
    const barX = width - pad.right + 16;
    const barTop = pad.top;
    const barBottom = height - pad.bottom;
    // The same steps the dots are binned into, at the same midpoints. It was
    // a fixed 32 against 24 bins, so the bar was already showing colors the
    // plot never drew; with the count in the reader's hands that stops being
    // a rounding difference and becomes a legend for a different picture.
    for (let i = 0; i < BINS; i++) {
      const rect = doc.createElementNS(NS, 'rect');
      rect.setAttribute('class', 'color-bar');
      rect.setAttribute('x', String(barX));
      rect.setAttribute('width', '12');
      rect.setAttribute('y', String(barBottom - ((i + 1) / BINS) * (barBottom - barTop)));
      rect.setAttribute('height', String((barBottom - barTop) / BINS + 0.5));
      rect.setAttribute('fill', ramp((i + 0.5) / BINS));
      svg.append(rect);
    }
    const frame = doc.createElementNS(NS, 'rect');
    frame.setAttribute('class', 'color-frame');
    frame.setAttribute('x', String(barX));
    frame.setAttribute('y', String(barTop));
    frame.setAttribute('width', '12');
    frame.setAttribute('height', String(barBottom - barTop));
    svg.append(frame);
    label(mark(cHiV, options.cTime), barX + 16, barTop + 8, 'start');
    label(mark(cLoV, options.cTime), barX + 16, barBottom, 'start');
    // The bar says what the colors mean but not what they are *of*, which
    // the caption was carrying alone — and a caption does not travel into an
    // exported PNG. Named on the plot, the picture stands on its own
    // wherever it ends up.
    const name = doc.createElementNS(NS, 'text');
    name.setAttribute('class', 'axis-name');
    name.setAttribute('text-anchor', 'middle');
    const mid = (barTop + barBottom) / 2;
    name.setAttribute('x', String(width - 6));
    name.setAttribute('y', String(mid));
    name.setAttribute('transform', `rotate(-90 ${width - 6} ${mid})`);
    name.textContent = options.cLabel ?? '';
    svg.append(name);
  }

  return { hidden, missing, uncolored, placed, stride: step, drawn, total: n, frame };
}
