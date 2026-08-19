# Engineering notes

What this site rests on, why it is shaped the way it is, and the things that
went wrong on the way. `README.md` says what it does; this says what a
future edit needs to know before changing it.

## The two paths meet at one interface

There are exactly two sources of data — the IOOS Glider DAC, and files a
reader drops on `/local/` — and everything below the fetch consumes the same
thing:

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
render layer breaks the local page silently** — it will still compile, and
the figures will simply stop being reusable.

## What a request to the DAC costs

Measured on `electa-20260807T1633`, an 11-day Mid-Atlantic deployment,
142,378 rows, 2,083 profiles:

| request | bytes | wall |
|---|---|---|
| whole deployment | 11.3 MB | 14.8 s |
| whole deployment, binned to 5 m | 1.6 MB | 15.3 s |
| one day | 0.58 MB | 1.1 s |
| one day, binned | 0.09 MB | 1.2 s |

Two things follow, and the second is the one that is easy to get wrong:

1. `orderByClosest("time,depth/N")` gives at most one sample per N metres per
   profile — the mechanism the overview resolution rests on. **How coarse N
   should be is the next section, and the first answer was wrong:** this note
   originally said 5 m and that the figures "all look the same" at it, which
   was true of the track and false of the section.
2. **Server time scales with the span asked for, not with the rows
   returned.** The bin happens after the read. About 1.35 s per day of
   deployment, near enough linear.

So the fetcher chunks by time *and* bins, for different reasons: chunks so
something is on screen in under a second and keeps growing, binning so the
network and the parser are never what is being waited on.

## The depth bin is the glider's, not a constant

The bin started as a flat 5 m and that was measurably wrong at the shallow
end. Vertical sampling varies by an order of magnitude across the archive:

| | native spacing | 5 m bin | 1 m bin | full |
|---|---|---|---|---|
| `electa` — 171 m shelf, 11 days | ~2.5 m | 18,673 | 71,968 | 142,376 |
| `ru29` — 961 m deep, 2 months | ~5.3 m | 147,464 | 184,868 | — |

A 5 m bin keeps an eighth of a shelf glider's profile — nine samples out of
sixty-eight — through a thermocline that is metres thick, so the section
showed the bin's structure rather than the ocean's. The same 5 m takes almost
nothing off the deep glider, which was never sampled that finely: 1 m buys it
only 25% more rows because there are no more to get.

So the finest bin is tried first and coarsened only if the deployment would
actually blow the row budget. **The projection cannot be computed, only
measured**: rows do not scale as 1/bin, because below the native spacing a
finer bin has nothing to return — halving electa's bin took it from 18,673 to
44,592 rather than to 93,000. Each candidate gets its own six-hour probe.

It costs no server time at all. The bin is applied *after* the read, which is
the same fact that makes chunking rather than binning the thing that gets a
picture on screen quickly.

Measured on `electa` after the change: 71,922 rows, first section at 566 ms,
complete at 2.9 s.

**A chosen window starts the ladder at full rate.** Narrowing is only worth
doing if it buys resolution, so `binMetres: 0` puts "every sample the glider
took" on the ladder as its finest rung and the same budget decides whether it
fits. A day of an eleven-day mission is a fortieth of it, so it does:
12 hours of `electa` is 5,588 rows unbinned, loaded in 1.8 s.

The window is **re-fetched, not filtered** from what is already on screen.
Filtering would leave the reader looking at the same 1 m overview through a
smaller frame and wondering why it had not sharpened — the point of narrowing
is to ask the server for the samples the whole record could not afford.

**The first version sized its windows by row count, and that is the bug worth
remembering.** It is the obvious design and it fails exactly because of (2):
fed a binned request the estimator sees a low row rate, concludes a 30-day
window is affordable, and the reader waits eleven seconds for the back half
of an eleven-day mission. Sizing by elapsed time instead, on the same
deployment and the same 18,661 rows:

| planner | first paint | total |
|---|---|---|
| by rows (2 chunks) | 3,197 ms | 14,273 ms |
| by elapsed time (15 chunks) | **925 ms** | **6,100 ms** |

Concurrency is 3 and more does not help: four parallel one-day requests
measured 4.3 s against ~4.4 s of serial time, so the server queues rather
than parallelises.

More in `packages/erddap/CLAUDE.md`, including the two API facts that break a
client written from the documentation: **an empty result is an HTTP 404**,
and `allDatasets` takes no paging parameters.

## Units

The DAC publishes pressure in **dbar** and temperature as **ITS-90 °C**,
which is what TEOS-10 wants, so `src/lib/seawater.ts` converts nothing.
`test:erddap` asserts those units rather than trusting them, because if they
ever change the derived properties are wrong by a factor of ten and nothing
says so.

A raw Slocum writes conductivity in **S/m** and pressure in **bar** — both
×10 from what TEOS-10 wants, both silent when wrong. That conversion lives in
`packages/slocum/derive.ts`, which reads the file's own unit strings *and*
range-checks them. **Nothing in this repository should grow a second copy of
it**; the local page calls `deriveSeawater` rather than re-deriving.

Position on the Slocum path is the same kind of trap: latitude and longitude
are NMEA `DDDMM.MMMM`, a perfectly ordinary number, so `3936.313` read at
face value is a latitude that does not exist.

## Absolute Salinity needs a position, and says so when it has none

The whole point of TEOS-10 is that density depends on what the salt is made
of, which was *measured* and lives in a lookup table. The anomaly reaches
0.03 g/kg — thirty times the precision density is quoted to.

Without the atlas or without a position, `SA` is Reference Salinity, and both
paths **report that** rather than quietly substituting one for the other.
`test:derive` checks the flag and that the two numbers actually differ.

## Things that were wrong, and how they looked

Each of these shipped, was found by running the thing, and now has a gate.

- **Every colormap name was wrong.** cmocean's maps are namespaced
  `cmo.thermal`, not `thermal`, and `sample()` falls back to viridis for a
  name it does not know rather than throwing. So every section drew
  perfectly, in entirely the wrong colours, with nothing anywhere saying so.
  `test:plot` now compares every name the site asks for against the table.
- **Reloading for a new window aborted itself.** The page kept one
  `AbortController`; choosing a window aborted the fetch in flight and then
  called `load`, which reached `datasetInfo` still holding that aborted
  signal. Every window selection failed instantly with "signal is aborted
  without reason" and emptied the page. The controller belongs to a load, not
  to the page, and is created at the top of one.
- **The pointer readout moved the figure it described.** An 80-character
  line of spelled-out labels wrapped onto three lines in the T–S diagram's
  half-width column: the figure's head grew from 26 px to 80 px and the plot
  dropped 54 px the instant the pointer touched it. Symbols instead of names,
  a slot that cannot wrap, and a reserved line fixed it — and then the
  *numbers* were still sliding the labels sideways as their digits changed,
  which needed a fixed `ch` width per value. `test:pages` reads all of it out
  of the built CSS, because jsdom does no layout.
- **Two variables arrived on screen under one name.** The DAC publishes
  `bsipar_temp` — the PAR sensor's own internal temperature, `long_name:
  sci_bsipar_temp` — with `standard_name: sea_water_temperature`. Matching on
  `standard_name` made it and the CTD's `temperature` both "Temperature", in
  the chip row and in the map's colour menu, with nothing to say one of them
  was the inside of an instrument. An exact column-name match now outranks a
  `standard_name` match, and a colliding label falls back to its column name.
- **A gate that depends on a bundler's size heuristic fails for the wrong
  reason.** Astro inlines a small stylesheet into the page and emits a larger
  one as a file; adding the map's legend pushed the deployment page over that
  threshold, and six `test:pages` checks that read only the HTML started
  failing against CSS that was perfectly correct. They read both sources now.
- **A `<select>` is as wide as its widest option.** The map's colour menu
  contains "Potential density anomaly σ₀ (kg/m³)", so uncapped it pushed the
  map's caption onto three lines — and because the map fills what the row
  leaves it, the map lost the same 65 px.
- **The plot's point cap was the binding constraint, not the browser.** It
  was 50,000, inherited from a decoder whose limit was 4,000 — so a deep
  two-month deployment was drawn at every third point before the reader had
  chosen anything. Measured in a browser on a 1240×360 section: 75,000 points
  in 18 ms, 200,000 in 53 ms, 400,000 in 148 ms, and **57 DOM nodes at every
  one of them**, because the dots are one path per colour bin. The cap is
  200,000 now.
- **The derived columns froze at the first chunk.** The memo was keyed by
  property name alone, so once `sa` was computed for chunk one it was
  returned for the rest of the load — a 500-element column beside a
  19,000-element one. It read as a slow network. Keyed by row count now.
- **Depth and time were not offered as axes.** They are classified ancillary
  (`ioos_category` groups them with the identifiers), so filtering ancillary
  columns out of the axis menus removed exactly what a section is drawn
  against, and the T–S diagram silently coloured by temperature instead of
  depth. `Plottable.section` now separates "can be an axis" from "is worth a
  chip".
- **The map drew over the page title.** `leaflet.css` is what gives
  `.leaflet-container` its `overflow: hidden`; without it the tile pane is
  not clipped. It is imported by `lib/track.ts` — the module that builds the
  map — so a new page cannot forget it.
- **The map was invisible with every tile loaded.** A `ResizeObserver` that
  called `invalidateSize` and `fitBounds` saw its own effects as another
  resize and re-entered every frame, restarting Leaflet's tile fade before it
  could finish. Nine tiles complete, nine tiles at `opacity: 0`. The observer
  is guarded on the size actually changing, and `fadeAnimation` is off —
  the fade is driven by `requestAnimationFrame`, which a background tab never
  runs.
- **`m_depth` is not the depth.** On the fixture segment it covers 3.1 to
  4.0 m across a profile whose temperature moves 9 °C: the flight computer
  samples it too slowly to see the dive. Depth is computed from the science
  pressure through TEOS-10. `buildTable` also renames a sensor both computers
  wrote to `sci_water_pressure_tbd`, so a lookup by bare name finds neither.

## The base path

The site is served from `/gliders/`, and Astro does not rewrite anything —
`base` is a value the code applies. Everything internal goes through
`withBase` in `src/lib/url.ts`. The two that are not links are the ones that
break silently: the SAAR atlas fetch, and the worker's own URL (which must be
`new Worker(new URL('./derive.worker.ts', import.meta.url))` so the bundler
carries the base). `test:pages` reads the built HTML for root-absolute
internal URLs and the sources for a bare `fetch('/…')`.

## Colour limits are chosen, axis limits are not

An **axis** takes the true minimum and maximum of what it was given. A plot
that scaled a point off its own edge would be hiding data, and the engine
does not do that.

A **colour** axis is a lookup table with a couple of dozen entries, and
stretching it to reach one outlier spends nearly all of them on water that is
not there. So the default colour limits are the 2nd and 98th percentiles —
matplotlib's and xarray's convention — sampled to 20,000 values rather than
fully sorted, deterministically, because this runs on every redraw. The
reader's own limits always win, the colour bar always shows the numbers in
force, the caption says `colour 2–98%`, and values outside are drawn at the
end colours rather than dropped.

**Percentiles alone are not enough, and chlorophyll is why.** An optical
sensor's dark counts put real readings below zero, so the 2nd percentile of a
chlorophyll record on the DAC is about −0.03 µg/L — a negative concentration.
`Plottable.floor` records what a quantity physically cannot go below, and it
clamps the automatic limit only: not a sample is altered or hidden. It is
absent where a quantity really is signed — temperature reaches −2 °C,
spiciness and the current components are signed by construction — because a
floor there would be a lie about the ocean rather than a defence against a
sensor.

The same rule colours the track, whose chlorophyll legend read
`-0.08 – 8.54 µg/L` before it and `0 – 6.64 µg/L` after.

## A depth axis starts at the surface

The profile panels open with their y range pinned to 0. Left to the data the
axis began at whatever the shallowest sample happened to be — 0.103 m on one
deployment — which is a fact about the sampling rather than about the ocean,
and it started two profiles of the same water at different depths. Written
into the range box rather than forced behind it, so the reader can see the
limit, change it, and get it back with Reset.

## The track figure is shared, not copied

The map, its title and the legend under it are one component
(`TrackFigure.astro`) and one controller (`lib/track-legend.ts`), used by
both the deployment viewer and the local-files page. The two callers differ
in exactly one thing — a DAC dataset names its own time, position and depth
columns, while a decoded Slocum table always uses `time`, `latitude`,
`longitude`, `depth` — so that is a parameter (`TrackAxes`) and the rest is
shared.

This is the same split the figures already keep: `PlotFigure.astro` is the
markup, `lib/figure.ts` is the behaviour, and three figures differ only by
preset. It went in when the local page needed the legend the deployment page
had: adding it there meant either a second copy of 470 lines or one shared
piece, and a copy is a copy that drifts.

## Styling nodes that do not exist yet

Section figures are built by **cloning a prototype** — a compiled Astro
component cannot be instantiated at runtime, and the number of sections is
the reader's choice. A clone carries no scoping attribute, so every rule for
the plot's linework, the chips and the table rows is in a `<style is:global>`
block anchored on `[data-figure]`, `[data-chips]`, `[data-rows]`. Scoped,
they would match nothing and every section would render as black fills on
black strokes. `test:pages` reads the built CSS for them, because jsdom does
no layout and cannot see it.

`fill: none` on every stroked path is not optional: an SVG path fills by
default, so the two-legged axis renders as a solid triangle across the plot.

## Colour is a value, not a role

Structural colour — axes, ticks, the uncoloured trace, the markers — is a
**class**, so a theme switch restyles everything with no redraw. The colour
axis is the one exception and has to be: it encodes a value, and a value
cannot be named in a stylesheet. It is set as an **inline style**, because a
class rule beats a presentation attribute however specific the attribute
looks — set as an attribute, both the colour and the point size are silently
discarded.

## `--border` and `--border-strong`

The palette is oceansensing.org's, unchanged, so the two sites look like one.
`--border` is a 1.33:1 hairline: right for a table rule or a figure's edge,
and **not** enough for the boundary of a text field, which under WCAG 1.4.11
is the only thing identifying the control. So interactive edges take
`--border-strong` at 3:1 and decorative lines keep the hairline they were
designed with. `test:contrast` reads `tokens.css` itself rather than a copy.

## The tests

Plain Node scripts, no framework, run through type stripping against the
TypeScript sources — a runner needing its own transform would put a build
between the code and its check. All offline.

| suite | what it protects |
|---|---|
| `test:teos10` | the thermodynamics, against GSW's own answers |
| `test:erddap` | query construction, streaming parse, the 404-means-empty rule, QC |
| `test:plot` | windows vs rescaling, reported decimation, the underlay, colormap names |
| `test:derive` | both paths end to end, including the real Slocum fixture |
| `test:pages` | the base path, the CSP, and the global rules clones depend on |
| `test:contrast` | every colour pair that ships |
