/**
 * Turning a figure into a file somebody can put in a paper.
 *
 * Three things separate that from a screenshot, and all three are here:
 *
 * **Resolution.** Drawn at `scale`, so the type and the linework are redrawn
 * at that size rather than enlarged from the on-screen pixels. The default is
 * 3×, which puts a 1240-point section at 3720 px — a full-width journal
 * figure at 300 dpi with room to spare.
 *
 * **It stands on its own.** The title and the caption are drawn into the
 * image. On screen they are HTML beside the SVG; in a file they have to be
 * part of it, or a figure arrives in a manuscript with nothing saying what it
 * is or how much of the record it shows.
 *
 * **It is on white.** A figure for print is on white with dark ink whatever
 * the reader's screen is set to, so the export uses the light palette even in
 * dark mode rather than handing over a page-black rectangle.
 *
 * The fonts are the generic families rather than the site's. An SVG
 * rasterised through a blob URL is its own document and cannot reach the
 * page's `@font-face` rules, so naming Inter there would silently fall back
 * anyway — this names the fallback deliberately instead of pretending.
 */

/** Ink for an exported figure: the light palette, whatever the screen shows. */
export const PRINT = {
  bg: '#ffffff',
  text: '#16181d',
  muted: '#3d4350',
  line: '#8a8f99',
  accent: '#0a5c8c',
} as const;

const NS = 'http://www.w3.org/2000/svg';

export interface StandaloneOptions {
  /** Drawn above the figure. */
  title?: string;
  /** Drawn below it — what the picture is and is not. */
  caption?: string;
  /** Extra rules for the figure's own linework. */
  css?: string;
  background?: string;
  /** Margin around everything, in figure units. */
  padding?: number;
}

export interface Standalone {
  markup: string;
  width: number;
  height: number;
  background: string;
}

/**
 * An SVG element as a self-contained document, with its title and caption.
 *
 * The figure is nested rather than copied out, so its own coordinates are
 * untouched and nothing has to be re-projected to make room for the text.
 */
export function standalone(svg: SVGSVGElement, options: StandaloneOptions = {}): Standalone {
  const w = svg.viewBox.baseVal.width || svg.clientWidth;
  const h = svg.viewBox.baseVal.height || svg.clientHeight;
  const pad = options.padding ?? 18;
  const background = options.background ?? PRINT.bg;

  const titleH = options.title ? 30 : 0;
  const captionH = options.caption ? 22 : 0;
  const width = w + pad * 2;
  const height = h + titleH + captionH + pad * 2;

  const doc = svg.ownerDocument;
  const out = doc.createElementNS(NS, 'svg');
  out.setAttribute('xmlns', NS);
  out.setAttribute('width', String(width));
  out.setAttribute('height', String(height));
  out.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const style = doc.createElementNS(NS, 'style');
  style.textContent = `${baseCss()}${options.css ?? ''}`;
  out.append(style);

  const bg = doc.createElementNS(NS, 'rect');
  bg.setAttribute('width', String(width));
  bg.setAttribute('height', String(height));
  bg.setAttribute('fill', background);
  out.append(bg);

  if (options.title) {
    const t = doc.createElementNS(NS, 'text');
    t.setAttribute('class', 'export-title');
    t.setAttribute('x', String(pad));
    t.setAttribute('y', String(pad + 18));
    t.textContent = options.title;
    out.append(t);
  }

  /* Nested, not flattened: the figure keeps its own coordinate system and
     the text around it is positioned in the page's. */
  const inner = svg.cloneNode(true) as SVGSVGElement;
  inner.setAttribute('x', String(pad));
  inner.setAttribute('y', String(pad + titleH));
  inner.setAttribute('width', String(w));
  inner.setAttribute('height', String(h));
  inner.setAttribute('viewBox', `0 0 ${w} ${h}`);
  /* The hover ring is a pointer artefact, not part of the figure. */
  for (const ring of inner.querySelectorAll('.ring, .select-band')) ring.remove();
  out.append(inner);

  if (options.caption) {
    const c = doc.createElementNS(NS, 'text');
    c.setAttribute('class', 'export-caption');
    c.setAttribute('x', String(pad));
    c.setAttribute('y', String(pad + titleH + h + 15));
    c.textContent = options.caption;
    out.append(c);
  }

  return {
    markup: new XMLSerializer().serializeToString(out),
    width,
    height,
    background,
  };
}

/** The figure's own linework, in print ink. */
function baseCss(): string {
  return `
    .export-title { fill: ${PRINT.text}; font: 600 17px system-ui, sans-serif; }
    .export-caption { fill: ${PRINT.muted}; font: 12px ui-monospace, monospace; }
    .axis { fill: none; stroke: ${PRINT.line}; stroke-width: 1; }
    .trace { fill: none; stroke: ${PRINT.accent}; stroke-width: 1.5; }
    .tick { fill: ${PRINT.muted}; font: 11px ui-monospace, monospace; }
    .axis-name { fill: ${PRINT.text}; font: 12px ui-monospace, monospace; }
    .color-frame { fill: none; stroke: ${PRINT.line}; }
    .isopycnal { fill: none; stroke: ${PRINT.muted}; stroke-width: 0.7; opacity: 0.6; }
    .isopycnal-label { fill: ${PRINT.muted}; font: 10px ui-monospace, monospace; }
  `;
}

/**
 * Rasterise a standalone SVG and hand it back as a PNG blob.
 *
 * **The background is painted first**, because it is a property of the
 * document rather than of the SVG's own content: without it the PNG comes out
 * transparent, which looks black in most viewers and white in others, neither
 * being the figure.
 */
export function svgToPng(
  markup: string,
  width: number,
  height: number,
  scale = 3,
  background: string = PRINT.bg,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
    const image = new Image();
    // A blob of our own making cannot taint the canvas, but a browser that
    // refuses the load without firing either handler would leave this
    // pending forever and the button stuck on "Saving…".
    const timer = setTimeout(() => {
      URL.revokeObjectURL(url);
      reject(new Error('timed out'));
    }, 15_000);

    image.onload = () => {
      clearTimeout(timer);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('the canvas produced nothing'))),
          'image/png',
        );
      } catch (error) {
        URL.revokeObjectURL(url);
        reject(error as Error);
      }
    };
    image.onerror = () => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      reject(new Error('the figure could not be rasterised'));
    };
    image.src = url;
  });
}

/** Hand a blob to the reader as a download. */
export function save(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  /* Revoked on a timer rather than immediately: Safari has not started the
     download by the time `click()` returns, and revoking synchronously
     cancels it. */
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A filename that says what the figure is, without spaces or punctuation
    that a shell or a filesystem would rather not see. */
export function exportName(parts: readonly string[], extension: string): string {
  const stem = parts
    .filter(Boolean)
    .join('-')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  return `${stem || 'figure'}.${extension}`;
}
