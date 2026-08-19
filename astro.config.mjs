// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  site: 'https://oceansensing.org',

  /* A project page under the org's domain, so everything is served from a
     subdirectory. Nothing here may write a root-absolute internal URL by
     hand: `import.meta.env.BASE_URL` is the only correct prefix, and
     `test:pages` reads the built HTML for links that forgot it. The two that
     are easy to miss are not links at all — the SAAR atlas fetch and the
     worker's own URL. */
  base: '/gliders',

  /* **The CSS minifier is esbuild's, because Vite's default one removes a
     prefix iOS still needs.** `cssMinify: true` resolves to Lightning CSS,
     which drops `-webkit-user-select` wherever its compatibility data says
     the unprefixed property is supported — and on iOS it is not, so the
     declaration Safari understands is the one that gets stripped. Leaflet
     carries that prefix, and this site has a Leaflet map on two of its three
     pages. Written up in full in the sibling repository's config; kept here
     because the same map ships here. */
  vite: { build: { cssMinify: 'esbuild' } },

  /* A Content Security Policy as a `<meta>` element, because GitHub Pages
     serves headers nobody here controls.
   *
   * The point is `script-src` without `unsafe-inline`. Every page takes
   * input from somewhere else and puts it on screen: dataset titles,
   * institutions and summaries written by whoever published them to the
   * IOOS Glider DAC, and sensor names out of files a reader drops in. All
   * of it is built as DOM rather than markup, so none of it can inject
   * anything today — this is what still holds if a later edit adds a sink.
   *
   * Three directives are deliberately wide:
   *
   *   - `connect-src 'self' https:` — the ERDDAP client takes a server
   *     base URL. It defaults to gliders.ioos.us, but the whole design is
   *     that another ERDDAP can be named, so there is nothing narrower to
   *     write.
   *   - `img-src 'self' data: blob: https:` — basemap tiles, plus `data:`
   *     for the PNG export's round trip through a canvas.
   *   - `style-src-attr 'unsafe-inline'` — Leaflet positions every pane and
   *     marker with a `style` attribute. Scoped to attributes alone, so
   *     `style-src-elem` keeps its hashes and a stylesheet still cannot be
   *     injected.
   *
   * `worker-src 'self'` is what lets the derived-property worker start.
   * Without it the page loads, the plots draw, and every derived variable
   * silently stays empty — which is why `test:pages` asserts it survived
   * the build. */
  security: {
    csp: {
      directives: [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "form-action 'self'",
        "img-src 'self' data: blob: https:",
        // `data:` because @fontsource inlines its small woff2 subsets as
        // data URIs. Without it every page loads in the fallback face.
        "font-src 'self' data:",
        "connect-src 'self' https:",
        "worker-src 'self' blob:",
      ],
      styleDirective: {
        resources: [{ resource: "'unsafe-inline'", kind: 'attribute' }],
      },
    },
  },
});
