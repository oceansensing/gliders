# @c4po/plot

A small SVG scatter/line plot with a colour axis, and the code that turns one
into a file.

Renderer-complete and framework-free: it takes typed arrays and an SVG element
and draws. It knows nothing about seawater, ERDDAP, or where the numbers came
from — the T–S diagram's density contours reach it through the `underlay`
hook, as line segments in data coordinates.

## Where it came from

Extracted from `SlocumDecoder.astro` in the oceansensing.github.io repository,
where it was 250 lines inside a 3,700-line component and could not be used by
anything else. The drawing is that engine's, hard-won details included. Four
things are new, each because this site asks something of it that the decoder
did not.

**Columns, not rows.** The decoder built a `number[][]` — one small array per
point. This site's data arrives as `Float64Array` columns straight out of the
ERDDAP parser and the TEOS-10 worker, and a 700,000-row deployment would mean
700,000 allocations to hand it over in the old shape. `Series` is three typed
arrays and a length, which is what both producers already have.

**An `underlay` hook.** A T–S diagram is unreadable without density contours
behind the points, and those are traced by TEOS-10 in data coordinates. The
hook receives the projection and draws before the points, so the engine never
learns what density is.

**Honest decimation.** The decoder drew at most 4,000 points, silently. At a
glider's resolution that discards most of a section, so the cap is a
parameter, far higher, and the number actually drawn comes back in the result
for the caption to report.

**A frame the reader can trust.** `plot()` returns the `Frame` it drew with,
so a caller turning a pointer position back into a data value uses the same
mapping the points were placed with rather than a second copy of the padding
arithmetic.

## What the engine promises

- **A limit is a window, not a rescale.** Bounds are computed before anything
  is clipped, so setting one excludes points and *counts* them rather than
  squeezing the survivors into the visible range.
- **Missing is not the same as excluded.** A sample with no x or y is
  `missing`; one the reader's limits pushed out is `hidden`. Counting them
  together produced a caption reading "3,014 outside the window" on a plot
  with no window set — a limit the reader could not widen because they had
  never drawn it.
- **A line lifts its pen over a gap** rather than drawing a chord across the
  excluded stretch, which would be a segment the data does not support.
- **A point with no colour value is not drawn**, when there is a colour axis.
  It used to be, in the trace colour: an optical sensor samples far less often
  than a CTD, so a chlorophyll section came out as 71,867 accent-blue dots
  with no chlorophyll behind 1,284 that had it. Still counted, still reported.
- **Nothing about the document grows with the data.** The dots are one path
  per colour bin. Measured in a browser on a 1240×360 section: 75,000 points
  in 18 ms, 200,000 in 53 ms, 400,000 in 148 ms, and **57 DOM nodes at every
  one of them**.

## Two details that look like style and are not

**`fill: none` on every stroked path.** An SVG path fills by default, so the
axis renders as a solid triangle across the plot without it. The rule lives in
the consuming stylesheet; the engine only supplies the class.

**The colour axis is an inline style, never a presentation attribute.** A CSS
declaration beats a presentation attribute however specific the attribute
looks, so `stroke` set as an attribute is silently discarded and every dot
comes out in the theme's accent at the class's width. Structural colour stays
a class, so a theme switch restyles the plot with no redraw.

## `robust.ts` — colour limits a bad sample cannot set

An **axis** takes the true minimum and maximum. A **colour** axis is a lookup
table with a couple of dozen entries, and stretching it to reach one outlier
spends nearly all of them on water that is not there.

So the default colour limits are the 2nd and 98th percentiles — matplotlib's
and xarray's convention. Sampled to 20,000 values rather than fully sorted,
because this runs on every redraw and a percentile is settled long before
then; the stride is deterministic, so the same data gives the same colour bar
every time. A field that is flat over the middle 96% gets its full range back
rather than a zero-width scale.

The caller clamps further where physics requires it: an optical sensor's dark
counts put real readings below zero, so a chlorophyll bar computed from
percentiles alone still starts at −0.03 µg/L. See `Plottable.floor` in the
site's `variables.ts`.

## `png.ts` — a file somebody can put in a paper

Three things separate that from a screenshot.

**Resolution**: 3× by default, so a 1240-point section leaves as 3828 px.
Redrawn at that size rather than enlarged.

**It carries its own text**: `standalone()` nests the figure inside a document
with its title above and its caption below, because on screen those are HTML
beside the SVG and in a manuscript they have to be part of it. The hover ring
and any selection band are stripped — they are pointer artefacts, not the
figure.

**It is on white**: `PRINT` is the light palette, used whatever the reader's
theme is, because print is white with dark ink. The fonts are the generic
families deliberately — an SVG rasterised through a blob URL is its own
document and cannot reach the page's `@font-face` rules, so naming Inter there
would silently fall back anyway.

The background is painted before the image is drawn, because it is a property
of the document rather than of the SVG's content: without it the PNG is
transparent, which looks black in most viewers and white in others, neither
being the figure.

## `colormaps.ts`

Twenty maps: matplotlib's perceptually uniform set and the classics, plus the
eleven from cmocean, which is the family oceanography reads these fields in.
Copied verbatim from `packages/slocum/colormaps.ts`, where they also serve the
decoder.

**The cmocean names are namespaced `cmo.*`, and the prefix is load-bearing.**
`sample()` falls back to viridis for a name it does not know rather than
throwing, so a bare `'thermal'` produces a perfectly good plot in entirely the
wrong colours and nothing anywhere says so. Every field on the site was
mis-specified that way until `test:plot` grew a check comparing every name the
site asks for against the table.
