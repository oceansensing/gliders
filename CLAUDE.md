# Engineering notes

What this site rests on and why it is shaped the way it is. `README.md` says
what it does; this says what a future edit needs to know first.

Almost everything here was **measured against the live server or a real
browser**, and several of the measurements contradict what the obvious design
would have assumed. Where a number appears, it was taken rather than
estimated.

---

## 1. The shape of the thing

### Two data paths meet at one interface

There are exactly two sources — the IOOS Glider DAC, and files a reader drops
on `/local/` — and everything below the fetch consumes the same thing:

```ts
interface Source {
  columns: Map<string, Float64Array>;
  rows: number;
  variables: Plottable[];
  timeVar: string;
}
```

That is the whole reason one set of figures serves both. `lib/deployment.ts`
takes columns, not an ERDDAP response; `lib/local.ts` turns a decoded Slocum
`Table` into the same shape. **A change that leaks ERDDAP's types into the
render layer breaks the local page silently** — it will still compile, and the
figures will simply stop being reusable.

### Markup and behaviour are separate, and shared

| markup | behaviour | used by |
|---|---|---|
| `PlotFigure.astro` | `lib/figure.ts` | every plot: sections, T–S, both profiles |
| `TrackFigure.astro` | `lib/track-legend.ts` + `lib/track.ts` | the map on both pages |

Three figures differ only by preset. The two pages' maps differ in exactly one
thing — a DAC dataset names its own time/position/depth columns, a decoded
Slocum table always uses `time`/`latitude`/`longitude`/`depth` — so that is a
`TrackAxes` parameter and the rest is shared. When the local page needed the
legend the deployment page had, the choice was a second copy of ~470 lines or
one shared piece; the shared piece removed 463 lines net.

### Pages

| route | what it is |
|---|---|
| `/` | the catalog: a map of real tracks, and a searchable table of 2,534 deployments |
| `/deployment/?dataset=<id>` | one deployment, driven entirely by the query string |
| `/local/` | raw Slocum files, decoded in the tab |

There is no route per deployment: 2,534 datasets and more every week is not a
static site's shape. Reader state — dataset, window, variables, QC, track
colour and scale — lives in the query string, so a view is a link.

---

## 2. Getting the data

### What a request to the DAC costs

Measured on `electa-20260807T1633` — 11 days, 142,378 rows, 2,083 profiles:

| request | bytes | wall |
|---|---|---|
| whole deployment | 11.3 MB | 14.8 s |
| whole deployment, binned to 5 m | 1.6 MB | 15.3 s |
| one day | 0.58 MB | 1.1 s |
| one day, binned | 0.09 MB | 1.2 s |

**Server time scales with the span asked for, not with the rows returned.**
The bin happens *after* the read, about 1.35 s per day of deployment. So the
fetcher chunks by time *and* bins, for different reasons: chunks so something
is on screen in under a second and keeps growing, binning so the network and
parser are never what is waited on.

**The first version sized its windows by row count**, which is the design
anyone would write first and which fails for exactly that reason: fed a binned
request the estimator sees a low row rate, concludes a 30-day window is
affordable, and the reader waits eleven seconds for the back half of an
eleven-day mission.

| planner | first paint | total |
|---|---|---|
| by rows (2 chunks) | 3,197 ms | 14,273 ms |
| by elapsed time (15 chunks) | **925 ms** | **6,100 ms** |

Concurrency is 3 and more does not help: four parallel one-day requests
measured 4.3 s against ~4.4 s of serial time, so the server queues rather than
parallelises.

### The depth bin is the glider's, not a constant

Vertical sampling varies by an order of magnitude across the archive:

| | native | 5 m bin | 1 m bin | full |
|---|---|---|---|---|
| `electa` — 171 m shelf, 11 days | ~2.5 m | 18,673 | 71,968 | 142,376 |
| `ru29` — 961 m deep, 2 months | ~5.3 m | 147,464 | 184,868 | — |

A 5 m bin keeps **nine samples out of sixty-eight** per profile on a shelf
glider, through a thermocline metres thick — the section showed the bin's
structure rather than the ocean's — and takes almost nothing off the deep one.
So the finest bin is tried first and coarsened only if the deployment would
blow the row budget.

**The projection cannot be computed, only measured**: rows do not scale as
1/bin, because below the native spacing a finer bin returns nothing extra —
halving electa's bin gave 44,592 rows, not 93,000. Each candidate gets its own
six-hour probe. A finer bin costs **no server time**; it costs bytes.

After the change: 71,922 rows, first section at 566 ms, complete at 2.9 s.

### A chosen window starts the ladder at full rate

Narrowing is only worth doing if it buys resolution, so `binMetres: 0` puts
"every sample the glider took" on the ladder as its finest rung and the same
budget decides whether it fits. A day of an eleven-day mission is a fortieth
of it, so it does: 12 hours of `electa` is 5,588 rows unbinned in 1.8 s.

The window is **re-fetched, not filtered**. Filtering would leave the reader
looking at the same 1 m overview through a smaller frame, wondering why it had
not sharpened. A window is chosen with the clocks at the top of the page or by
dragging across any section — the gesture a reader already makes at a feature.

### Two API facts that break a client written from the documentation

- **An empty result is an HTTP 404**, and its error responses carry **no CORS
  header** — so in a browser a gap in a deployment arrives as an unreadable
  network error, and `ErddapError.empty` only ever fires under Node. An
  unreadable window counts as a gap; only *every* window failing with nothing
  to show is reported as an outage.
- **`allDatasets` takes no paging parameters.** `page`/`itemsPerPage` belong to
  the HTML form and are a 400 here. It also carries a row for itself, which is
  dropped.

More in `packages/erddap/CLAUDE.md`.

---

## 3. The physics

### Units

The DAC publishes pressure in **dbar** and temperature as **ITS-90 °C**, which
is what TEOS-10 wants, so `src/lib/seawater.ts` converts nothing.
`test:erddap` asserts those units rather than trusting them: if they ever
change, every derived property is wrong by a factor of ten and nothing says
so.

A raw Slocum writes conductivity in **S/m** and pressure in **bar** — both ×10
out, both silent when wrong. That conversion lives in
`packages/slocum/derive.ts`, which reads the file's own unit strings *and*
range-checks them. **Nothing here should grow a second copy of it.**

Position on the Slocum path is the same kind of trap: latitude and longitude
are NMEA `DDDMM.MMMM`, so `3936.313` read at face value is a latitude that
does not exist.

`m_depth` is not the depth: on the fixture segment it covers 3.1–4.0 m across
a profile whose temperature moves 9 °C, because the flight computer samples it
too slowly to see the dive. Depth is computed from the science pressure
through TEOS-10.

### Absolute Salinity needs a position, and says so when it has none

The point of TEOS-10 is that density depends on what the salt is made of,
which was *measured* and lives in a lookup table. The anomaly reaches
0.03 g/kg — thirty times the precision density is quoted to.

Without the atlas or a position, `SA` is Reference Salinity, and both paths
**report that** rather than quietly substituting one for the other.

---

## 4. Drawing

### Colour limits are chosen; axis limits are not

An **axis** takes the true minimum and maximum of what it was given — scaling
a point off the edge would hide it.

A **colour** axis is a lookup table with a couple of dozen entries, and
stretching it to reach one outlier spends nearly all of them on water that is
not there. The default is the 2nd–98th percentile, sampled to 20,000 values
and deterministic since it runs on every redraw. The reader's limits win, the
bar shows the numbers in force, the caption says `colour 2–98%`, and values
outside are drawn at the end colours rather than dropped.

**Percentiles alone are not enough.** An optical sensor's dark counts put real
readings below zero, so the 2nd percentile of a chlorophyll record is about
−0.03 µg/L — a negative concentration. `Plottable.floor` records what a
quantity physically cannot go below and clamps the automatic limit only; not a
sample is altered or hidden. It is absent where a quantity really is signed —
temperature reaches −2 °C, spiciness and the currents are signed by
construction — because a floor there would be a lie about the ocean rather
than a defence against a sensor.

| colour bar | before | after |
|---|---|---|
| chlorophyll | −0.08 – 8.54 | **0.00 – 6.85 µg/L** |
| temperature | 5.92 – 27.2 | **6.16 – 26.4 °C** (trimmed, not floored) |

### A point with no colour value is not drawn

It used to be, in the structural accent colour. That is right for an
uncoloured plot and wrong for a coloured one: the optical sensor samples far
less often than the CTD, so a chlorophyll section was **71,867 accent-blue
dots with no chlorophyll behind 1,284 that had it**, and read as though
chlorophyll had been measured everywhere.

Omitting them is what every plotting library does with a NaN in a colour
array. They are still counted and reported — "71,867 not shown: no chl there"
— and kept out of the hover search, since pointing at a gap should name the
nearest real measurement. Only when there *is* a colour axis.

### A depth axis starts at the surface

Every figure with depth on y — sections and both profiles, on both pages —
opens with its y range pinned to 0. Left to the data the axis began at
whatever the shallowest sample happened to be, 0.103 m on one deployment,
which is a fact about the sampling rather than the ocean.

Written into the reader's own range box rather than forced behind it, so the
limit can be seen, changed, and brought back with Reset. It excludes nothing:
a limit is a window, so a floor below every sample still draws them all.

### The plot area is a closed box

A frame on all four sides is what a scientific figure wears, and it is what
keeps the plot legible in a document with its own background: two legs leave
the top and right of the data floating.

### Colour is a value, not a role

Structural colour — axes, ticks, the uncoloured trace, markers — is a
**class**, so a theme switch restyles everything with no redraw. The colour
axis is the one exception and has to be: it encodes a value, and a value
cannot be named in a stylesheet. It is set as an **inline style**, because a
class rule beats a presentation attribute however specific the attribute
looks — set as an attribute, both the colour and the point size are silently
discarded.

### How much is drawn

`DEFAULT_MAX_POINTS` is 200,000. Timed in a browser on a 1240×360 section:
75,000 points in 18 ms, 200,000 in 53 ms, 400,000 in 148 ms — and **57 DOM
nodes at every one of them**, because the dots are one path per colour bin. It
was 50,000, inherited from a decoder whose limit was 4,000, and at that
ceiling a deep two-month deployment was drawn at every third point before the
reader chose anything.

---

## 5. The browser map

A dot at the centre of a bounding box says a glider was somewhere in the
Mid-Atlantic; the path says it ran the shelf break for eleven days. A whole
mission at one fix per six hours is **3 KB and about a fifth of a second**, so
the expensive part is the number of requests: fetched for what is on screen,
capped at 60, six at a time, with the cap printed.

**The colour is one absolute clock shared by every track**, not each mission's
own span. That is what makes the map answer "when": two gliders out the same
season come back the same colour, a 2019 deployment is visibly different from
a 2026 one. The span is printed beside the counts, because a colour whose key
the reader cannot see means nothing.

**The dot stays**, at the end of the path once there is one and at the
bounding-box centre until then. A track has two ends and nothing on it says
which is recent, and "where is it now" is the question the map is opened with.

**Archived tracks are cached in `localStorage`, and only archived ones.** A
mission still reporting grows every few hours, so a cached path would show a
glider that had stopped moving. The entry is keyed on the last-report time as
well as the id, so a deployment that reported again invalidates itself.
Coordinates are rounded to four decimals — eleven metres, far finer than a
six-hour fix, a third of the bytes.

### The marker is coloured against the basemap, not against the theme

Every other colour on the site is a colour *of the page* and flips with the
theme. A dot on the map is not on the page — it is on Esri's tiles, which
have one palette and do not know the theme exists. Marking the glider with
`--accent` therefore made the marker **worse** in dark mode, where the accent
turns pale and the water under it stays pale.

Measured against the tiles as they render, with the fills at the
`fill-opacity` they shipped at:

| | colour | effective | vs the water |
|---|---|---|---|
| reporting, light | `--accent` @ 0.55 | `#145785` | 1.09:1 |
| reporting, **dark** | `--accent` @ 0.55 | `#67a4d2` | **1.04:1** |
| archived, light | `--text-muted` @ 0.25 | `#2e5377` | 1.05:1 |
| archived, dark | `--text-muted` @ 0.25 | `#92afd2` | 1.01:1 |

1.0 is the background. Two mistakes compounding: a translucent fill blends
toward whatever it stands on, and what it stands on is water of the same hue.

The basemap was sampled rather than guessed — five tiles over glider country,
quantised — and **97% of it is light**: `#b5d3ee` shelf blue is a third of
the map, then land at `#e9e8e5`, slope blue, `#779ecc` deeper water, olive.
So the marker's body is dark and opaque: `--map-here` `#8f0b22` for a glider
still reporting, `--map-past` `#243447` for a mission that has ended, 3.4:1
and 4.6:1 at worst across that set, 6.0:1 and 8.2:1 on the shelf blue that is
most of it.

**One tone is not enough, and this is not a matter of picking a better one.**
A track is coloured through `cmo.thermal`, which spans luminance 0.015 to
0.863 — every luminance there is — so for any flat colour some part of the
ramp matches it: measured across a dozen candidates, the best worst-case was
1.2:1. Hence the white ring, which is 7.5:1 against the ramp exactly where
the dark body is 1.3:1. Body or ring, never worse than 3.4:1 on anything the
map can put behind it, and `test:contrast` holds all of it.

The three values live in `tokens.css` and are **deliberately not redefined in
the dark block** — that absence is the rule, so `test:contrast` asserts it.
`map-export.ts` keeps the only other copy, because the PNG composites the
same tiles; the same suite checks the two still agree.

### Two rules stand between an invisible hit line and a clickable one

A 2.5 px stroke is very hard to hit and a diagonal one is worse, so each track
carries one fat transparent line beneath it. Making it *work* took two goes:

- SVG's default `pointer-events: visiblePainted` makes an element a target
  only where it is **painted**, and `stroke-opacity: 0` paints nothing. It
  swallowed exactly zero clicks and looked like a hit-testing problem with
  thin strokes. `pointer-events: stroke` means the stroke area whatever the
  paint.
- The selector must out-specify Leaflet's own `.leaflet-interactive
  { pointer-events: auto }`, imported after this stylesheet and winning at
  equal specificity. Hence `path.track-hit`.

---

## 6. Exporting

Three things separate a PNG somebody can put in a paper from a screenshot, and
`packages/plot/png.ts` does all three.

- **Resolution.** 3×, so a 1240-point section leaves as 3828 px — full journal
  width at 300 dpi with room to spare.
- **It carries its own text.** Title and caption are drawn into the image; on
  screen they are HTML beside the SVG.
- **It is on white.** Print is white with dark ink whatever the screen is set
  to, so the export uses the light palette even in dark mode. The fonts are
  the generic families deliberately: an SVG rasterised through a blob URL is
  its own document and cannot reach the page's `@font-face` rules, so naming
  Inter there would silently fall back anyway.

The map needs a different exporter (`src/lib/map-export.ts`) because it is not
an SVG: it is a pane of `<img>` tiles with vector overlays. Tiles are
composited onto a canvas and **the track is redrawn from its own coordinates**
rather than rasterised, so the path is as sharp as the tiles allow. The colour
bar, its range, and Esri's required attribution are drawn in.

**It works only because the tiles are fetched with CORS.** Drawing an image
fetched without it taints the canvas, and a tainted canvas throws on `toBlob`
— at the very end, after all the work. Esri answers
`Access-Control-Allow-Origin: *` (checked before relying on it).

---

## 7. Layout and CSS traps

### The base path

The site is served from `/gliders/`, and Astro rewrites nothing — `base` is a
value the code applies. Everything internal goes through `withBase` in
`src/lib/url.ts`. The two that are not links break silently: the SAAR atlas
fetch, and the worker's own URL, which must be
`new Worker(new URL('./derive.worker.ts', import.meta.url))` so the bundler
carries the base.

### Styling nodes that do not exist yet

Section figures are built by **cloning a prototype** — a compiled Astro
component cannot be instantiated at runtime, and the number of sections is the
reader's choice. A clone carries no scoping attribute, so every rule for the
plot's linework, the chips and the table rows is in a `<style is:global>`
block anchored on `[data-figure]`, `[data-chips]`, `[data-rows]`. Scoped, they
would match nothing.

`fill: none` on every stroked path is not optional: an SVG path fills by
default, so the axis renders as a solid triangle across the plot.

### A figure title is one style

The map's title wore `.eyebrow` — mono, uppercase, muted, small — while every
plot's wore an `h3`, so two peers side by side looked like a caption beside a
heading. One `.figure-title` class now; `h2` stays the heading for a *group*
of figures. Mixed case rather than uppercase is forced rather than preferred:
`text-transform` turns "σ₀" into "Σ₀" and "kg/m³" into "KG/M³".

They also have to be *level*. `global.css` gives `.topline` a top margin of
`--space-md`, written for a caption above a full-width map; a `PlotFigure`'s
head has none, and overriding only `margin-block-end` left it in place and put
"Track" exactly 20 px below "T–S diagram".

### The pointer readout must not move the figure it describes

Measured at 1280×900: hovering the T–S diagram wrapped an 80-character
readout onto three lines, grew the head from 26 px to 80 px and **dropped the
plot 54 px** — out from under the pointer that summoned it. Four rules hold it
still, and jsdom does no layout, so they are checked in the built CSS:

- symbols instead of names (the axes carry the full label already);
- `white-space: nowrap` with a reserved `min-height`, so it can never wrap;
- `visibility: hidden` rather than emptying, so the slot keeps its width;
- a fixed `ch` width per value with tabular figures, so the *labels* stop
  sliding as the digits change. Aligned to the **start**, so the slack falls
  before the separator rather than between a label and its own number.

U+2007 FIGURE SPACE is exactly one character wide in a monospace face; U+2002
separates the groups. Ordinary spaces collapse under `nowrap`.

### `--border` and `--border-strong`

The palette is oceansensing.org's, unchanged. `--border` is a 1.33:1 hairline:
right for a table rule, and **not** enough for the boundary of a text field,
which under WCAG 1.4.11 is the only thing identifying the control. Interactive
edges take `--border-strong` at 3:1.

### A `<select>` is as wide as its widest option

The map's colour menu contains "Potential density anomaly σ₀ (kg/m³)", so
uncapped it pushed the caption onto three lines — and because the map fills
what the row leaves it, the map lost the same 65 px. Every legend row also has
a `min-height`, because the range boxes become `datetime-local` on a time axis
and render ~2 px taller than a `number`.

---

## 8. The tests

Plain Node scripts, no framework, run through type stripping against the
TypeScript sources — a runner needing its own transform would put a build
between the code and its check. All offline; fixtures in `scripts/fixtures/`.

| suite | what it protects |
|---|---|
| `test:teos10` | the thermodynamics, against GSW's own answers |
| `test:erddap` | query construction, streaming parse, 404-means-empty, the bin ladder, QC |
| `test:plot` | windows vs rescaling, reported decimation, robust limits, the underlay, colormap names |
| `test:derive` | both paths end to end, physical floors, label collisions, the real Slocum fixture |
| `test:pages` | the base path, the CSP, and every CSS rule jsdom cannot see |
| `test:contrast` | every colour pair that ships |
| `check:docs` | that a new package, suite or page cannot land undocumented |

`npm run verify` chains build, type-check, the doc gate and all six suites —
about 320 checks. `check:vendored` is run by hand: it compares the copied
packages against the source repository, which is not present in CI.

**A gate that depends on a bundler's size heuristic fails for the wrong
reason.** Astro inlines a small stylesheet into the page and emits a larger one
as a file; adding the map's legend pushed the deployment page over that
threshold and six checks that read only the HTML failed against CSS that was
correct. `ALL_CSS` in `test-pages.mjs` reads both.

---

## 9. Things that were wrong, and how they looked

Each shipped, was found by running it, and now has a gate.

- **Every colormap name was wrong.** cmocean's maps are namespaced
  `cmo.thermal`, and `sample()` falls back to viridis for a name it does not
  know rather than throwing. Every section drew perfectly, in entirely the
  wrong colours, with nothing saying so.
- **Two variables arrived under one name.** The DAC publishes `bsipar_temp` —
  the PAR sensor's *internal* temperature — with `standard_name:
  sea_water_temperature`, so it and the CTD both showed as "Temperature". An
  exact column-name match now outranks a `standard_name` match.
- **The derived columns froze at the first chunk.** The memo was keyed by
  property name alone, so a 500-element column sat beside a 19,000-element
  one. It read as a slow network.
- **Depth and time were not offered as axes.** They are classified ancillary,
  so filtering ancillary columns out of the menus removed exactly what a
  section is drawn against, and the T–S diagram silently coloured by
  temperature instead of depth.
- **Reloading for a new window aborted itself.** The page kept one
  `AbortController`; choosing a window aborted the in-flight fetch and then
  handed the aborted signal to the next load's metadata request. Every
  selection failed with "signal is aborted without reason".
- **Captions called missing data "outside the window".** NaN fails every
  comparison, so a plot with no limits set reported thousands of samples
  outside a window the reader had never drawn.
- **The map drew over the page title.** `leaflet.css` is what gives
  `.leaflet-container` its `overflow: hidden`. It is imported by
  `lib/track.ts` — the module that builds the map — so a page cannot forget
  it.
- **The map was invisible with every tile loaded.** A `ResizeObserver` calling
  `invalidateSize` and `fitBounds` saw its own effects as another resize and
  re-entered every frame, restarting the tile fade. Nine tiles complete, nine
  at `opacity: 0`. Guarded on the size actually changing, and `fadeAnimation`
  is off — the fade is driven by `requestAnimationFrame`, which a background
  tab never runs.
- **A link's choice was silently dropped.** Assigning a value to an empty
  `<select>` does nothing, and the track's menus are filled only once the data
  says which columns exist — so `?track=sigma0` fell back to time. The wanted
  value is held until there is a menu to receive it.
- **The glider was marked in a colour the map was already wearing.** A
  translucent accent-blue dot on Esri's blue water measured 1.09:1 in light
  mode and 1.04:1 in dark — the second worse than the first, because the
  marker followed the theme and the basemap did not. It passed every contrast
  check on the site, all of which asked how it looked against the *page*.
