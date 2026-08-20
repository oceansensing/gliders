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

### There are two limits on vertical resolution, and only one gets better

The bin ladder answers "how much of the record can we afford". The other
limit is how much record there is, and the page never used to say it:
`cp_1155-20260429T1457` is a Pioneer glider whose science samples are **9.6 m
apart**, so its 1 m overview bin, a 5 m bin and every sample it took are
within 3% of each other. A reader who narrows the window gets exactly what
was promised — full rate, 11,410 rows, no `orderByClosest` in any request —
and sees a section that has not changed, with nothing on screen explaining
why.

So the caption reports the glider's own spacing, measured as the **median**
absolute step between consecutive fixes that have a depth. The median rather
than the mean because the turn at the bottom of each profile contributes one
large step per dive: on a synthetic sawtooth the mean reads 19.7 m for a
glider sampling every 10. Below fifty steps it says nothing rather than
inventing a typical spacing from four of them.

Which limit is in force decides which sentence is printed — "narrow the
window to load a stretch at full rate" only when the bin is finer than the
glider, with half a bin of slack so a 1 m bin against 1.2 m sampling does not
send anyone after 20% they will not see. `lib/sampling.ts`.

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
a point off the edge would hide it — **and then leaves room for the marker
sitting on it.** Ending exactly at the data draws half the outermost dot
outside the box: measured on the deployment page, the extreme dots of every
figure sat 0.0 px from the frame and overhung it by 0.8 px on the right, their
own half-width. That is the same rule failing quietly rather than a different
one.

`AXIS_MARGIN` is **3%** of the span, not the 5% most plotting libraries
default to, because the same code draws sections against time: 5% of a
four-week window is a day and a half of blank at each end, which reads as the
glider having reported nothing there. 3% is about thirteen pixels on a 450 px
plot.

**A limit the reader typed never gets it.** Padding one would draw a box that
is not the one they asked for, and the count of samples outside the window
would be counted against a different number than the axis prints. It is also
what keeps a depth axis pinned at exactly 0 rather than opening at a negative
depth. The **colour** axis takes no margin at all: its ends are printed on the
bar and read as the range in force, so padding them would label the bar with a
number the colours were never mapped from — and on a floored quantity it would
print the negative concentration `Plottable.floor` exists to prevent.

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

### A row of zeros is a fill value, not fresh water at freezing

`cp_1155-20260429T1457` publishes one row per surfacing on which **every**
science column is a placeholder: depth, pressure, temperature, salinity,
conductivity, chlorophyll, CDOM and PAR all exactly `0`, and the published
density 999.8445 — TEOS-10 for fresh water at 0 °C. 170 of them in a
four-week window, 1.5% of the record. The position and the timestamp are
real; that GPS fix is why the row exists.

One such row is visible everywhere at once, and all three symptoms were
reported as separate bugs:

| | with the rows | without |
|---|---|---|
| T–S axes | SA **0.000**–36.7, CT **0.015**–29.9 | 32.3–36.7, 7.14–29.9 |
| σ₀ colour bar | **−0.157**–27.3 kg/m³ | 21.6–27.3 |
| temperature section | 0–29.9 °C | 8.28–28.1 |

**The robust 2–98% limits could not save it.** At 3.2% of the samples that
have a value, the placeholders reach past the 2nd percentile — the defence
against one bad sensor reading is not a defence against 170 identical ones.

The test is the conjunction and it is exact: temperature, salinity *and*
pressure all precisely `0`. Seawater does not do that — not in the Great
Lakes datasets, where the water is fresh but never 0.0000 °C, and not under
ice, where it is cold but never 0.0000 dbar. Anything looser starts deleting
measurements. Everything on the row goes, not only the three tested, because
a dissolved-oxygen value compensated from zeros is not a measurement either.
Unconditional rather than a toggle, and counted on screen: a QARTOD flag is a
test's opinion about a number, and this is a row with no number in it.

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
the expensive part is the number of requests.

### The archive is baked; only what is still moving is fetched

A finished mission's path never changes again, and there are 2,481 of them.
That is not a request anyone should make of somebody else's server to draw a
background map, so it is made once at build time and served from here.

| | |
|---|---|
| a cold bake of the whole archive | 2,481 requests, **17 s** at six at a time |
| what it produces | 513,311 fixes and their clock, **5.8 MB** raw |
| what is actually served | **~1.8 MB** brotli, largest shard 196 KB |
| the whole archive on screen | **1.4 s** from the click |

**Split by the year the mission started**, which is the axis the reader
already filters on: looking at 2019 loads 2019. It also keeps a re-bake honest
in git — a year that has ended is a file that will never be written again — and
that is the reason this lives in `public/data/tracks/` rather than in a
separate data repository. At 1.4 MB with only the current year churning, a
second repo would buy a cross-origin fetch and a sync problem and nothing else.

**Positions as deltas between fixed-point integers**, hundredths of a
millidegree, and the times as deltas in ten-minute units. A glider moves about
6 km between fixes, so the deltas are three-digit numbers where the positions
are seven-digit ones, and that is the whole trick. Measured, projected to the
archive: pairs at 4 dp 1.98 MB, delta-encoded **1.51 MB**, deltas at 1e-3
1.15 MB, deltas simplified to 555 m 0.97 MB. The last two were not taken — a
coarser grid and a dropped point are both a *different track* from the one the
deployment page draws. The clock adds 0.30 MB at ten-minute resolution against
1.02 MB at full precision.

**Archived only.** A glider still reporting grows a few fixes a day, so a
baked path would show it stopped. Those are fetched live, every visit. A
missing shard, an unbaked year, a mission that finished since the last bake —
each falls through to the DAC, which is where all of it came from before.

Refresh with `npm run data:tracks`; it re-fetches only what has changed. It is
**not** run in CI, for the same reason `check:vendored` is not: a deploy should
not depend on somebody else's server answering.

### What a position record says, and what a glider can do

Drawn straight from the DAC the map grew long straight lines across open
ocean — the Gulf of Mexico to the mid-Atlantic and back, Cape Cod to Oregon.
A deployment's dataset is whatever was filed under that id, which can include
a fix taken while the vehicle was on a ship, a shore station, a leg recovered
and redeployed elsewhere, or a corrupt GPS record.

**A record fails in two different ways and they need two different tests**,
and sorting every long step by its implied speed separates them. Taking only
the steps whose fixes really are about six hours apart, so the distance *is* a
speed:

| step | n | median m/s | physically impossible |
|---|---|---|---|
| 15–20 km | 3,873 | 0.80 | 0 |
| 20–25 | 1,851 | 1.00 | 0 |
| 25–30 | 718 | 1.14 | 0 |
| 30–40 | 531 | 1.37 | 3 |
| 40–50 | 137 | 1.94 | 3 |
| **50–100** | 118 | **3.17** | 12 |
| 100+ | 115 | 35.60 | 34 |

**Nothing under 30 km in the whole archive is impossible**, and the first band
whose median is impossible is 50–100 km. A glider swims at ~0.3 m/s and the
strongest sustained current adds ~2, so the fastest real thing measured — the
99.99th percentile of 24,873 steps — is 1.82 m/s. Fifty kilometres in six
hours is 2.31 m/s: just above that, well below the artefacts. An earlier
20 km cut — 0.93 m/s — split 16.3% of missions, and what it was splitting was
Spray gliders and `silbo` riding the Gulf Stream for real.

So three rules — over **50 km**, over **2.5 m/s** where the times are known,
or **a gap of more than 30 days**. Together: 4.9% of missions come out in more
than one run, against 16.3% at 20 km, and 58 fixes are dropped as single bad
positions against 1,566.

The distance cap has to stay even with a clock, because **a vehicle flown
across an ocean during a long silence looks slow**: 4,000 km over 30 days is
1.54 m/s, which no speed test rejects. And the speed rule has to be there
because the deployment page draws fixes seconds apart, where no distance rule
would ever trip.

### A month of silence ends the record

Past a month a glider has been recovered — a deployment does not go quiet for
a season and resume — so the record has stopped being one deployment whatever
its two ends look like.

`cp_374-20140416T1634-delayed` is filed as **846 days**. It is 344 fixes over
86 days in the spring of 2014, followed by **one single fix 760 days later**.
Its sibling `cp_374-20150509T1256-delayed` is filed as 458 days and is 303
fixes over 75; both strays are dated 2016-08-09, which is the day the third
`cp_374` deployment ended — a batch stamp, not a position report. That one fix
was setting the dot, the map's view, and the far end of the colour ramp.

Archive-wide the rule breaks **27 steps on 24 missions**, of which 6 have two
or fewer fixes on the far side — strays; the rest are two deployments in one
record. A run of one is not a line, so a stray simply stops being drawn.

**36 archived missions of 2,534 claim a span the data does not fill**, 4,364
glider-days of 163,000 — and the table used to repeat it. See below.

Both **break the line rather than bridge it**, which is what the plots do with
a gap and for the same reason. A fix unreachable from *both* neighbours while
they are reachable from each other is dropped outright: that is one wrong
position, not a vehicle that went somewhere.

### The same rule at a day, which does not survive its own measurement

Read this before anyone tightens the month.

A third of the long steps are not a speed at all — 2,523 of 7,343 follow a gap
of over nine hours — so a *day* looked like the obvious threshold: four missed
reports and the vehicle has moved, so nobody watched it go. Breaking on *a gap
over 24 h with more than 15 km covered* caught 474 steps the other rules miss.

Then those 474 were measured. Median **30 km over 2.1 days, which is
0.16 m/s**, and **434 of them slower than 0.3 m/s** — slower than a glider
swims unaided. Not vehicles that were carried: vehicles that quietly kept
swimming while the satellite link was down. It doubled the missions that split,
118 to 292, and what it split were the fast Spray gliders it was meant to
protect.

**A day of silence is normal operations; a month is a recovery.** The
threshold is not a tuning knob between two settings of one idea — they are
different events, and only the measurement says which is which. The month
breaks 27 steps; the day broke 474, nearly all of them wrongly.

Finding that out is what the baked clock was worth: without the elapsed time
those 474 steps are indistinguishable from transport. Quantised to ten
minutes, 0.30 MB across the archive against 1.02 MB at full precision, a 1.4%
error on a six-hour step.

### The table reports the span the positions fill

Printing 846 days as a duration is repeating an arithmetic mistake somebody
else made, so where the positions are known the table uses their span for
`start`, `last report` and `days`, and for sorting by any of them. So does the
colour clock, which one stray fix would otherwise stretch for every track on
screen.

The threshold is not a judgement call — the difference between the two spans
is sharply bimodal:

| | claimed minus filled |
|---|---|
| median mission | 0.05 days |
| 95th percentile | 0.20 |
| 99th | 15.6 |
| worst | 759.9 |

Under a quarter of a day it is the six-hourly sampling and means nothing;
**47 missions of 2,475 differ by more than a day**, and for those the claim is
empty span. A day is the gap between two populations rather than a number
anyone picked.

A corrected cell wears a dotted underline and carries the catalog's own claim
on hover — the reader is looking at somebody else's archive and is entitled to
know which number is whose. An underline rather than a colour, because colour
on this site means a value.

It is known only once a track is in, so the table corrects itself when the
archive loads. That needed `render` split in two: the row-drawing half is
called again when a correction lands, and the whole of `render` is not,
because it restarts the very load that produced the correction.

**`isActive` deliberately keeps the DAC's `end`.** It decides whether a
mission is fetched live or read from a shard, and the correction is only known
after that — keying it on the correction would be a mission classing itself.
Checked against the DAC, none of the 49 currently-active deployments has a
position record stopping more than a day before its catalog says; the
stretched ones are all long finished.

### A stretch is coloured by when it happened

Colour on the catalog map runs over one absolute clock shared by every track
on screen, and each stretch used to be placed on it by **interpolating from
the fix index** across the mission's start and end. That assumes the fixes are
evenly spaced in time. They are not wherever a mission has a gap — and a gap
is exactly where a mission's colour has something to say.

With the clock baked it is read off the record instead: the midpoint of the
two fixes the stretch runs between. Measured across 2,392 missions, as a
fraction of each mission's own span:

| | disagreement |
|---|---|
| median mission | 0.6% |
| **39 missions** | **over 25%** |
| worst, before the month rule removed its stray fix | **90%** |

So for most of the archive this changes nothing visible, and for the long
sparse deployments it moves a stretch most of the way across the colour bar,
to where it belongs. A record with no clock — an unbaked shard, a
`localStorage` entry written before the clock existed — still interpolates.

The end marker takes the end of the last *run*, not of the record — otherwise
the one mark claiming to say where the glider is sits in an ocean it was never
in. `test:tracks` re-derives the whole thing from the committed shards and
asserts no drawn step exceeds the cap: the longest is 49.8 km against a raw
worst of 9,295.

**And a run holding under 2% of a mission's fixes does not set the view.**
`gp_276-20231024T0345-delayed` is a Station Papa glider whose record opens
with five fixes off Cape Cod — the institution's dock, three thousand miles
from the water it flew in — before 671 in the Gulf of Alaska. Breaking the
line stopped the map ruling a route across North America, but the page still
opened zoomed out to fit both, with "deployed" pinned to Massachusetts. Every
fix is still drawn; `mainRuns` decides only what the view frames and where the
two end markers go, which is a question about the mission rather than about
the record.

### How many are drawn

The cap was 60 because every track was a request, and it bit in the worst
possible place: the default sort is most-recent-first, so turning "Active
only" off drew the sixty *newest* tracks, which were already on screen. The
archive had dots and nothing else.

With the data local the limit is drawing, and it is bounded by the **total**
rather than per track. A track is cut into stretches so its colour can change
along it; `SEGMENT_BUDGET` is 2,400 stretches shared out among however many
runs are up — 40 each at sixty missions, one each at 2,500. That works because
the thing being given up disappears at the same rate: the colour is one
absolute clock shared by every track on screen, so with the whole archive up
that clock spans two decades and each mission is already essentially one
colour. Measured with 2,526 tracks and 9,512 SVG paths on screen: **no long
task at all** through six zooms, and 211 ms for a full re-sort and redraw.

**Redraws are coalesced on a timer, not `requestAnimationFrame`.** A
background tab never runs one, so every track loaded and none of them drawn —
found by measuring exactly that, and the same trap that turned off Leaflet's
tile fade one layer up.

**A dot for a finished mission shrinks when there are many.** At full size,
2,481 of them buried the tracks they used to stand in for; the US east coast
and the Gulf went solid. It shrinks rather than going away, because it is
still the only thing saying which end of a path is the recent one. A glider
still reporting keeps full size whatever else is on screen.

**The colour is one absolute clock shared by every track**, not each mission's
own span. That is what makes the map answer "when": two gliders out the same
season come back the same colour, a 2019 deployment is visibly different from
a 2026 one. The span is printed beside the counts, because a colour whose key
the reader cannot see means nothing.

**The dot stays**, at the end of the path once there is one and at the
bounding-box centre until then. A track has two ends and nothing on it says
which is recent, and "where is it now" is the question the map is opened with.

**`localStorage` still caches what the shards do not**, and only archived
missions: one that finished since the last bake, or a shard that failed to
load. The entry is keyed on the last-report time as well as the id, so a
deployment that reported again invalidates itself — the same key the baked
shards carry, for the same reason. Coordinates are rounded to four decimals,
and the path is cached **raw**: what to draw of it is a rule that has changed
once already and should not invalidate a cache when it changes again.

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
| `test:tracks` | the baked archive's codec and shape, and — against all 2,476 committed missions — that no drawn step exceeds what a glider can swim |
| `test:derive` | both paths end to end, physical floors, label collisions, the real Slocum fixture |
| `test:pages` | the base path, the CSP, and every CSS rule jsdom cannot see |
| `test:contrast` | every colour pair that ships, and the map's markers against the basemap |
| `check:docs` | that a new package, suite or page cannot land undocumented |

`npm run verify` chains build, type-check, the doc gate and all seven suites —
about 450 checks. Two things are run by hand, both because a deploy should not
depend on somebody else's machine answering: `check:vendored` compares the
copied packages against the source repository, and `data:tracks` re-bakes the
archive from the DAC.

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
- **A section's vertical grid looked like a bug in the bin ladder.** It was
  the glider: 9.6 m native sampling, so narrowing the window loaded full rate
  exactly as designed and changed nothing anyone could see. The page reported
  the limit it had chosen and not the limit it was up against.
- **170 rows of zeros ran three figures at once.** A surfacing placeholder
  published as `0` for every measurement put the T–S axes at SA 0.000, the
  σ₀ bar at −0.157 kg/m³ and the temperature section at 0 °C — reported as
  three separate faults, and one row's worth of cause.
- **A link's choice was silently dropped.** Assigning a value to an empty
  `<select>` does nothing, and the track's menus are filled only once the data
  says which columns exist — so `?track=sigma0` fell back to time. The wanted
  value is held until there is a menu to receive it.
- **The glider was marked in a colour the map was already wearing.** A
  translucent accent-blue dot on Esri's blue water measured 1.09:1 in light
  mode and 1.04:1 in dark — the second worse than the first, because the
  marker followed the theme and the basemap did not. It passed every contrast
  check on the site, all of which asked how it looked against the *page*.
