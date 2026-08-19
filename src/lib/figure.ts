/**
 * Wiring a `PlotFigure`'s controls to the plot engine.
 *
 * The markup is `PlotFigure.astro`; this is everything that happens when a
 * reader touches it. Kept out of the component so it can be tested without a
 * page and reused by three figures that differ only in their preset — the
 * section, the T–S diagram and the profile explorer are one implementation.
 *
 * Controls are found by `data-plot-*` attribute rather than by id, because a
 * page carries several figures and ids would have to be uniquified by the
 * caller — the trap the original decoder avoided the same way.
 */

import {
  plot, standalone, save, svgToPng, exportName, robustRange, COLORMAPS,
  DEFAULT_COLORMAP, ROBUST_HIGH, ROBUST_LOW, sample,
  type PlotOptions, type PlotResult, type PlotStyle, type Series,
} from '@c4po/plot';
import { axisLabel, type Plottable } from './variables.ts';

/** The columns a figure can draw, and what they are called. */
export interface Source {
  columns: Map<string, Float64Array>;
  rows: number;
  variables: Plottable[];
  /** Name of the column holding epoch seconds, so axes can format clocks. */
  timeVar: string;
}

export interface Preset {
  x: string;
  y: string;
  c?: string;
  flipY?: boolean;
  style?: PlotStyle;
  dot?: number;
  height?: number;
  /** Colormap override; otherwise the color variable's own. */
  map?: string;
  /** Drawn behind the points, in data coordinates. */
  underlay?: PlotOptions['underlay'];
  /** Extra sentence appended to the caption. */
  note?: string;
  /**
   * Limits to open the y range boxes with, as text.
   *
   * Written into the boxes rather than forced behind them, so the reader can
   * see the limit, change it, and get it back with Reset. `['0', '']` is
   * what every depth axis uses: a profile starts at the surface, and an
   * axis that starts at 0.103 m because that is the shallowest sample is
   * answering a question about the sampling rather than about the ocean.
   */
  yBoxes?: [string, string];
  /**
   * Called when the reader drags across the figure horizontally, with the
   * span they covered in data units. Only offered while the x axis is time,
   * because "load this range" means something there and nothing on a T–S
   * diagram, where x is salinity.
   */
  onSelectX?: (from: number, to: number) => void;
}

export interface Figure {
  /** New data; keeps the reader's axis and colormap choices. */
  update(source: Source): void;
  /** Redraw with what it already has. */
  draw(): void;
  /** The variables currently on each axis. */
  readonly axes: { x: string; y: string; c: string };
}

const NS = 'http://www.w3.org/2000/svg';

export function makeFigure(root: HTMLElement, preset: Preset): Figure {
  const at = <T extends Element = HTMLElement>(sel: string): T =>
    root.querySelector<T>(sel)!;

  const svg = at<SVGSVGElement>('[data-plot-svg]');
  const caption = at('[data-plot-caption]');
  const hover = at('[data-plot-hover]');
  const sel = {
    x: at<HTMLSelectElement>('[data-plot-x]'),
    y: at<HTMLSelectElement>('[data-plot-y]'),
    c: at<HTMLSelectElement>('[data-plot-c]'),
  };
  const box = {
    xLo: at<HTMLInputElement>('[data-plot-x-lo]'),
    xHi: at<HTMLInputElement>('[data-plot-x-hi]'),
    yLo: at<HTMLInputElement>('[data-plot-y-lo]'),
    yHi: at<HTMLInputElement>('[data-plot-y-hi]'),
    cLo: at<HTMLInputElement>('[data-plot-c-lo]'),
    cHi: at<HTMLInputElement>('[data-plot-c-hi]'),
  };
  const heightBox = at<HTMLInputElement>('[data-plot-h]');
  const dotBox = at<HTMLInputElement>('[data-plot-dot]');
  const stepsBox = at<HTMLInputElement>('[data-plot-steps]');
  const mapSel = at<HTMLSelectElement>('[data-plot-map]');
  const ramp = at('[data-plot-ramp]');
  const flipBtn = at<HTMLButtonElement>('[data-plot-flip]');
  const styleSel = at<HTMLSelectElement>('[data-plot-style]');
  const pngBtn = at<HTMLButtonElement>('[data-plot-png]');
  const resetBtn = at<HTMLButtonElement>('[data-plot-reset]');

  let source: Source | null = null;
  let last: PlotResult | null = null;
  /** The projection the last draw used, for turning a pointer position back
      into a data value. Comes from the engine rather than being recomputed
      here, so the two cannot drift. */
  let lastFrame: PlotResult['frame'] | null = null;
  let flip = preset.flipY ?? false;

  /* Filled once: the scales are a fixed list, not something the data
     decides. */
  for (const name of Object.keys(COLORMAPS)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    mapSel.append(opt);
  }
  mapSel.value = preset.map ?? DEFAULT_COLORMAP;
  styleSel.value = preset.style ?? 'dots';
  flipBtn.setAttribute('aria-pressed', String(flip));
  if (preset.height) heightBox.value = String(preset.height);
  if (preset.dot) dotBox.value = String(preset.dot);
  if (preset.yBoxes) {
    box.yLo.value = preset.yBoxes[0];
    box.yHi.value = preset.yBoxes[1];
  }

  function fillAxes(): void {
    if (!source) return;
    const options = source.variables.filter((v) => source!.columns.has(v.name));
    for (const [which, element] of Object.entries(sel) as Array<['x' | 'y' | 'c', HTMLSelectElement]>) {
      const keep = element.value;
      element.replaceChildren();
      if (which === 'c') {
        const none = document.createElement('option');
        none.value = '';
        none.textContent = 'none';
        element.append(none);
      }
      for (const v of options) {
        const opt = document.createElement('option');
        opt.value = v.name;
        opt.textContent = v.units ? `${v.label} (${v.units})` : v.label;
        element.append(opt);
      }
      const wanted = keep || preset[which] || '';
      element.value = options.some((v) => v.name === wanted) ? wanted : (options[0]?.name ?? '');
    }
  }

  const meta = (name: string): Plottable | undefined =>
    source?.variables.find((v) => v.name === name);

  const isTime = (name: string): boolean => name === source?.timeVar;

  /** A range box's value, or null when it is empty or unreadable. A time
      axis takes a `datetime-local`, which has no zone — read as UTC, which
      is what every other clock on this page is in. */
  function limit(input: HTMLInputElement, time: boolean): number | null {
    const raw = input.value.trim();
    if (!raw) return null;
    if (time) {
      const t = Date.parse(raw.endsWith('Z') ? raw : `${raw}Z`);
      return Number.isFinite(t) ? t / 1000 : null;
    }
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  }

  /** Switch a range box between a number field and a clock field, so a time
      axis gets a date picker rather than an epoch nobody can type. */
  function retype(input: HTMLInputElement, time: boolean): void {
    const want = time ? 'datetime-local' : 'number';
    if (input.type !== want) {
      input.type = want;
      input.value = '';
    }
  }

  function draw(): void {
    if (!source) return;
    const xName = sel.x.value;
    const yName = sel.y.value;
    const cName = sel.c.value;
    const x = source.columns.get(xName);
    const y = source.columns.get(yName);
    const c = cName ? source.columns.get(cName) : undefined;
    if (!x || !y) {
      caption.textContent = 'Nothing to draw yet.';
      return;
    }

    const xTime = isTime(xName);
    const yTime = isTime(yName);
    const cTime = Boolean(cName) && isTime(cName);
    retype(box.xLo, xTime); retype(box.xHi, xTime);
    retype(box.yLo, yTime); retype(box.yHi, yTime);
    retype(box.cLo, cTime); retype(box.cHi, cTime);

    const cMeta = cName ? meta(cName) : undefined;
    /* The colormap follows the color variable unless the reader has chosen
       one. Tracked by a flag rather than by comparing against the default,
       so picking viridis deliberately is not mistaken for not having
       picked. */
    if (!mapTouched && cMeta) mapSel.value = preset.map ?? cMeta.colormap;
    paintRamp();

    const height = clampInt(heightBox.value, 160, 1200, 380);
    const width = Math.max(320, Math.round(root.getBoundingClientRect().width) || 900);

    const series: Series = { x, y, c, n: source.rows };
    const options: PlotOptions = {
      width,
      height,
      flipY: flip,
      style: styleSel.value as PlotStyle,
      dot: clampNum(dotBox.value, 0.5, 12, 2.5),
      steps: clampInt(stepsBox.value, 2, 256, 24),
      map: mapSel.value,
      xRange: [limit(box.xLo, xTime), limit(box.xHi, xTime)],
      yRange: [limit(box.yLo, yTime), limit(box.yHi, yTime)],
      cRange: colourLimits(c, cTime),
      xLabel: labelFor(xName),
      yLabel: labelFor(yName),
      cLabel: c ? labelFor(cName) : undefined,
      xTime, yTime, cTime,
      underlay: preset.underlay,
    };

    last = plot(svg, series, options);
    lastFrame = last.frame;
    say();
  }

  /**
   * The colour axis's limits: the reader's, or percentiles of the data.
   *
   * Not the true minimum and maximum, which is what the engine would use.
   * A colour bar has a couple of dozen entries and stretching it to reach
   * one bad sample spends nearly all of them on water that is not there —
   * measured on a real chlorophyll record whose minimum is a negative
   * concentration. See `packages/plot/robust.ts`.
   *
   * **A time axis keeps its true span.** The 2nd percentile of a mission's
   * clock is not a defensible start date; it is just the mission minus its
   * first few hours, and a reader comparing the colour bar with the section's
   * own time axis would find them disagreeing for no stated reason.
   */
  let robust: [number, number] | null = null;
  function colourLimits(
    values: Float64Array | undefined, isTime: boolean,
  ): [number | null, number | null] {
    const asked: [number | null, number | null] = [
      limit(box.cLo, isTime), limit(box.cHi, isTime),
    ];
    robust = null;
    if (!values || isTime || !source) return asked;
    if (asked[0] !== null && asked[1] !== null) return asked;
    robust = robustRange(values, source.rows);
    if (!robust) return asked;
    /* Clamped to what the quantity can physically be. An optical sensor's
       dark counts put a few chlorophyll readings below zero, so percentiles
       alone still started that colour bar at −0.03 µg/L — a negative
       concentration. The samples are untouched and still drawn; it is the
       *scale* that is not allowed to claim water that cannot exist. */
    const floor = meta(sel.c.value)?.floor;
    const low = floor !== undefined ? Math.max(robust[0], floor) : robust[0];
    if (low !== robust[0]) robust = [low, robust[1]];
    return [asked[0] ?? low, asked[1] ?? robust[1]];
  }

  function labelFor(name: string): string {
    const m = meta(name);
    return m ? axisLabel(m) : name;
  }

  /**
   * What the picture is, and what it is not.
   *
   * Every number here is one the reader cannot see for themselves: how many
   * samples the window excluded, how many had no color value, and — the one
   * that matters most — whether the engine drew every point or every nth.
   * A plot that has quietly dropped nine tenths of its data and says nothing
   * is the failure this caption exists to prevent.
   */
  function say(): void {
    if (!last || !source) return;
    const bits: string[] = [];
    bits.push(`${last.drawn.toLocaleString()} of ${last.total.toLocaleString()} samples`);
    if (last.stride > 1) bits.push(`every ${ordinal(last.stride)} drawn`);
    /* "Outside the window" and "no value" are different facts and were once
       one number: a plot with no limits set reported thousands of samples
       outside a window the reader had not drawn, when they were simply rows
       the glider never filled in. */
    if (last.hidden > 0) bits.push(`${last.hidden.toLocaleString()} outside the window`);
    if (last.missing > 0) bits.push(`${last.missing.toLocaleString()} with no value here`);
    if (last.uncolored > 0) {
      bits.push(`${last.uncolored.toLocaleString()} not shown: no ${
        meta(sel.c.value)?.short ?? 'value'} there`);
    }
    /* Said out loud, because the colour bar's numbers are not the data's
       full range and a reader is entitled to know which they are looking
       at. */
    if (robust) bits.push(`colour ${ROBUST_LOW}–${ROBUST_HIGH}%`);
    caption.textContent = bits.join(' · ') + (preset.note ? ` · ${preset.note}` : '');
  }

  function paintRamp(): void {
    const name = mapSel.value;
    const stops = 24;
    ramp.replaceChildren();
    for (let i = 0; i < stops; i++) {
      const cell = document.createElement('span');
      cell.style.background = sample(name, (i + 0.5) / stops);
      ramp.append(cell);
    }
  }

  /**
   * Dragging across the figure picks a time range.
   *
   * The gesture an oceanographer already makes at a section — see a feature,
   * sweep across it — so it is the one that loads that stretch at a finer
   * resolution. Offered only while the x axis is time: on a T–S diagram a
   * horizontal drag spans salinity, and "load this range" has no meaning.
   *
   * The band is drawn in the SVG rather than as an overlay so it lands in
   * the plot's own coordinate space and needs no separate positioning, and
   * it is removed on every redraw by the engine's own child-clearing.
   */
  let band: SVGRectElement | null = null;
  let dragFrom: number | null = null;

  const toData = (clientX: number): number => {
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / (svg.viewBox.baseVal.width || rect.width);
    return (clientX - rect.left) / scale;
  };

  /** Screen x back to a data value, through the frame the last draw used. */
  const dataAt = (screenX: number): number => {
    if (!lastFrame) return NaN;
    const { left, right, xLo, xHi } = lastFrame;
    const t = (screenX - left) / (right - left);
    return xLo + t * (xHi - xLo);
  };

  const selectable = (): boolean =>
    Boolean(preset.onSelectX) && isTime(sel.x.value);

  svg.addEventListener('pointerdown', (event) => {
    if (!selectable() || event.button !== 0) return;
    dragFrom = toData(event.clientX);
    svg.setPointerCapture(event.pointerId);
  });

  svg.addEventListener('pointerup', (event) => {
    if (dragFrom === null) return;
    const to = toData(event.clientX);
    const from = dragFrom;
    dragFrom = null;
    band?.remove();
    band = null;
    /* A click is not a drag. Below this the reader was pointing at a value,
       not sweeping a range, and reloading the page's whole window from a
       stray click would be startling. */
    if (Math.abs(to - from) < 8) return;
    const a = dataAt(Math.min(from, to));
    const b = dataAt(Math.max(from, to));
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) preset.onSelectX!(a, b);
  });

  /**
   * The pointer readout: built once, then only its numbers change.
   *
   * **Symbols, not names.** Spelled out, this line read "Absolute Salinity
   * 32.1183 · Conservative Temperature 16.0676 · Depth 19.1766" — eighty
   * characters, which in the T–S diagram's half-width column wrapped onto
   * three lines, grew the figure's head from 26 px to 80 px, and dropped the
   * plot 54 px out from under the pointer that summoned it. The plot's own
   * axes carry the full label already, so the symbol is what belongs here
   * anyway.
   *
   * **Every value sits in a slot of fixed width**, and that is the second
   * half of holding still. With the text right-aligned and the numbers free
   * to change length, `32.1102` becoming `9.87` shortened the whole line and
   * slid the labels sideways under the pointer — stable vertically and
   * jittering horizontally, which is no better. A fixed `ch` width per value
   * plus tabular figures means the line is the same length whatever the
   * numbers are, so nothing moves at all.
   *
   * Rebuilt only when the axes change: this runs on every pointer move, and
   * replacing six nodes per move to write the same labels again would be
   * churn for nothing.
   */
  interface Slot { value: HTMLElement }
  let slots: Slot[] = [];
  let slotKey = '';

  function buildReadout(): void {
    const names = [sel.x.value, sel.y.value, sel.c.value];
    const key = names.join('|');
    if (key === slotKey) return;
    slotKey = key;
    slots = [];
    hover.replaceChildren();

    names.forEach((name, i) => {
      /* No colour axis chosen: no third slot, rather than an empty one that
         reserves width for a value that will never arrive. */
      if (i === 2 && !name) return;
      /* **A fixed-width space, and it has to be.** `white-space: nowrap`
         still collapses a run of ordinary spaces, so "  ·  " would render as
         a single space and the three groups would crowd together. U+2002 is
         not collapsible, so what is written here is what appears. */
      if (slots.length > 0) hover.append(document.createTextNode('\u2002·\u2002'));
      const label = document.createElement('span');
      /* **U+2007 FIGURE SPACE: exactly one character wide in a monospace
         face**, because it is defined as the width of a digit and every
         glyph here is that width. A thin space (U+2009) sat the number
         almost against its own label; an ordinary space would be collapsed
         by `nowrap` where it meets the separator's. */
      label.textContent = `${meta(name)?.short ?? meta(name)?.label ?? name}\u2007`;
      const value = document.createElement('span');
      /* A clock is 19 characters and a number rarely more than nine, so one
         width for both would reserve a lot of nothing on every numeric
         axis. */
      value.className = isTime(name) ? 'ro-v ro-time' : 'ro-v';
      hover.append(label, value);
      slots.push({ value });
    });
  }

  function showReadout(x: number, y: number, c: number): void {
    buildReadout();
    const names = [sel.x.value, sel.y.value, sel.c.value];
    const values = [x, y, c];
    slots.forEach((slot, i) => {
      const v = values[i];
      slot.value.textContent = Number.isFinite(v)
        ? (isTime(names[i]) ? clock(v) : trim(v))
        : '—';
    });
    hover.classList.add('live');
  }

  /** Emptied by class rather than by removing the nodes, so the slot keeps
      the width it had and the figure does not twitch as the pointer leaves
      and re-enters. */
  function clearReadout(): void {
    hover.classList.remove('live');
  }

  /* The pointer readout. The dots are one path per color bin, so there is no
     element under the pointer to ask — the nearest placed point is found by
     search over what was actually drawn. */
  let ring: SVGCircleElement | null = null;
  svg.addEventListener('pointermove', (event) => {
    if (dragFrom !== null && lastFrame) {
      const x = toData(event.clientX);
      if (!band) {
        band = document.createElementNS(NS, 'rect');
        band.setAttribute('class', 'select-band');
        svg.append(band);
      }
      band.setAttribute('x', String(Math.min(dragFrom, x)));
      band.setAttribute('width', String(Math.abs(x - dragFrom)));
      band.setAttribute('y', String(lastFrame.top));
      band.setAttribute('height', String(lastFrame.bottom - lastFrame.top));
      return;
    }
    if (!last || last.placed.length === 0) return;
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / (svg.viewBox.baseVal.width || rect.width);
    const sx = (event.clientX - rect.left) / scale;
    const sy = (event.clientY - rect.top) / scale;

    let best = last.placed[0];
    let bestD = Infinity;
    for (const p of last.placed) {
      const d = (p.sx - sx) ** 2 + (p.sy - sy) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    if (bestD > 400) { clearReadout(); ring?.remove(); ring = null; return; }

    showReadout(best.x, best.y, best.c);

    if (!ring) {
      ring = document.createElementNS(NS, 'circle');
      ring.setAttribute('class', 'ring');
      ring.setAttribute('r', '5');
      svg.append(ring);
    }
    ring.setAttribute('cx', String(best.sx));
    ring.setAttribute('cy', String(best.sy));
  });
  svg.addEventListener('pointerleave', () => {
    clearReadout();
    ring?.remove();
    ring = null;
  });

  let mapTouched = false;
  mapSel.addEventListener('change', () => { mapTouched = true; draw(); });
  for (const el of [sel.x, sel.y, sel.c, styleSel]) {
    el.addEventListener('change', () => { if (el === sel.c) mapTouched = false; draw(); });
  }
  for (const el of [...Object.values(box), heightBox, dotBox, stepsBox]) {
    el.addEventListener('input', draw);
  }
  flipBtn.addEventListener('click', () => {
    flip = !flip;
    flipBtn.setAttribute('aria-pressed', String(flip));
    draw();
  });
  resetBtn.addEventListener('click', () => {
    for (const el of Object.values(box)) el.value = '';
    if (preset.yBoxes) {
      box.yLo.value = preset.yBoxes[0];
      box.yHi.value = preset.yBoxes[1];
    }
    heightBox.value = String(preset.height ?? 380);
    dotBox.value = String(preset.dot ?? 2.5);
    stepsBox.value = '24';
    styleSel.value = preset.style ?? 'dots';
    flip = preset.flipY ?? false;
    flipBtn.setAttribute('aria-pressed', String(flip));
    mapTouched = false;
    if (source) {
      sel.x.value = preset.x;
      sel.y.value = preset.y;
      sel.c.value = preset.c ?? '';
    }
    draw();
  });

  pngBtn.addEventListener('click', async () => {
    const label = pngBtn.textContent;
    pngBtn.disabled = true;
    pngBtn.textContent = 'Saving…';
    try {
      /* The title and the caption go into the file. On screen they are HTML
         beside the SVG; in a manuscript the figure has to say what it is and
         how much of the record it shows without them. */
      const heading = root.querySelector('.figure-title')?.textContent?.trim();
      const page = standalone(svg, {
        title: heading,
        caption: caption.textContent ?? undefined,
      });
      const blob = await svgToPng(page.markup, page.width, page.height, 3, page.background);
      save(blob, exportName([heading ?? '', 'vs', sel.x.value], 'png'));
    } catch (error) {
      caption.textContent = `The image could not be saved: ${(error as Error).message}`;
    } finally {
      pngBtn.disabled = false;
      pngBtn.textContent = label;
    }
  });

  /* Redraw on a resize, because the width is read from the layout. Debounced
     to a frame: a drag of the window edge fires this continuously. */
  let pending = 0;
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(draw);
  });
  observer.observe(root);

  return {
    update(next: Source): void {
      source = next;
      fillAxes();
      draw();
    },
    draw,
    get axes() {
      return { x: sel.x.value, y: sel.y.value, c: sel.c.value };
    },
  };
}

const clock = (v: number): string =>
  Number.isFinite(v) ? new Date(v * 1000).toISOString().replace('T', ' ').slice(0, 19) : '—';

const trim = (v: number): string => {
  if (!Number.isFinite(v)) return '—';
  const size = Math.abs(v);
  if (size !== 0 && (size < 1e-3 || size >= 1e6)) return v.toExponential(3);
  return String(Math.round(v * 1e4) / 1e4);
};

const ordinal = (n: number): string => {
  const suffix = n % 10 === 1 && n % 100 !== 11 ? 'st'
    : n % 10 === 2 && n % 100 !== 12 ? 'nd'
    : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th';
  return `${n}${suffix}`;
};

function clampInt(raw: string, lo: number, hi: number, fallback: number): number {
  const v = Math.round(Number(raw));
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

function clampNum(raw: string, lo: number, hi: number, fallback: number): number {
  const v = Number(raw);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}
