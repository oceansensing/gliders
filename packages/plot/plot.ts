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

/**
 * Breathing room at the ends of an axis the data set, as a fraction of the
 * span.
 *
 * **An axis that ends exactly at the data draws half of its outermost marker
 * outside the box.** Measured on the deployment page: the extreme dots of
 * every figure sat 0.0 px from the frame, and overhung it by 0.8 px on the
 * right — their own half-width. The rule this pays for is the one that says a
 * point must not be scaled off the edge, and a marker sliced by the frame is
 * exactly that, just less obviously.
 *
 * Three per cent rather than the five most plotting libraries default to,
 * because the same code draws sections against time. Five per cent of a
 * four-week window is a day and a half of blank at each end, which reads as
 * the glider having reported nothing there; three is about thirteen pixels on
 * a 450 px plot, which reads as a margin.
 *
 * A limit the reader typed never gets it — see `bound`.
 */
export const AXIS_MARGIN = 0.03;

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

/**
 * Round values to put ticks on, inside `[lo, hi]`.
 *
 * The classic 1–2–5 ladder: take the span the caller wants divided into,
 * round the step up to the next 1, 2, 5 or 10 times a power of ten, and walk
 * from the first multiple inside the range. A reader can do arithmetic in
 * their head on 25, 30, 35; they cannot on 26.4, 31.7, 37.0.
 *
 * `count` is a target and not a promise — landing on a round step matters
 * more than landing on a particular number of them, so the result comes back
 * with anywhere from about half to about twice as many.
 */
export function niceTicks(lo: number, hi: number, count = 6): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) return [];
  const raw = (hi - lo) / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / magnitude;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * magnitude;
  const out: number[] = [];
  /* The epsilon is against binary rounding, not against the data: without it
     a step of 0.1 walking to exactly 3 stops at 2.9000000000000004. */
  const eps = step * 1e-9;
  for (let v = Math.ceil(lo / step) * step; v <= hi + eps; v += step) {
    /* Snapped for the same reason — 0.30000000000000004 prints as 0.3 but
       compares as something else, and the label formatter would show it. */
    out.push(Math.abs(v) < eps ? 0 : Number(v.toFixed(12)));
  }
  return out;
}

/**
 * The same, for an axis of epoch seconds.
 *
 * Time is not decimal and a 1–2–5 ladder on it produces ticks every 1.5 days
 * at 03:47, which is a worse label than no label. So the step comes from a
 * table of intervals a person would actually choose, and the marks land on
 * multiples of it — midnight for a daily axis, the hour for an hourly one.
 */
const TIME_STEPS = [
  60, 300, 900, 1800, 3600, 2 * 3600, 3 * 3600, 6 * 3600, 12 * 3600,
  86400, 2 * 86400, 7 * 86400, 14 * 86400, 30 * 86400, 90 * 86400,
  180 * 86400, 365 * 86400,
];

export function niceTimeTicks(lo: number, hi: number, count = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) return [];
  const want = (hi - lo) / Math.max(1, count);
  const step = TIME_STEPS.find((s) => s >= want) ?? TIME_STEPS[TIME_STEPS.length - 1];
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
  return out;
}

/**
 * A time tick's label, at the resolution the spacing between them justifies.
 *
 * A full `2026-07-15 21:01` is sixteen characters, and six of them across a
 * 450 px axis overlap into a smear. Ticks a day or more apart are dated and
 * not clocked; ticks inside a day are clocked and not dated — the axis name
 * and the caption carry the rest.
 */
export function timeTickLabel(seconds: number, step: number): string {
  const full = stamp(seconds);
  if (step >= 365 * 86400) return full.slice(0, 4);
  if (step >= 28 * 86400) return full.slice(0, 7);
  if (step >= 86400) return full.slice(5, 10);
  return full.slice(11, 16);
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
  /**
   * `bottom` is 30 because two things stack there and they used not to.
   *
   * The x labels were the two ends only, in the corners, so a centred axis
   * name passed between them and 30 px held both on one line. Ticks run the
   * width of the axis now, and at 30 the middle ones printed straight through
   * "Absolute Salinity (g/kg)". 46 is the label's baseline at +15, the name's
   * at +34, and 12 px of leading between them.
   */
  const pad = {
    top: 12,
    right: coloring ? (options.cTime ? 132 : 92) : 14,
    bottom: options.xLabel ? 46 : 30,
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
    margin = 0,
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
    /* Which ends the reader fixed, and which the data did. Only the data's
       get a margin: a limit somebody typed has to be the limit that is drawn,
       or the box does not say what they asked for and the count of samples
       outside it is counted against a different number than the one on the
       axis. It is also what keeps a depth axis pinned at exactly 0 rather
       than opening at a negative depth. */
    const readerLo = range?.[0] !== null && range?.[0] !== undefined;
    const readerHi = range?.[1] !== null && range?.[1] !== undefined;
    if (readerLo) lo = range![0]!;
    if (readerHi) hi = range![1]!;
    // A zero-width axis divides by zero and puts every point in one place.
    if (hi === lo) hi = lo + 1;
    /* Measured from the span before either end moves, so the two sides get
       the same margin. */
    const pad = (hi - lo) * margin;
    if (!readerLo) lo -= pad;
    if (!readerHi) hi += pad;
    return [lo, hi];
  };

  const [xLoV, xHiV] = bound(xs, options.xRange, AXIS_MARGIN);
  const [yLoV, yHiV] = bound(ys, options.yRange, AXIS_MARGIN);
  /* **The colour axis takes no margin.** Its ends are printed on the bar and
     read as the range in force — the 2nd and 98th percentiles, or what the
     reader typed. Padding those would put a number on the bar that is not the
     number the colours were mapped from. */
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

  /**
   * Ticks, their marks, and a grid line each.
   *
   * **The plot used to carry two numbers per axis** — the ends, in the
   * corners — which says what the range is and nothing about where anything
   * inside it sits. Reading a feature off a section meant measuring against
   * the frame with a finger.
   *
   * How many is set by the room available, not by taste: a label is about
   * 7 px per character in the mono face these are set in, so an x axis gets
   * one per 78 px and a y axis one per 34 px, and the 1–2–5 ladder rounds
   * from there. Too many is worse than too few — overlapping labels are
   * unreadable *and* look like a rendering fault.
   *
   * The grid is one path per axis rather than one per line, for the same
   * reason the dots are one path per colour bin: nothing about the document
   * should grow with what is drawn. `fill: none` matters here as much as on
   * the axis — an unclosed grid path fills to a triangle across the plot.
   */
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const xTicks = options.xTime
    ? niceTimeTicks(xLoV, xHiV, Math.max(2, Math.min(7, Math.floor(plotW / 78))))
    : niceTicks(xLoV, xHiV, Math.max(2, Math.min(8, Math.floor(plotW / 78))));
  const yTicks = options.yTime
    ? niceTimeTicks(yLoV, yHiV, Math.max(2, Math.min(7, Math.floor(plotH / 34))))
    : niceTicks(yLoV, yHiV, Math.max(2, Math.min(8, Math.floor(plotH / 34))));
  const xStep = xTicks.length > 1 ? xTicks[1] - xTicks[0] : xHiV - xLoV;
  const yStep = yTicks.length > 1 ? yTicks[1] - yTicks[0] : yHiV - yLoV;

  const TICK = 4;
  const grid: string[] = [];
  const marks: string[] = [];
  for (const v of xTicks) {
    const at = px(v);
    grid.push(`M ${at} ${pad.top} L ${at} ${height - pad.bottom}`);
    marks.push(`M ${at} ${height - pad.bottom} L ${at} ${height - pad.bottom + TICK}`);
  }
  for (const v of yTicks) {
    const at = py(v);
    grid.push(`M ${pad.left} ${at} L ${width - pad.right} ${at}`);
    marks.push(`M ${pad.left - TICK} ${at} L ${pad.left} ${at}`);
  }
  if (grid.length) {
    const g = doc.createElementNS(NS, 'path');
    g.setAttribute('class', 'grid');
    g.setAttribute('d', grid.join(' '));
    /* Inserted before the frame so the box is drawn over its own ends, and
       before the underlay so contours and points sit on top of it. */
    svg.insertBefore(g, axis);
  }
  if (marks.length) {
    const m = doc.createElementNS(NS, 'path');
    m.setAttribute('class', 'tick-mark');
    m.setAttribute('d', marks.join(' '));
    svg.append(m);
  }

  // The y labels sit outside the plot area, so `pad.left` has to be wide
  // enough for the longest of them. It was 46 with values printed to four
  // decimals, so a depth of 125.2447 m ran off the left of the viewBox and
  // was silently clipped to "25.2447" — a chart reporting a fifth of the
  // dive it had just drawn, with nothing to say it had been cut.
  const axisLabel = (v: number, isTime: boolean | undefined, step: number): string =>
    (isTime ? timeTickLabel(v, step) : tick(v));
  for (const v of yTicks) {
    label(axisLabel(v, options.yTime, yStep), pad.left - TICK - 3, py(v) + 4, 'end');
  }
  for (const v of xTicks) {
    label(axisLabel(v, options.xTime, xStep), px(v), height - pad.bottom + 15, 'middle');
  }
  /* With no round value inside the range there would be no numbers at all, so
     the ends stand in — a one-sample plot, or a span narrower than the finest
     step the ladder offers. */
  if (!xTicks.length) {
    label(mark(xLoV, options.xTime), pad.left, height - pad.bottom + 15, 'start');
    label(mark(xHiV, options.xTime), width - pad.right, height - pad.bottom + 15, 'end');
  }
  if (!yTicks.length) {
    label(mark(yLoV, options.yTime), pad.left - 5, py(yLoV) + 4, 'end');
    label(mark(yHiV, options.yTime), pad.left - 5, py(yHiV) + 4, 'end');
  }
  // Naming the axes is what stops a plot of two chosen variables being a
  // picture of nothing in particular.
  if (options.xLabel) {
    label(options.xLabel, (pad.left + width - pad.right) / 2,
      height - pad.bottom + 34, 'middle', 'axis-name');
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
