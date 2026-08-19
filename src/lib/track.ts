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
import { sample } from '@c4po/plot';

export interface TrackOptions {
  /** Colormap for the time axis. */
  map?: string;
  /** How many coloured segments to draw. */
  segments?: number;
}

export interface Track {
  /** Redraw from new columns. */
  update(lon: Float64Array, lat: Float64Array, time: Float64Array, n: number): void;
  /** The Leaflet map, for callers that want to add to it. */
  readonly map: L.Map;
  /** Fit the view to the whole track. */
  fit(): void;
}

const TILES =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}';

export function makeTrack(element: HTMLElement, options: TrackOptions = {}): Track {
  /* `fadeAnimation: false` because the fade buys nothing on a data map and
     costs a real failure: Leaflet drives it from `requestAnimationFrame`,
     which a background tab does not run, so tiles that have fully downloaded
     sit at `opacity: 0` until the tab is focused. Observed directly — nine
     tiles complete, nine tiles transparent, a working map that could not be
     seen. They appear as they arrive now. */
  const map = L.map(element, { worldCopyJump: true, fadeAnimation: false })
    .setView([30, -60], 3);
  L.tileLayer(TILES, {
    maxZoom: 13,
    attribution: 'Esri — GEBCO, NOAA, National Geographic',
  }).addTo(map);

  const lines = L.layerGroup().addTo(map);
  const ends = L.layerGroup().addTo(map);
  let bounds: L.LatLngBounds | null = null;

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

  function update(
    lon: Float64Array, lat: Float64Array, time: Float64Array, n: number,
  ): void {
    lines.clearLayers();
    ends.clearLayers();
    bounds = null;

    /* One position per profile, not per sample: every point in a dive shares
       a position on the DAC's `latitude`/`longitude`, so drawing all of them
       is thousands of coincident vertices. Deduplicated by value, which also
       drops the surface drift repeats. */
    const points: Array<{ lat: number; lon: number; t: number }> = [];
    let lastLat = NaN;
    let lastLon = NaN;
    for (let i = 0; i < n; i++) {
      const a = lat[i];
      const o = lon[i];
      if (!Number.isFinite(a) || !Number.isFinite(o)) continue;
      if (a === lastLat && o === lastLon) continue;
      lastLat = a;
      lastLon = o;
      points.push({ lat: a, lon: o, t: time[i] });
    }
    if (points.length < 2) return;

    points.sort((p, q) => p.t - q.t);

    const t0 = points[0].t;
    const t1 = points[points.length - 1].t;
    const span = t1 > t0 ? t1 - t0 : 1;
    const want = Math.max(2, Math.min(options.segments ?? 240, points.length - 1));
    const stride = Math.max(1, Math.floor((points.length - 1) / want));
    const cmap = options.map ?? 'cmo.thermal';

    const all: L.LatLngExpression[] = [];
    for (let i = 0; i + stride < points.length; i += stride) {
      const a = points[i];
      const b = points[Math.min(i + stride, points.length - 1)];
      const seg: L.LatLngExpression[] = [];
      for (let k = i; k <= Math.min(i + stride, points.length - 1); k++) {
        seg.push([points[k].lat, points[k].lon]);
      }
      all.push(...seg);
      L.polyline(seg, {
        color: sample(cmap, (((a.t + b.t) / 2) - t0) / span),
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
      radius: 6, weight: 2, className: 'track-end',
    }).bindTooltip('last report').addTo(ends);

    bounds = L.latLngBounds(all);
    fit();
  }

  function fit(): void {
    if (bounds && bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24] });
  }

  return { update, map, fit };
}
