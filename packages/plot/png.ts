/**
 * Rasterising a plot for export.
 *
 * Lifted from `SlocumDecoder.astro`, unchanged in substance.
 */

/**
 * Rasterise a standalone SVG and hand it back as a PNG blob.
 *
 * Drawn at `scale`, so the type and the linework are redrawn at that size
 * rather than an enlargement of the on-screen pixels — which is what makes a
 * 2× export worth having over a screenshot.
 *
 * **The background is painted first**, because it is a CSS property of the
 * element and not part of the SVG's own content: a serialized clone has
 * none, and the PNG would come out transparent — which looks black in most
 * viewers and white in others, neither being the plot.
 */
export function svgToPng(
  markup: string,
  width: number,
  height: number,
  scale: number,
  background: string,
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
    }, 10_000);

    image.onload = () => {
      clearTimeout(timer);
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
    };
    image.onerror = () => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      reject(new Error('the plot could not be rasterised'));
    };
    image.src = url;
  });
}

/**
 * An SVG element as a standalone document.
 *
 * The on-screen SVG inherits its type and its structural colors from the
 * page's stylesheet, and a serialized clone carries none of that — so the
 * rules the plot depends on are written into the clone as a `<style>` of its
 * own. Colors are resolved from the live element rather than named, so an
 * export matches the theme the reader is looking at.
 */
export function standalone(svg: SVGSVGElement, css: string): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = css;
  clone.insertBefore(style, clone.firstChild);
  return new XMLSerializer().serializeToString(clone);
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
