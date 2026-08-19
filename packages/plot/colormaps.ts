/**
 * Color scales for the plot's color axis.
 *
 * Twenty maps in two groups: matplotlib's perceptually uniform set and the
 * classics, and the eleven from [cmocean](https://matplotlib.org/cmocean/),
 * which is the family oceanography actually reads these fields with.
 *
 * Copied verbatim from `packages/slocum/colormaps.ts` in the
 * oceansensing.github.io repository, where the same tables serve the Slocum
 * decoder. Duplicated rather than shared because that package is written to
 * be lifted out whole and this one is a different lift; `check:vendored`
 * reports when the two drift.
 *
 * They are ten-stop samples of the published maps, close enough to be
 * recognizable, not the exact tables. Interpolated in sRGB between stops,
 * which is a real approximation and a small one at this spacing.
 */

/** The matplotlib set and the classics. */
export const STANDARD: Record<string, readonly string[]> = {
  'viridis': ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'],
  'plasma': ['#0d0887', '#46039f', '#7201a8', '#9c179e', '#bd3786', '#d8576b', '#ed7953', '#fb9f3a', '#fdca26', '#f0f921'],
  'inferno': ['#000004', '#1b0c41', '#4a0c6b', '#781c6d', '#a52c60', '#cf4446', '#ed6925', '#fb9b06', '#f7d13d', '#fcffa4'],
  'magma': ['#000004', '#180f3d', '#440f76', '#721f81', '#9e2f7f', '#cd4071', '#f1605d', '#fd9668', '#feca8d', '#fcfdbf'],
  'cividis': ['#00224e', '#123570', '#3b496c', '#575d6d', '#707173', '#8a8678', '#a59c74', '#c3b369', '#e1cc55', '#fee838'],
  'turbo': ['#30123b', '#4145ab', '#4675ed', '#39a2fc', '#1bcfd4', '#62fc6b', '#d1e935', '#fe9b2d', '#db3a07', '#7a0403'],
  'jet': ['#00007f', '#0000ff', '#007fff', '#00ffff', '#7fff7f', '#ffff00', '#ff7f00', '#ff0000', '#bf0000', '#7f0000'],
  'hsv': ['#ff0000', '#ffa500', '#ffff00', '#00ff00', '#00ff7f', '#00ffff', '#007fff', '#0000ff', '#7f00ff', '#ff00ff'],
  'gray': ['#000000', '#1c1c1c', '#383838', '#555555', '#717171', '#8d8d8d', '#aaaaaa', '#c6c6c6', '#e2e2e2', '#ffffff'],
};

/** cmocean, the family built for oceanographic fields. */
export const CMOCEAN: Record<string, readonly string[]> = {
  'cmo.algae': ['#d7f9d0', '#a9e0a4', '#7dc67c', '#54ab5c', '#308f45', '#187336', '#12572c', '#153b23', '#152118', '#0b0b06'],
  'cmo.balance': ['#181c43', '#1f4a8c', '#3d8fb8', '#95c6d6', '#e3e3e3', '#e5bda9', '#d68b74', '#b95448', '#8b2225', '#3f0d12'],
  'cmo.curl': ['#151d44', '#1f5c73', '#4a9d7f', '#a5cf9a', '#f1f1e4', '#e9bfa2', '#d38578', '#a94f66', '#6d2c55', '#2d1237'],
  'cmo.deep': ['#fdfecc', '#c9e9b1', '#93d3a4', '#63bba4', '#4aa1a2', '#42869c', '#3f6a92', '#42507f', '#3c3760', '#2b1e3b'],
  'cmo.dense': ['#e6f1f1', '#b8dbe0', '#8ec3d6', '#7aa5cc', '#7885bd', '#7b64a5', '#743f83', '#61215d', '#43103a', '#21071c'],
  'cmo.haline': ['#2a186c', '#20358f', '#136a92', '#2c8b83', '#4faa6f', '#82c65b', '#bcdc4d', '#e6e64f', '#f6f069', '#fdf78a'],
  'cmo.ice': ['#040613', '#1b1f3d', '#2b3c68', '#33608c', '#3985a6', '#4faabb', '#79c8cc', '#aadfdc', '#d5efee', '#eafcfd'],
  'cmo.matter': ['#fdedb0', '#fbcf93', '#f6b183', '#ee927c', '#df747c', '#c85c81', '#a94b83', '#873c7f', '#622f70', '#3d2352'],
  'cmo.speed': ['#fffdcd', '#e4e0a8', '#c7c485', '#a8a866', '#888d4d', '#67723d', '#465c36', '#2b452e', '#1b2d21', '#111a12'],
  'cmo.thermal': ['#042333', '#20336b', '#4c3f8a', '#79458c', '#a54f81', '#cb6067', '#e57f48', '#f2a72f', '#f2d338', '#e8fa5b'],
  'cmo.turbid': ['#e9f6ab', '#d3dc8e', '#bec378', '#a9aa66', '#949257', '#7d7a4b', '#666341', '#4e4c36', '#36362a', '#1e211c'],
};

export const COLORMAPS: Record<string, readonly string[]> = { ...STANDARD, ...CMOCEAN };

/** What the color axis opens on: perceptually uniform, and the default everywhere. */
export const DEFAULT_COLORMAP = 'viridis';

/**
 * A scale that has been renamed, and what it is called now.
 *
 * `grey` became `gray` when the interface went to American spelling. That is
 * the same scale under a different key, which is not the same thing as a
 * scale that no longer exists — and the two are indistinguishable to a
 * restore that simply drops a name it cannot find. Without this, a reader
 * who had pinned it would come back to the default with nothing on screen to
 * say a substitution had been made.
 *
 * A stored name is the one part of a rename that cannot be swept, because
 * the copies are in readers' browsers.
 */
const RENAMED: Record<string, string> = { grey: 'gray' };

/**
 * The current name for a stored one, or `null` if there is no such scale.
 *
 * Every path that reads a scale name the reader did not just pick — a saved
 * view, a pasted link, a hand-edited profile — goes through this rather than
 * indexing `COLORMAPS` directly.
 */
export function knownColormap(stored: unknown): string | null {
  if (typeof stored !== 'string') return null;
  const name = RENAMED[stored] ?? stored;
  return COLORMAPS[name] ? name : null;
}

/**
 * A color along a scale, `t` from 0 to 1.
 *
 * Out-of-range `t` clamps rather than wrapping, so a value at or past a
 * pinned limit takes the end color instead of reappearing at the other end
 * of the scale — which would read as data rather than as saturation.
 */
export function sample(name: string, t: number): string {
  const stops = COLORMAPS[knownColormap(name) ?? DEFAULT_COLORMAP];
  const u = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(u));
  const f = u - i;
  const a = hex(stops[i]);
  const b = hex(stops[i + 1]);
  const mix = (k: number) => Math.round(a[k] + (b[k] - a[k]) * f);
  return `rgb(${mix(0)} ${mix(1)} ${mix(2)})`;
}

function hex(value: string): [number, number, number] {
  const n = parseInt(value.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
