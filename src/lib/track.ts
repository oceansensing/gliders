/**
 * The deployment track, on a map.
 *
 * A glider's path is the one figure that is not a plot: where it went is a
 * question about the ocean, not about the water it measured. Drawn as a
 * polyline coloured by time, so a reader can see the order the mission
 * happened in rather than only its shape.
 *
 * Coloured in segments rather than as one line, because SVG and Leaflet both
 * stroke a path in a single colour. The segment count is capped — a thousand
 * polylines is a thousand DOM nodes and the map stops panning smoothly —
 * which is a resolution decision about the *drawing*, not about the data.
 */

import L from 'leaflet';
/* Leaflet's own stylesheet, and it is not cosmetic: it is what gives
   `.leaflet-container` its `position: relative` and `overflow: hidden`.
   Without it the tile pane is not clipped to the container and the tiles
   render across whatever is above them — observed here as a map drawn over
   the page's own title. Imported by the module that builds the map rather
   than by each page that shows one, so a new page cannot forget it. */
import 'leaflet/dist/leaflet.css';
import { robustRange, sample } from '@c4po/plot';

export interface TrackOptions {
  /** Colormap for the time axis. */
  map?: string;
  /** How many coloured segments to draw. */
  segments?: number;
}

/** What the track is coloured by. */
export interface TrackColour {
  /** One value per row, aligned with `lon`/`lat`. */
  values: Float64Array;
  colormap: string;
  /** A value the quantity cannot physically go below, clamping the automatic
      colour limit. See `Plottable.floor`. */
  floor?: number;
  /** Depth, so a profile's *surface* value is the one that reaches the map.
      Without it the first row of each profile is used, which is the same
      thing on a DAC dataset and not on every one. */
  depth?: Float64Array;
}

export interface TrackUpdate {
  lon: Float64Array;
  lat: Float64Array;
  time: Float64Array;
  n: number;
  /** Omit to colour by time. */
  colour?: TrackColour;
  /** The scale, when colouring by time — `colour` carries its own. */
  colormap?: string;
  /**
   * Explicit colour limits. Omit to take them from the data.
   *
   * A window on the colour axis rather than a rescale of what survives it:
   * values outside are drawn at the end colours rather than dropped, because
   * the track is where the glider went and a stretch of water outside the
   * reader's chosen range is not a stretch the glider skipped.
   */
  range?: { lo: number; hi: number };
}

/** One drawn stretch of the path, kept so the export can redraw it on a
    canvas at any scale rather than rasterising the on-screen SVG. */
export interface Segment {
  points: Array<[number, number]>;
  colour: string | null;
}

export interface Track {
  /** Redraw from new columns. */
  update(next: TrackUpdate): void;
  /** The stretches last drawn, in order. */
  readonly segments: readonly Segment[];
  /** Where the track starts and ends, for the export's markers. */
  readonly ends: { first: [number, number]; last: [number, number] } | null;
  /** The range the last draw coloured over, for a legend. */
  readonly range: { lo: number; hi: number } | null;
  /** The range the data itself spans, whatever the draw was told to use —
      what "Auto" goes back to, and what the placeholders show. */
  readonly dataRange: { lo: number; hi: number } | null;
  /** The Leaflet map, for callers that want to add to it. */
  readonly map: L.Map;
  /** Fit the view to the whole track. */
  fit(): void;
}

const TILES =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}';

/** Required by Esri's terms, and drawn into the exported image as well as
    shown on screen — a figure that leaves the credit behind on the page is a
    figure that arrives in a paper uncredited. */
export const ATTRIBUTION = 'Esri — GEBCO, NOAA, National Geographic';

export function makeTrack(element: HTMLElement, options: TrackOptions = {}): Track {
  /* `fadeAnimation: false` because the fade buys nothing on a data map and
     costs a real failure: Leaflet drives it from `requestAnimationFrame`,
     which a background tab does not run, so tiles that have fully downloaded
     sit at `opacity: 0` until the tab is focused. Observed directly — nine
     tiles complete, nine tiles transparent, a working map that could not be
     seen. They appear as they arrive now. */
  const map = L.map(element, { worldCopyJump: true, fadeAnimation: false })
    .setView([30, -60], 3);
  /* **`crossOrigin` is what makes the PNG export possible at all.** Drawing
     an image the browser fetched without CORS onto a canvas taints it, and a
     tainted canvas throws a SecurityError on `toBlob` — so the export would
     fail at the last step, after the work. Esri's tile server answers
     `Access-Control-Allow-Origin: *` (checked), so asking for the tiles
     anonymously costs nothing and keeps the canvas clean. */
  L.tileLayer(TILES, {
    maxZoom: 13,
    crossOrigin: 'anonymous',
    attribution: ATTRIBUTION,
  }).addTo(map);

  const lines = L.layerGroup().addTo(map);
  const ends = L.layerGroup().addTo(map);
  let bounds: L.LatLngBounds | null = null;
  let range: { lo: number; hi: number } | null = null;
  let dataRange: { lo: number; hi: number } | null = null;
  let segments: Segment[] = [];
  let endPoints: { first: [number, number]; last: [number, number] } | null = null;

  /* **Leaflet measures its container once, at construction.** This map is
     built while the page is still assembling — the figures around it have no
     data yet and the grid has not settled — so the size it caught is not the
     size it ends up with, and the result is a container of tiles that were
     never requested: a grey box. `invalidateSize` is what re-measures it.
     *
     * **Guarded on the size actually changing, which is not paranoia.**
     * `invalidateSize` and `fitBounds` both move Leaflet's own elements, and
     * the observer sees that as another resize — so the unguarded version
     * re-entered every frame, and each pass restarted the tile fade before
     * it finished. The tiles downloaded fine and sat at `opacity: 0`
     * forever: a fully working map, invisible. Measured rather than guessed
     * — nine tiles complete, nine tiles transparent. */
  let lastW = 0;
  let lastH = 0;
  const observer = new ResizeObserver((entries) => {
    const rect = entries[0]?.contentRect;
    if (!rect) return;
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w === lastW && h === lastH) return;
    lastW = w;
    lastH = h;
    map.invalidateSize({ animate: false });
    fit();
  });
  observer.observe(element);

  function update(next: TrackUpdate): void {
    const { lon, lat, time, n, colour } = next;
    lines.clearLayers();
    ends.clearLayers();
    bounds = null;
    range = null;
    segments = [];
    endPoints = null;

    /* One position per profile, not per sample: every point in a dive shares
       a position on the DAC's `latitude`/`longitude`, so drawing all of them
       is thousands of coincident vertices. Runs of the same position collapse
       to one point, which also drops the surface drift repeats.
       *
       * **The value carried up with it is the shallowest one in the run.** A
       * track coloured by temperature is asking what the water was like where
       * the glider surfaced, not 900 m under it, and a profile's rows span
       * the whole dive. Taking the first row instead would be right on a DAC
       * dataset, whose rows descend, and wrong the moment one does not. */
    interface Point { lat: number; lon: number; t: number; v: number }
    const points: Point[] = [];
    let lastLat = NaN;
    let lastLon = NaN;
    let bestDepth = Infinity;

    for (let i = 0; i < n; i++) {
      const a = lat[i];
      const o = lon[i];
      if (!Number.isFinite(a) || !Number.isFinite(o)) continue;

      const v = colour ? colour.values[i] : time[i];
      const d = colour?.depth ? colour.depth[i] : 0;

      if (a === lastLat && o === lastLon) {
        /* Same position: keep the shallowest finite value seen in the run. */
        const here = points[points.length - 1];
        if (here && Number.isFinite(v) && d < bestDepth) {
          here.v = v;
          bestDepth = d;
        }
        continue;
      }
      lastLat = a;
      lastLon = o;
      bestDepth = Number.isFinite(v) ? d : Infinity;
      points.push({ lat: a, lon: o, t: time[i], v });
    }
    if (points.length < 2) return;

    points.sort((p, q) => p.t - q.t);

    /* The colour axis: what the reader asked for, or the data's own range.
       *
       * **Percentiles for a variable, the true span for time.** A track
       * coloured by chlorophyll had a minimum of −0.08 µg/L — a negative
       * concentration — which is one sensor artefact setting the scale for
       * the whole mission. A mission's clock has no such outliers, and its
       * first and last profile are exactly what the reader wants the ends of
       * the scale to mean. */
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of points) {
      if (!Number.isFinite(p.v)) continue;
      if (p.v < lo) lo = p.v;
      if (p.v > hi) hi = p.v;
    }
    if (!Number.isFinite(lo) || !(hi > lo)) { lo = 0; hi = 1; }

    if (colour) {
      const values = points.map((p) => p.v);
      const robust = robustRange(values, values.length);
      if (robust) {
        lo = colour.floor !== undefined ? Math.max(robust[0], colour.floor) : robust[0];
        hi = robust[1];
      }
    }
    dataRange = { lo, hi };

    const asked = next.range;
    if (asked && Number.isFinite(asked.lo) && Number.isFinite(asked.hi) && asked.hi > asked.lo) {
      lo = asked.lo;
      hi = asked.hi;
    }
    range = { lo, hi };

    const want = Math.max(2, Math.min(options.segments ?? 240, points.length - 1));
    const stride = Math.max(1, Math.floor((points.length - 1) / want));
    const cmap = colour?.colormap ?? next.colormap ?? options.map ?? 'cmo.thermal';

    const all: L.LatLngExpression[] = [];
    for (let i = 0; i + stride < points.length; i += stride) {
      const a = points[i];
      const b = points[Math.min(i + stride, points.length - 1)];
      const seg: L.LatLngExpression[] = [];
      for (let k = i; k <= Math.min(i + stride, points.length - 1); k++) {
        seg.push([points[k].lat, points[k].lon]);
      }
      all.push(...seg);
      /* A segment whose value is missing is drawn muted rather than dropped:
         the track is where the glider went, and a gap in one sensor is not a
         gap in the path. */
      const mid = [a.v, b.v].filter(Number.isFinite);
      const t = mid.length
        ? Math.min(1, Math.max(0,
            ((mid.reduce((x, y) => x + y, 0) / mid.length) - lo) / (hi - lo)))
        : NaN;
      const colour = Number.isFinite(t) ? sample(cmap, t) : null;
      segments.push({ points: seg as Array<[number, number]>, colour });
      L.polyline(seg, {
        color: colour ?? undefined,
        className: colour ? undefined : 'track-unknown',
        weight: 2.5,
        opacity: 0.95,
      }).addTo(lines);
    }

    const first = points[0];
    const last = points[points.length - 1];
    L.circleMarker([first.lat, first.lon], {
      radius: 5, weight: 2, className: 'track-start',
    }).bindTooltip('deployed').addTo(ends);
    L.circleMarker([last.lat, last.lon], {
      radius: 7, weight: 2.5, className: 'track-end',
    }).bindTooltip('last report').addTo(ends);

    endPoints = { first: [first.lat, first.lon], last: [last.lat, last.lon] };
    bounds = L.latLngBounds(all);
    fit();
  }

  function fit(): void {
    if (bounds && bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24] });
  }

  return {
    update, map, fit,
    get range() { return range; },
    get dataRange() { return dataRange; },
    get segments() { return segments; },
    get ends() { return endPoints; },
  };
}
