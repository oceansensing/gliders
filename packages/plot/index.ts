/**
 * @c4po/plot — a small SVG scatter/line plot with a color axis.
 *
 * Renderer-complete and framework-free: it takes typed arrays and an SVG
 * element and draws. It knows nothing about seawater, ERDDAP, or where the
 * numbers came from — the T–S diagram's density contours reach it through
 * the `underlay` hook, as line segments in data coordinates.
 *
 * Extracted from the Slocum decoder on oceansensing.org; see `plot.ts` for
 * what changed and why.
 */

export {
  plot, tick, stamp, DEFAULT_STEPS, DEFAULT_MAX_POINTS,
} from './plot.ts';
export type {
  Frame, Placed, PlotOptions, PlotResult, PlotStyle, Series,
} from './plot.ts';

export {
  COLORMAPS, STANDARD, CMOCEAN, DEFAULT_COLORMAP, sample, knownColormap,
} from './colormaps.ts';

export { svgToPng, standalone, save, exportName, PRINT } from './png.ts';
export type { Standalone, StandaloneOptions } from './png.ts';

export { robustRange, ROBUST_LOW, ROBUST_HIGH } from './robust.ts';
