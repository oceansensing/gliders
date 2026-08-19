/**
 * The legend under a track map: what the colours mean, what scale they use,
 * and what range they span.
 *
 * Extracted from the deployment page so the local-files page can have the
 * same thing rather than a second copy of it. The two pages differ only in
 * where their columns come from — a DAC dataset names its own time, position
 * and depth columns; a decoded Slocum table always uses `time`, `latitude`,
 * `longitude`, `depth` — so that difference is a parameter and everything
 * else is shared.
 *
 * Markup is `TrackFigure.astro`; this is what happens when a reader touches
 * it.
 */

import { COLORMAPS, exportName, sample, save } from '@c4po/plot';
import type { Source } from './figure.ts';
import type { Track } from './track.ts';
import { exportMap } from './map-export.ts';

/** Which columns hold the track's own axes. */
export interface TrackAxes {
  timeVar: string;
  latVar: string;
  lonVar: string;
  depthVar?: string;
}

export interface TrackLegendOptions {
  /** The map to recolour. Read lazily: it is built after the page is. */
  track: () => Track | null;
  /** The columns currently loaded, or null before anything is. */
  source: () => Source | null;
  axes: () => TrackAxes | null;
  /** Called after a reader-driven change, for saving to the query string. */
  onChange?: () => void;
  /** What the exported PNG is called and titled. */
  title?: () => string;
}

export interface TrackLegend {
  /** Redraw the track and the legend from whatever is loaded now. */
  paint(): void;
  /** The variable being coloured by, for the query string. */
  readonly variable: string;
  /** The chosen scale, or null while it is still following the variable. */
  readonly colormap: string | null;
  /** The explicit range, as the reader typed it, or null. */
  readonly range: [string, string] | null;
  /** Apply a link's choices. Held until the menus exist to receive them. */
  restore(opts: { variable?: string | null; colormap?: string | null; range?: string | null }): void;
}

export function makeTrackLegend(
  root: ParentNode,
  options: TrackLegendOptions,
): TrackLegend {
  const at = <T extends Element>(sel: string): T => root.querySelector<T>(sel)!;
  const note = at<HTMLElement>('[data-track-note]');
  const colour = at<HTMLSelectElement>('[data-track-colour]');
  const scale = at<HTMLSelectElement>('[data-track-map]');
  const ramp = at<HTMLElement>('[data-track-ramp]');
  const lo = at<HTMLInputElement>('[data-track-lo]');
  const hi = at<HTMLInputElement>('[data-track-hi]');
  const auto = at<HTMLButtonElement>('[data-track-auto]');
  const png = at<HTMLButtonElement>('[data-track-png]');

  let colourKey = '';
  let scaleTouched = false;
  /** Choices a link asked for, held until there is a menu to apply them to:
      assigning a value to an empty `<select>` does nothing at all, which is
      how the first version silently dropped them. */
  let wantedColour: string | null = null;
  let wantedScale: string | null = null;

  function paint(): void {
    const map = options.track();
    const src = options.source();
    const axes = options.axes();
    if (!map || !src || !axes) return;

    const lat = src.columns.get(axes.latVar);
    const lon = src.columns.get(axes.lonVar);
    const time = src.columns.get(axes.timeVar);
    if (!lat || !lon || !time) return;

    fillScales();
    fillColours(src, axes);

    const name = colour.value;
    const values = name && name !== axes.timeVar ? src.columns.get(name) : undefined;
    const meta = src.variables.find((v) => v.name === name);

    /* The scale follows the variable until the reader picks one, then stays
       put — the same rule the figures keep, tracked by a flag rather than by
       comparing against a default, so choosing viridis deliberately is not
       mistaken for not having chosen. */
    if (!scaleTouched) {
      scale.value = meta?.colormap ?? (name === axes.timeVar ? 'cmo.thermal' : 'viridis');
    }
    paintRamp();

    const isTime = !values;
    retype(isTime);
    const from = read(lo, isTime);
    const to = read(hi, isTime);

    map.update({
      lon, lat, time, n: src.rows,
      colour: values
        ? {
            values,
            colormap: scale.value,
            floor: meta?.floor,
            depth: axes.depthVar ? src.columns.get(axes.depthVar) : undefined,
          }
        : undefined,
      colormap: scale.value,
      range: from !== null && to !== null ? { lo: from, hi: to } : undefined,
    });

    /* The readout says what the colours actually span and the placeholders
       say what the data does, so a reader can see whether they have narrowed
       it and what they narrowed it from. */
    const data = map.dataRange;
    if (data) {
      lo.placeholder = isTime ? stamp(data.lo) : trim(data.lo);
      hi.placeholder = isTime ? stamp(data.hi) : trim(data.hi);
    }
    const shown = map.range;
    if (!shown) { note.textContent = ''; last = null; return; }
    const narrowed = data && (shown.lo !== data.lo || shown.hi !== data.hi);
    const text = values && meta
      ? `${trim(shown.lo)} – ${trim(shown.hi)}${meta.units ? ` ${meta.units}` : ''}`
      : `${day(shown.lo)} → ${day(shown.hi)}`;
    note.textContent = narrowed ? `${text} (set)` : text;
    last = {
      label: meta && values
        ? `${meta.label}${meta.units ? ` (${meta.units})` : ''}`
        : 'Time',
      lo: values ? trim(shown.lo) : day(shown.lo),
      hi: values ? trim(shown.hi) : day(shown.hi),
      colormap: scale.value,
    };
  }

  /** The legend as the export needs it: what the colours are of, and what
      the two ends mean. */
  let last: { label: string; lo: string; hi: string; colormap: string } | null = null;

  /** The colour menu, from what this deployment actually carries. */
  function fillColours(src: Source, axes: TrackAxes): void {
    const options_ = src.variables.filter(
      (v) => (v.name === axes.timeVar || v.section) && hasAny(src, v.name),
    );
    const key = options_.map((v) => v.name).join(',');
    if (key === colourKey) return;
    colourKey = key;

    const keep = colour.value || wantedColour || '';
    colour.replaceChildren();
    for (const v of options_) {
      const opt = document.createElement('option');
      opt.value = v.name;
      opt.textContent = v.units ? `${v.label} (${v.units})` : v.label;
      colour.append(opt);
    }
    colour.value = options_.some((v) => v.name === keep) ? keep : axes.timeVar;
    /* Honoured once; after that the reader's own choice is what `keep`
       carries, and a stale link must not keep overriding it. */
    if (colour.value === wantedColour) wantedColour = null;
  }

  /** The scale menu, filled once — a fixed list, not something data decides. */
  function fillScales(): void {
    if (scale.options.length) return;
    for (const name of Object.keys(COLORMAPS)) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      scale.append(opt);
    }
    if (wantedScale) {
      scale.value = wantedScale;
      scaleTouched = true;
      wantedScale = null;
    }
  }

  function paintRamp(): void {
    const stops = 20;
    ramp.replaceChildren();
    for (let i = 0; i < stops; i++) {
      const cell = document.createElement('span');
      cell.style.background = sample(scale.value, (i + 0.5) / stops);
      ramp.append(cell);
    }
  }

  /** A range box is a clock on a time axis and a number otherwise — an epoch
      is not something anyone types. Switching wipes the value, because the
      old one means nothing on the new axis. */
  function retype(isTime: boolean): void {
    const want = isTime ? 'datetime-local' : 'number';
    for (const box of [lo, hi]) {
      if (box.type !== want) {
        box.type = want;
        box.value = '';
      }
    }
  }

  colour.addEventListener('change', () => {
    /* A new variable brings its own conventional scale back, and its own
       range always — limits set for temperature mean nothing on salinity. */
    scaleTouched = false;
    lo.value = '';
    hi.value = '';
    paint();
    options.onChange?.();
  });

  scale.addEventListener('change', () => {
    scaleTouched = true;
    paint();
    options.onChange?.();
  });

  for (const box of [lo, hi]) {
    box.addEventListener('input', () => {
      paint();
      options.onChange?.();
    });
  }

  auto.addEventListener('click', () => {
    lo.value = '';
    hi.value = '';
    paint();
    options.onChange?.();
  });

  png.addEventListener('click', async () => {
    const map = options.track();
    const container = root.querySelector<HTMLElement>('[data-map]');
    if (!map || !container) return;
    const label = png.textContent;
    png.disabled = true;
    png.textContent = 'Saving…';
    try {
      const title = options.title?.() ?? 'Glider track';
      const blob = await exportMap(container, map, {
        title,
        caption: `Track coloured by ${last?.label ?? 'time'}${
          last ? `, ${last.lo} to ${last.hi}` : ''}.`,
        legend: last ?? undefined,
      });
      save(blob, exportName([title, 'track'], 'png'));
    } catch (error) {
      /* Said in the legend's own readout, which is the nearest thing this
         figure has to a caption — a silent failure on a button that takes a
         second to answer reads as a broken button. */
      note.textContent = (error as Error).message;
    } finally {
      png.disabled = false;
      png.textContent = label;
    }
  });

  return {
    paint,
    get variable() { return colour.value; },
    get colormap() { return scaleTouched ? scale.value : null; },
    get range() {
      return lo.value && hi.value ? [lo.value, hi.value] as [string, string] : null;
    },
    restore({ variable, colormap, range }) {
      if (variable) wantedColour = variable;
      if (colormap && colormap in COLORMAPS) wantedScale = colormap;
      if (range && !lo.value && !hi.value) {
        const [a, b] = range.split(',');
        if (a && b) { lo.value = a; hi.value = b; }
      }
    },
  };
}

/** A range box's value, or null when empty or unreadable. A `datetime-local`
    carries no zone; every clock on this site is UTC, so it is read as UTC. */
const read = (box: HTMLInputElement, isTime: boolean): number | null => {
  const raw = box.value.trim();
  if (!raw) return null;
  const v = isTime ? Date.parse(`${raw}Z`) / 1000 : Number(raw);
  return Number.isFinite(v) ? v : null;
};

const hasAny = (src: Source, name: string): boolean => {
  const col = src.columns.get(name);
  if (!col) return false;
  for (let i = 0; i < col.length; i++) if (col[i] === col[i]) return true;
  return false;
};

const trim = (v: number): string => {
  if (!Number.isFinite(v)) return '—';
  const size = Math.abs(v);
  if (size !== 0 && (size < 1e-3 || size >= 1e6)) return v.toExponential(2);
  return String(Math.round(v * 100) / 100);
};

const day = (t: number): string =>
  Number.isFinite(t) ? new Date(t * 1000).toISOString().slice(0, 10) : '—';

const stamp = (t: number): string =>
  Number.isFinite(t) ? new Date(t * 1000).toISOString().slice(0, 16) : '';
