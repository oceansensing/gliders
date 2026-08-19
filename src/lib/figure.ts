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
  plot, standalone, save, svgToPng, COLORMAPS, DEFAULT_COLORMAP, sample,
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
      cRange: [limit(box.cLo, cTime), limit(box.cHi, cTime)],
      xLabel: labelFor(xName),
      yLabel: labelFor(yName),
      cLabel: c ? labelFor(cName) : undefined,
      xTime, yTime, cTime,
      underlay: preset.underlay,
    };

    last = plot(svg, series, options);
    say();
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
    if (last.hidden > 0) bits.push(`${last.hidden.toLocaleString()} outside the window`);
    if (last.uncolored > 0) bits.push(`${last.uncolored.toLocaleString()} with no color value`);
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

  /* The pointer readout. The dots are one path per color bin, so there is no
     element under the pointer to ask — the nearest placed point is found by
     search over what was actually drawn. */
  let ring: SVGCircleElement | null = null;
  svg.addEventListener('pointermove', (event) => {
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
    if (bestD > 400) { hover.textContent = ''; ring?.remove(); ring = null; return; }

    const xName = sel.x.value;
    const yName = sel.y.value;
    const cName = sel.c.value;
    const show = (name: string, v: number): string =>
      `${meta(name)?.label ?? name} ${isTime(name) ? clock(v) : trim(v)}`;
    hover.textContent = [
      show(xName, best.x),
      show(yName, best.y),
      cName && Number.isFinite(best.c) ? show(cName, best.c) : '',
    ].filter(Boolean).join('  ·  ');

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
    hover.textContent = '';
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
      const style = getComputedStyle(root);
      const css = plotCss(style);
      const markup = standalone(svg, css);
      const w = svg.viewBox.baseVal.width;
      const h = svg.viewBox.baseVal.height;
      const blob = await svgToPng(markup, w, h, 2, style.getPropertyValue('--bg') || '#ffffff');
      save(blob, `${sel.y.value}-vs-${sel.x.value}.png`);
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

/** The rules a detached SVG needs to look like the one on screen. Resolved
    from the live element so an export matches the reader's theme. */
function plotCss(style: CSSStyleDeclaration): string {
  const text = style.getPropertyValue('--text').trim() || '#16181d';
  const muted = style.getPropertyValue('--text-muted').trim() || '#555b66';
  const border = style.getPropertyValue('--border').trim() || '#dcdcd4';
  const accent = style.getPropertyValue('--accent').trim() || '#0a5c8c';
  const mono = style.getPropertyValue('--font-mono').trim() || 'monospace';
  return `
    .axis { fill: none; stroke: ${border}; stroke-width: 1; }
    .trace { fill: none; stroke: ${accent}; stroke-width: 1.5; }
    .tick { fill: ${muted}; font: 10px ${mono}; }
    .axis-name { fill: ${text}; font: 11px ${mono}; }
    .color-frame { fill: none; stroke: ${border}; }
    .ring { display: none; }
  `;
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
