/**
 * The map, as a file somebody can put in a paper.
 *
 * A map is not an SVG the way the plots are — it is a pane of `<img>` tiles
 * with vector overlays on top — so it is composited onto a canvas rather than
 * serialised. The tiles are drawn as images; **the track is redrawn from the
 * numbers** rather than rasterised from the screen, so the path is as sharp
 * at 3× as the tiles allow and does not carry the screen's antialiasing.
 *
 * **It only works because the tiles are fetched with CORS.** Drawing an
 * image the browser fetched without it taints the canvas, and a tainted
 * canvas throws on `toBlob` — at the very end, after all the work. The tile
 * layer asks for them anonymously; Esri answers
 * `Access-Control-Allow-Origin: *`.
 *
 * What lands in the file beyond the picture: the title, the colour bar with
 * its range, the attribution Esri's terms require, and a caption. A map that
 * arrives in a manuscript without its scale or its credit is not publishable,
 * and neither is one whose colours mean nothing.
 */

import type L from 'leaflet';
import { PRINT, sample, save } from '@c4po/plot';
import { ATTRIBUTION, type Track } from './track.ts';

export interface MapExportOptions {
  title?: string;
  caption?: string;
  /** The colour bar's label and span; omitted for an unlabelled track. */
  legend?: { label: string; lo: string; hi: string; colormap: string };
  scale?: number;
}

const PAD = 18;
const TITLE_H = 30;
const CAPTION_H = 22;
const BAR_W = 14;

/**
 * The endpoint markers, the same three values as `--map-*` in `tokens.css`.
 *
 * They are repeated here rather than themed because the rest of this file's
 * palette is `PRINT` — the light one, used whatever the screen is set to —
 * and these are not part of that argument at all: the tiles composited under
 * them are the same tiles either way, so the marker that reads on screen is
 * the marker that reads in the file. `test:contrast` asserts the two copies
 * still say the same thing.
 */
const MARK = {
  here: '#8f0b22',
  past: '#243447',
  ring: '#ffffff',
} as const;

/**
 * Compose the map into a PNG and hand it to the reader.
 *
 * Throws with something sayable if the tiles cannot be read, which is the one
 * failure a reader can act on — it means the basemap did not finish loading.
 */
export async function exportMap(
  container: HTMLElement,
  track: Track,
  options: MapExportOptions = {},
): Promise<Blob> {
  const scale = options.scale ?? 3;
  const rect = container.getBoundingClientRect();
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  if (!(w > 0 && h > 0)) throw new Error('the map has no size yet');

  const titleH = options.title ? TITLE_H : 0;
  const captionH = options.caption ? CAPTION_H : 0;
  const width = w + PAD * 2;
  const height = h + titleH + captionH + PAD * 2;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('this browser gave no drawing context');
  ctx.scale(scale, scale);

  ctx.fillStyle = PRINT.bg;
  ctx.fillRect(0, 0, width, height);

  const originX = PAD;
  const originY = PAD + titleH;

  if (options.title) {
    ctx.fillStyle = PRINT.text;
    ctx.font = '600 17px system-ui, sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(options.title, PAD, PAD + 18);
  }

  /* The map's own pixels, clipped to the frame so a tile that hangs over the
     container's edge — they always do, the pane is larger than the view —
     does not spill across the page. */
  ctx.save();
  ctx.beginPath();
  ctx.rect(originX, originY, w, h);
  ctx.clip();

  ctx.fillStyle = '#dfe7ee';
  ctx.fillRect(originX, originY, w, h);

  let drawn = 0;
  for (const tile of container.querySelectorAll<HTMLImageElement>('.leaflet-tile')) {
    if (!tile.complete || tile.naturalWidth === 0) continue;
    const t = tile.getBoundingClientRect();
    try {
      ctx.drawImage(
        tile,
        originX + (t.left - rect.left),
        originY + (t.top - rect.top),
        t.width,
        t.height,
      );
      drawn++;
    } catch {
      /* A tainted tile. Counted as not drawn, and reported below rather than
         silently producing a blank map. */
    }
  }
  if (drawn === 0) throw new Error('no basemap tiles were ready — let the map finish loading');

  /* The track, redrawn from its own coordinates. Sharper than rasterising
     the overlay, and it picks up none of the screen's antialiasing. */
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const segment of track.segments) {
    if (segment.points.length < 2) continue;
    ctx.strokeStyle = segment.colour ?? PRINT.muted;
    ctx.globalAlpha = segment.colour ? 0.95 : 0.35;
    ctx.beginPath();
    segment.points.forEach(([lat, lon], i) => {
      const p = track.map.latLngToContainerPoint([lat, lon] as L.LatLngExpression);
      if (i === 0) ctx.moveTo(originX + p.x, originY + p.y);
      else ctx.lineTo(originX + p.x, originY + p.y);
    });
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const ends = track.ends;
  if (ends) {
    const mark = (at: [number, number], fill: string, stroke: string, r: number): void => {
      const p = track.map.latLngToContainerPoint(at as L.LatLngExpression);
      ctx.beginPath();
      ctx.arc(originX + p.x, originY + p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = stroke;
      ctx.stroke();
    };
    mark(ends.first, MARK.ring, MARK.past, 5);
    mark(ends.last, MARK.here, MARK.ring, 7);
  }

  if (options.legend) drawLegend(ctx, options.legend, originX, originY, w, h);

  /* Esri's terms require the credit, and a figure that leaves it behind on
     the page arrives in a manuscript uncredited. */
  ctx.font = '10px ui-monospace, monospace';
  const credit = `Basemap: ${ATTRIBUTION}`;
  const creditW = ctx.measureText(credit).width;
  ctx.fillStyle = 'rgba(255,255,255,0.82)';
  ctx.fillRect(originX + w - creditW - 10, originY + h - 16, creditW + 8, 14);
  ctx.fillStyle = PRINT.muted;
  ctx.fillText(credit, originX + w - creditW - 6, originY + h - 5);

  ctx.restore();

  /* The frame, drawn after the clip is released so it sits on the edge
     rather than half inside it. */
  ctx.strokeStyle = PRINT.line;
  ctx.lineWidth = 1;
  ctx.strokeRect(originX + 0.5, originY + 0.5, w - 1, h - 1);

  if (options.caption) {
    ctx.fillStyle = PRINT.muted;
    ctx.font = '12px ui-monospace, monospace';
    ctx.fillText(options.caption, PAD, originY + h + 15);
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('the canvas produced nothing'))),
      'image/png',
    );
  });
}

/** The colour bar, so the colours in the file mean something without the
    page around them. */
function drawLegend(
  ctx: CanvasRenderingContext2D,
  legend: NonNullable<MapExportOptions['legend']>,
  originX: number,
  originY: number,
  w: number,
  h: number,
): void {
  const barH = Math.min(160, h * 0.4);
  const x = originX + w - BAR_W - 64;
  const y = originY + 18;

  const steps = 64;
  for (let i = 0; i < steps; i++) {
    ctx.fillStyle = sample(legend.colormap, (i + 0.5) / steps);
    ctx.fillRect(x, y + barH - ((i + 1) / steps) * barH, BAR_W, barH / steps + 0.6);
  }
  ctx.strokeStyle = PRINT.line;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, BAR_W - 1, barH - 1);

  ctx.font = '11px ui-monospace, monospace';
  ctx.fillStyle = PRINT.text;
  ctx.textAlign = 'left';
  ctx.fillText(legend.hi, x + BAR_W + 5, y + 9);
  ctx.fillText(legend.lo, x + BAR_W + 5, y + barH);

  /* The bar says what the colours mean but not what they are *of*, which on
     screen the menu beside it answers and a file has to carry itself. */
  ctx.save();
  ctx.translate(x - 6, y + barH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillText(legend.label, 0, 0);
  ctx.restore();
  ctx.textAlign = 'left';
}

export { save };
