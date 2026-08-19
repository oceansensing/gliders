# The Slocum decoder

`packages/slocum` and the page at `/data/slocum/`. Moved out of the root
`CLAUDE.md`, which keeps the cross-cutting rules — the disclaimer every tool
page carries, and the list of failure shapes this project keeps meeting.

The third thing on this site with a package behind it, and the split is the
map's: `packages/slocum` decides what the bytes mean, `SlocumDecoder.astro`
decides what it looks like. No DOM, no Leaflet and **no npm dependency** — the
LZ4 and netCDF-3 implementations are in the package rather than imported, on
the same argument `kmz.ts` makes about ZIP libraries, and it matters more here
because this code is served to a reader's browser.

**It runs entirely client-side, and that is the feature rather than an
implementation note.** The page states it and nothing has to be trusted for
it to hold: there is no upload path in the code at all.

`test:map` carries a named list of everything under `packages/` and fails on
an unlisted one; `slocum` is listed as **not a map**, which is what exempts it
from the palette, pane and `dataBase` rules. That gate fired the moment the
package appeared, which is what it is for.

**The interface is in American spelling**, asked for and applied to every
reader-visible string on `/data/slocum/` — labels, accessible names, options,
captions, notes and the page's prose. The identifiers and comments in this
package and in `SlocumDecoder.astro` follow it, so the file does not read one
way and render the other: `color`, `colorMap`, `stepCount`, `.color-bar`.

It **is** the site's rule now — the map package followed a commit later, so
the two no longer differ and a change that moves code between them does not
have to pick one. The general note is in the root `CLAUDE.md`, including the
one thing a sweep cannot reach: a name a reader already has stored. This
package carries `knownColormap` for exactly that, since `grey` became `gray`
and a plot's scale rides in the saved view.

## Ported, not invented

Every reader of the format — `dbd2asc`, `dbdreader`, `SlocumIO.jl`, this — is
a reimplementation of one another, and a
decoder that is subtly wrong **does not fail**: it produces floats, in the
right shape, in a plausible range, and nothing on screen says the third column
is the wrong sensor.

So this is a port of
[`SlocumIO.jl`](https://github.com/oceansensing/SlocumIO.jl), which was itself
validated against `dbdreader` byte for byte, and `test:slocum` holds the port
to the same standard against a fixture recorded from dbdreader. Agreeing with
one is agreeing with both.

**The fixture is real data**, on the rule the shapefile reader taught this
repository: a file written by the writer that matches this reader agrees with
it by construction and proves nothing. It is one matched flight/science pair
from the electa MARACOOS deployment (VIMS/C4PO, May 2025), the two caches they
need and one compressed cache — 180 KB, committed. Segment 169 rather than any
other because it is a genuine dive, 853 CTD samples to 125 dbar, where the
first segment tried was a surface interval in which nothing moves.

Each sensor's times and values are compared by **SHA-256 over their raw
IEEE-754 bytes**. Every value, exactly. A tolerance would be the wrong
instrument twice: these are bytes copied out of a file rather than computed
quantities, and the failures this format actually produces are whole-column
shifts, which a comparison of summary statistics absorbs. NaN is canonicalised
to one bit pattern first, because IEEE-754 does not specify a payload and
there is no reason for CPython's and V8's to agree.

## The format, and the three things that are silent when wrong

After the ASCII header comes a 17-byte preamble whose whole job is to declare
byte order — `'s'`, a diagnostic byte, `0x1234`, `123.456` as a float32,
`123456789.12345` as a double, `'d'`. Every sentinel is checked, not just the
marker: they cost nothing and they are the only thing between a misidentified
file and a decode that produces confident nonsense.

Then, per cycle: `state_bytes_per_cycle` bytes at two bits per sensor, MSB
first; the values of the UPDATED sensors in cycle order; and one separator
byte.

- **The separator separates rather than terminates.** The final cycle has
  none, so a well-formed file ends with `chunk_end === length`. A reader that
  requires it drops the last complete cycle of every file it reads — a whole
  cycle, no error, nothing to say so. Caught here only because the fixture
  compares counts against dbdreader.
- **The state buffer has to be cleared each cycle.** Only `4 ×
  state_bytes_per_cycle` entries are written and that can be fewer than there
  are sensors. Left dirty, a sensor past the written range keeps the previous
  cycle's state and every chunk offset after it is wrong. **These fixtures do
  not exercise it** — 4 × 16 is exactly 64 sensors and 4 × 4 covers 14 — so it
  is correct by construction rather than by test, and worth knowing before
  touching that loop.
- **1-byte sensors are signed**, following both reference implementations.
  Nothing here distinguishes that from unsigned: every 1-byte value in the
  fixtures is 0, 1 or 2, and reading the wrong signedness is a mutation that
  survives the whole suite. That limit is asserted rather than written in a
  comment — `test:slocum` fails if a fixture ever carries a 1-byte value past
  127, so whoever sees it can gate the real thing instead.

**In JavaScript there is no host endianness**, which simplifies this: `DataView`
takes the byte order explicitly, so the file's own marker is passed to every
read and the swap-if-different dance both reference implementations do is not
needed.

## The cache is the whole interface problem

A file off a glider is **factored**: it names an eight-character CRC and
carries no sensor list, so without the matching `<crc>.cac` the bytes cannot
be interpreted — not partially, not approximately. That is the first thing
most readers meet, so `describe()` reads the header alone and
`MissingCacheError` carries the CRC, and the page asks for that file by name.
"Missing cache" without the name is not an actionable message.

Supplied caches are kept in **IndexedDB**, so it is a one-time step. Not
localStorage: a cache file is 4–120 KB of text and a glider's directory holds
a dozen, which is most of localStorage's ~5 MB before any margin. Every call
resolves rather than rejecting, so a reader in private browsing gets a decoder
that works and forgets — the same bargain the map's KMZ store strikes.

**The wrong cache is worse than none**, because it parses. Only the counts
disagree, so the sensor-list length is checked against the header's
`sensors_per_cycle` and a mismatch is refused rather than decoded.

**The key is everything before the *first* dot, not the last.** A CRC is
eight hex characters and can never contain one, so the first dot is where
the name stops being the key — where the last dot only works while the name
carries exactly one extension.

It does not always, and the failure says so on screen in two adjacent lines:
reported from DuckDuckGo, the page listed `92610b65.cac` as held and, the
line below, that 180 files needed `92610b65.cac` and it was "not here". Both
were true. Stripping one extension off a name with two leaves `92610b65.cac`
as the key while the header asks for `92610b65`, so the cache sat in the
store under a name the lookup could not reach and every file waited for
something already there. Reproduced exactly by handing the page a
`92610b65.cac.cac`; what a browser or a transfer actually appends is not
worth guessing, which is the argument for taking the key from the end that
is specified.

**`recallCaches` re-files what it finds**, and that half is not optional.
A key already in the store was written by whichever version the reader last
used, so fixing the derivation alone leaves every browser that already holds
a bad one broken forever — with `Forget everything` the only way out, which
takes the caches too. The in-memory map takes the normalized key
immediately, so the visit works whether or not the repair write lands; the
store is corrected so the next visit starts clean.

`test:slocum-page` drives both halves from an **empty** store, and that
detail is what makes them mean anything: the blocks above leave `92610b65`
filed correctly, and against that the decode check passed under the
mutation — vacuous until the mutation run showed it surviving. Both halves
are mutation-tested apart: keying from the last dot fails three checks
including the reported symptom, and dropping the re-filing loop fails only
the repair.

**Either order, and the first version silently required one.** A reader
dropping a whole directory hands over the caches and the data in one gesture,
and the page refused every data file that arrived before its cache. Two bugs,
both mine: the decoded set was *replaced* rather than accumulated, so a second
drop discarded the first; and a file held for a missing cache kept its name
and dropped its bytes, so there was nothing to retry with. Files are now
accumulated with their bytes and every held file is retried whenever a cache
arrives.

**A folder is the one action that supplies both**, which is why it exists as
an input at all: the file dialog selects within a single directory, and the
data and the `cache` directory are different ones. Dropping a folder goes
through `webkitGetAsEntry`, and there is a `webkitdirectory` input beside it
for readers who would rather pick than drag.

## A deployment is one glider over one continuous stretch of time

`packages/slocum/deployment.ts` — no DOM, so `test:slocum` exercises it
directly. Files are grouped before anything is written and each deployment
exports as its own file.

Two gliders are obviously two records. One glider's spring and summer work is
also two, and that is the case with nothing on screen to give it away: the
filenames match, the sensor names match, and once the two are written into one
table there is no way back. **A different glider always splits; a gap of three
days or more splits one glider's record.**

**The gap is measured between segments, not between samples**, and that
distinction is the whole correctness of it. A glider logs different sensors on
wildly different schedules — a position fix only on surfacing, an Iridium
counter once a segment — so a per-sample gap would split a deployment every
time a slow channel went quiet over a weekend. A segment is the unit the
glider actually flies continuously within.

Three days is the caller's number and is exposed as one (`gapSeconds`). What
it has to clear is the longest a glider can plausibly go dark inside one
deployment — a missed satellite pass, ice, a comms fault — while staying
shorter than the shortest turnaround between deployments. Slocum segments are
hours apart, so anything from about a day upwards separates the two cases;
three leaves room on both sides.

The gap is measured against the deployment's **furthest reach**, not the
previous segment's end, so one long segment overlapping a short one does not
read as a gap. A file with no usable clock anywhere is reported separately
rather than placed: putting it in the first deployment would be inventing a
fact.

With one deployment the picker stays hidden and the page reads exactly as it
did before, which is the ordinary case and should not have to pay for the
general one.

## Column order

The cache file lists sensors alphabetically over the glider's **whole**
namespace, which is not an order anybody wants: on one test segment that put a
channel holding 3 values of 1,328 in the first column and water temperature,
holding 853, in the sixty-second.

`orderColumns()` puts the named quantities first — position, then depth, then
the CTD and what is derived from it — and then sorts the rest by how many
values they hold, which pushes the nearly empty engineering channels to the
far right. **The two rules disagree for position**, which is recorded only at
surfacings and so holds very few values; the named list wins, because a table
whose first column is a position is what an operator is looking for.

One order for the CSV, the on-screen preview and both netCDF exports, from one
function, so they cannot drift.

## The grouping key is (sensor, glider, computer)

Three levels, and each was added because leaving it out merges records that
are not the same record.

**Glider** — the vehicle. Two vehicles' `m_depth` are separate measurements of
separate water; merged, they interleave and look exactly like data. Read from
the header's own `full_filename` rather than the name on disk, so a renamed
file or one still under its 8.3 name (`02150008.sbd`) does not become its own
vehicle.

**Computer** — flight and science, the two inside one glider.
`sci_water_pressure` is measured by the science computer and *relayed* to the
flight computer, which logs it at its own much slower rate — 853 samples
against 4 in the fixture pair. Which one holds the measurement is settled by
the **prefix**, not by sample counts: `sci_` is the science computer's,
`m_` is measured on the flight computer and `c_` is commanded on it, `u_` are
parameters the user sets and `f_` are factory values, with `x_` and a few
others the derived channels. Measured on this glider's namespaces, the science
computer's 105 sensors are **100% `sci_`** while the flight computer's 2,709
include 1,022 `sci_` ones, which it knows about only because science values
can be relayed to it.

**The suffix is the file extension, and `_flight`/`_science` was tried and
reverted.** Those read better and collide with real sensor names:
`m_leak_science` and `m_leakdetect_voltage_science` both end in `_science` and
are `m_` sensors, measured by the *flight* computer. Measured across the
namespace, two sensors end in `_science` and none ends in any file extension,
so `_sbd`/`_tbd` is the suffix that cannot be mistaken for part of a name.

**Within one computer the files merge**, which is the other half. `sbd`, `mbd`
and `dbd` are three decimations of one flight record, as `tbd`, `nbd` and
`ebd` are of one science record — the short ones sent over Iridium during the
deployment, the long ones recovered afterwards — so dropping a `tbd` and its
`ebd` must not produce two columns per sensor. Samples common to both are
merged by timestamp and counted; where two files disagree about a value at one
timestamp, the fuller file wins and the disagreement is reported, because two
decimations of one record should not disagree at all.

**Merged per sensor, not per file, because the decimation lists are not
nested.** `sbdlist.dat` and `mbdlist.dat` are set independently: on one
segment the sbd holds 64 sensors and the mbd 134, of which 58 are common and
**6 are in the sbd alone**. Taking the fuller file wholesale would drop those
six.

## There is no single time base, and that is a choice the reader makes

Every sensor is written on its own subset of cycles — the flight computer logs
depth every few seconds and position only on surfacing, and the science
computer keeps its own clock — so making a rectangular table is a decision
rather than a formatting step.

| `join` | rows | what is in them |
| --- | --- | --- |
| `union` (default) | every time any sensor reported | recorded values only; blank elsewhere |
| `interpolate` | one sensor's times | every other column interpolated, so not recorded |

The default is the lossless one and the other is never applied without being
asked. A union table is mostly blank, which is an honest picture of what a
glider logs — and **blank is written as an empty CSV field, never `0` or
`NaN`**, both of which are claims the file does not make.

**A sensor written by both computers stays two columns.**
`sci_water_pressure` is measured by the science computer and *relayed* to the
flight computer, which logs it at its own much slower rate — 853 samples
against 4 in the fixture pair. Merged under one name, the netCDF writer's
uniquifier silently renamed one `_2` and `f.variables['sci_water_pressure']`
returned the sparse relay: the right bytes under a name that meant something
else. They carry their file family now (`_sbd`, `_tbd`) and the reader is told
why. The same sensor across *segments* is one column, concatenated and sorted
— and the sort is load-bearing only on the interpolate path, since the union
join places each value by its own time regardless.

**Interpolation is angular where it has to be.** A heading interpolated
linearly across the 0/2π seam gives 180° — pointing exactly backwards, with
nothing in the output to say so. Matched by name rather than by unit, because
`rad` is also a fin deflection and a pitch, both of which are signed angles
about zero that interpolate perfectly well linearly and would be *damaged* by
wrapping.

## netCDF-3 classic, written by hand

netCDF-4 is HDF5 underneath — a library, not a file writer, and shipping a
WASM build of it to export a table of doubles is the wrong trade. Classic is
about two hundred lines: a magic number, dimensions, attributes, variables,
then the data, big-endian and padded to four bytes. Every tool that reads
glider netCDF reads it.

**Fixed dimensions, no record dimension.** `time` could be UNLIMITED and a
file written for appending usually makes it so; this one is written whole, and
a record dimension costs the interleaved record layout for no benefit.

**It does not claim CF.** The variable names are the glider's own sensor names
and the units are the glider's own unit strings — `degc`, `nodim`, `enum`,
`X` — which are neither udunits nor CF standard names. Writing
`Conventions = "CF-1.8"` would be a claim something downstream eventually
believes. `time` is the exception and is genuinely udunits, because that one
is computed here.

The real risk in a hand-written netCDF is the **offsets**: every `begin` is
patched after the header is sized, and one wrong pad puts a variable's data a
few bytes out, which reads as plausible numbers rather than as a corrupt file.
`test:slocum` therefore walks the file by its own header and compares each
variable against the column it came from. The layout was separately confirmed
by reading the output with `scipy.io.netcdf_file`, which is an implementation
nobody here wrote; the check is what keeps it true.

## The derived seawater columns

Off by default, and every one carries `source: 'derived'`, which reaches the
CSV heading and the netCDF `comment` attribute. A derived salinity in a file
of recorded sensors with nothing to say which is which is the failure this
package is otherwise built to avoid.

**The units are the whole risk.** Slocum writes conductivity in **S/m** and
pressure in **bar**; PSS-78 and TEOS-10 want **mS/cm** and **dbar**. Both
conversions are ×10, both are silent when wrong, and neither produces anything
that looks broken — a salinity from S/m read as mS/cm comes out near 3, which
is a number. So the unit string is read *and* the values are range-checked,
because believing a units attribute is how this project once drew sea-ice
concentration in the bottom hundredth of its ramp.

**The pressure scale needed a check of its own**, and finding one took a
second look: bar-instead-of-dbar moves density by about half a unit, which
sits comfortably inside any plausible-range test. What does see it is the gap
between in-situ density and sigma0, which *is* the compression — 0.57 kg/m³
over the fixture's 125 dbar dive, a tenth of that if the pressure were read as
bar.

**`saFromSP` returns NaN without an atlas rather than quietly handing back
Reference Salinity**, which is the TEOS-10 package's own refusal and the
reason this had to be handled rather than inherited. The fallback is made
here, counted, and reflected in **what the column is called**: `salinity_absolute`
only when the anomaly was applied to every row, `salinity_reference`
otherwise. The two differ by up to 0.03 g/kg, in the fourth digit, which is
exactly the substitution TEOS-10 exists to prevent.

Position for the lookup is interpolated between surfacings, and that is a
different thing from interpolating a measurement: it is an input to a
4°-lattice lookup rather than a column anybody reads, and a whole dive sits
well inside one cell. It is said in the notes anyway.

## OceanGliders OG1.0

`packages/slocum/og1.ts` maps a decoded table onto
[OG1.0](https://oceangliderscommunity.github.io/OG-format-user-manual/OG_Format.html),
the OceanGliders community's trajectory format (v1.0.0, June 2024). The
spec's own reference examples include `unit_345_20231112T000000_R`, which is a
**Slocum G2** — so this mapping had a worked example of exactly this case to
follow.

**What it claims, and what it does not.** The structure, variables, units and
attributes are OG1.0. The *encoding* is netCDF-3 classic, because a browser
cannot write HDF5 without shipping a megabyte of WASM. So the page says
"OG1.0 structure, netCDF-3 encoding" and not "OG1.0 compliant" — and
`test:slocum-page` fails on any wording that claims compliance outright, which
is the sort of label this project has paid for before. Nothing here has been
through an OG1 validator; the community's own checkers say they are
experimental.

**The CDL export is not the same file in a text wrapper.** OG1 declares its
metadata variables as `NC_STRING`, which classic does not have; the netCDF
export writes them as fixed-width `char` arrays. The CDL declares them as
`string`, which is what OG1 actually specifies, so `ncgen -4 file.cdl -o
file.nc` produces the real thing — **verified**, not argued: `ncgen -4`
compiles it with no output and exit 0, the result is `netCDF-4` with eight
real `NC_STRING` variables and no leftover `STRING<n>` dimensions, and every
value survives the trip (35 numeric variables, 8 string variables and all 36
global attributes identical to the direct netCDF-3 write). `ncgen -3`
refuses it, which is the correct refusal rather than a silent downgrade.

`test:slocum` runs all three of those whenever `ncgen` is on `PATH`, and
prints **`skip`** — never `ok` — where it is not, which is the case in CI.
A check that goes quiet and keeps passing is the shape this repository has
paid for twice. That is why `NcVariable` carries an optional
`strings` alongside its `data`: the semantic content and the classic encoding
of it, so the two serializers differ in exactly the way the formats do rather
than by accident. It is also the form the spec ships its own examples in, so a
diff against them is meaningful.

**Where the spec and its own example disagree, follow the spec.** The
geophysical table gives `CNDC:units = "mS cm-1"`; the Slocum example file
writes `"mhos/m"`, which is S/m and ten times smaller. The normative document
wins — that example also writes `DEPLOYMENT_LATITUDE = "nan"` into a double
and leaves most vocabulary attributes empty. Slocum records S/m, so the
conversion is the ×10 `derive.ts` already makes.

### What the glider does not record

OG1 wants a value at every measurement for four things a Slocum file has
sparsely or not at all. Each is computed and each says so in its own
attributes:

- **LATITUDE/LONGITUDE** — interpolated between the glider's own fixes; the
  fixes themselves go to `LATITUDE_GPS`/`LONGITUDE_GPS`/`TIME_GPS`, which is
  the split OG1 defines those variables for. `test:slocum` holds that
  LATITUDE is filled at every row while LATITUDE_GPS is not, because that
  difference *is* the distinction.
- **DEPTH** — TEOS-10's exact depth-from-pressure, not 1 dbar ≈ 1 m. The gate
  checks the ratio is 0.985–0.998 rather than 1, since equal would mean the
  approximation had crept back in.
- **PSAL** — PSS-78 from the recorded conductivity, temperature and pressure.
- **PHASE**, and the segment and profile numbering that follows from it.

### PHASE, and why the published translation table was not usable here

OceanGliders publishes a table translating Slocum's `cc_final_behavior_state`
into the OG PHASE vocabulary, and using it would be far better than inferring
anything: it is what the glider was *commanded* to do rather than what it
appears to have done. **It is not in these files.** The sensor is in the
cache's namespace and inactive, which is ordinary for the decimated files sent
over Iridium — so the translation is implemented and exercised by a synthetic
case, and the fixture takes the fallback.

The fallback infers from the rate of change of pressure, with the threshold
taken from the data — a quarter of the median absolute rate — rather than
fixed in dbar/s, which would be wrong for a shallow flight and wrong again for
a deep one. `phase_calculation_method` says which route was taken, which is
what that attribute is for.

**The surface threshold is 1 dbar and it is load-bearing.** The fixture
segment surfaces at each end and yo-yos at **3.5 dbar** in between — a glider
dives repeatedly between surfacings to save Iridium time — so the record has
two surfacings and four complete dive-climb cycles, not six of each. A
threshold of 5 dbar takes those inflections for surfacings and triples the
segment count. `test:slocum` pins `SEGMENT_NUMBER` at 2 and `PROFILE_NUMBER`
at 8 for exactly that reason; the dive plot is no help here, since 3.5 dbar of
125 is eight pixels from the top and looks like the surface.

### The metadata, and the form that collects it

Thirty-eight fields, nine of them mandatory. They are declared as **data** in
`OG1_FIELDS` rather than written out as markup, so the form, the validation,
the saved profile and the file all read one list — a field added to the
package appears in the page with no change to the component.

**Nothing identifying is defaulted.** The vocabularies OG1 itself names are
filled in, and the QC statement is one that is true of this decoder; the
glider, the people and the institution are left empty, because a plausible
wrong WMO number is worse than an empty box. `buildOg1` refuses an incomplete
form rather than writing a near-OG1 file, which is the near-miss this package
exists to avoid.

The answers are kept in `localStorage` and can be saved as a JSON profile,
because a deployment's segments share every one of them and retyping thirty
fields per segment is how a metadata standard stops being used. A loaded
profile is filtered to the keys the package declares, so a hand-edited or
older one cannot introduce a field the exporter does not understand.

### Three things the gates had to learn

**The netCDF writer became a document model.** It wrote one fixed dimension of
doubles; OG1 needs several dimensions, scalar variables, and byte, int, float
and char types. `toNetcdf(table)` is built on the new primitive, so the CSV
path is unchanged and `test:slocum` proved it.

**The harness's own netCDF reader only understood char and double
attributes.** OG1 files carry byte flag values and fill values that follow
their variable's type, so the reader threw on the first one — a check that
crashes is at least loud, but it had to learn the other four types before it
could see anything.

**`min-inline-size: 0` was checked by the wrong rule.** The OG1 form rows are
a grid, and a grid item's min-width defaults to the twenty characters an
`<input>`'s `size` implies, so without an explicit zero the last field hangs
out of the panel — and a viewport-overflow scan misses it, because it
overflows its *container*. The first check for it matched `.og1-field input`,
which sets the same property for its own reasons, and so passed with the
container's rule deleted. Anchored to `.og1-field{` now. That is the third
time this masking has appeared here; the other two are in `test:map`.

## The plots the reader configures

**Two plots, one implementation.** X, Y and color are each any column with
enough finite values to draw, each takes a min and a max, and each plot takes
a width, a height, Y-down and Join. What separates them is a **preset** and
nothing else: the dive opens on the whole record against time, joined; the
profile opens on a sensor against depth, as dots.

That split is the same one `/visualization/` and the hurricane page have —
one engine, two pages, differing by which layers they open on — and it earns
its place for the same reason. "The dive plot is the one that cannot be
colored" is an asymmetry nobody can predict from looking at it, and a reader
who wants the dive colored by salinity, or windowed to one yo, is asking a
reasonable question.

The dive preset still does the job the fixed chart did: a wrong cache file
produces a table of plausible floats, and a dive that does not look like a
dive is the fastest way to see it. It is now the plot's *opening state*
rather than its only state.

**Time and depth are axes, not merely columns.** `__time` and `__depth` are
offered in all three menus. Depth is not always a column of its own — a
pressure in bar has to be scaled to read as meters — and without it a reader
would plot against `sci_water_pressure` and get an axis in bar labeled as
though it were depth, which is this project's oldest failure shape.

**A time axis takes its limits as a clock.** Epoch seconds are unusable as a
typed limit, so the two boxes for that axis become `datetime-local` and are
parsed with a trailing `Z` — reading them in the reader's own zone would put
the window hours from where they asked for it. Changing the axis away from
time swaps the boxes back to numbers **and clears them**, because a clock
string in a number box is not a smaller version of a number.

**Y-down and Join follow the axes until the reader touches them**, and then
they are theirs. Depth belongs on a downward axis and a temperature does not;
a time axis has an unambiguous order so joining says something true, where
two sensors against each other do not — a profile is two legs of one dive,
and joining draws a loop across the plot. A control that keeps resetting
itself is worse than one occasionally wrong.

**Dots are drawn whether or not the points are joined**, because the dots are
what carry the color: one path holds one stroke, and a color axis needs one
per bin.

**Reset is per plot and returns that plot to its own preset**, including the
axes. It returned the size and the limits and left the color axis alone at
first — a Reset that half works, which looks exactly like one that did not
work. Caught by the gate, not by looking.

**A limit is a window onto the data, never a rescaling of what survived it.**
Both bounds are computed from the full point set *before* anything is
clipped, so a limit narrows what is shown and leaves the axis numbers
meaning what they said. Points outside are counted and reported in the
caption, because a plot that silently drops half its data looks exactly like
a plot of less data.

**The line lifts its pen over an excluded stretch** rather than drawing a
chord straight across it, which would be a segment the data does not
support. Which plots draw one is the reader's, through the style menu — the
dive *opens* on a line because a time axis has an unambiguous order and the
profile opens on dots because a profile is two legs of a dive over the same
water, where joining in row order draws a loop across the plot. Both are
presets, not properties of either plot.

**Color is the one thing here that cannot be a class**, and that is worth
stating because everything else on this site follows the opposite rule. A
class is right for a *role* — an axis, a tick, a trace — and a theme switch
then restyles it with no redraw. A color axis encodes a *value*, and a
value cannot be named in a stylesheet. So the binned paths and the color
bar carry inline colors, and only the bar's frame is themed.

**One path per color bin, not one per point.** 4,000 dots is 4,000 DOM
nodes and a visible pause; 24 bins is 24 nodes and a step in color no eye
resolves against a continuous bar.

**Twenty color scales, interpolated in sRGB.** Viridis is the default
because it is perceptually uniform and readable in grayscale, which is what a
color axis on a scientific plot owes the reader; the rest are matplotlib's
and cmocean's, and which to read the water with is the reader's call. sRGB
interpolation is a real approximation and a small one at ten stops — the map
package interpolates properly because its colors have to clear a contrast
bar, and nothing on this plot sits over anything else. For the same reason
none of this is `test:contrast`'s business. The tables live in
`packages/slocum/colormaps.ts`; see below for why they are duplicated from
the map's palette and what stops them drifting.

**The charts are stacked, and that is what makes the size control real.**
They were a `2fr 1fr` grid, and a column cannot give a plot the size it was
asked for: the SVG scales back to the column's width whatever its viewBox
says, so the control would have changed the aspect ratio and nothing else.
The `width` and `height` attributes are what set the size; `max-inline-size:
100%` is what stops a reader asking for 1800 px and getting a sideways
scrollbar.

**On a phone the four columns become label-over-controls.** A select and two
limit boxes in a 21.6rem content column leaves each about 4rem, which is
narrower than the numbers in them.

### The color scales, and why they are duplicated

Twenty of them, in two named groups: matplotlib's perceptually uniform set
and the classics, and the eleven from cmocean, which is the family
oceanography reads these fields with. `packages/slocum/colormaps.ts` — no
DOM, so `test:slocum` calls it directly.

**The same twenty are in `packages/ocean-map/data/map-palette.json`**, and
they are duplicated on purpose. Importing the map's palette would make the
decoder depend on the map, and that package is written to be lifted out into
another site and a native app. What stops the two drifting is a check rather
than a promise: `test:slocum` compares every shared name stop-for-stop and
fails on any difference. Same bargain the two `REFRESH_HOURS` copies strike.

**The map's own five are deliberately absent.** They were built to dodge the
map's feature gamut so a marker stays visible on top of them, and that is a
problem this plot does not have: nothing sits over anything else here. The
gate fails if one of them appears in the decoder's list.

**The scale is drawn beside its name**, because nobody remembers what
`cmo.turbid` looks like. And **the color bar is repainted with it** — a bar
still showing the previous ramp would describe a picture that is no longer
on screen, which is the oldest failure shape in this repository.

`sample()` clamps rather than wrapping: a value at or past a pinned limit
takes the end color. Wrapping would put the coldest color on the hottest
point and read as data rather than as saturation.

### How many steps that scale is drawn in

The reader's, from 2 to 256, opening on 24. It was fixed at 24, which is
where the binning came from — one path per step rather than one per point,
because 4,000 dots is 4,000 DOM nodes and a visible pause.

**It is a question about the water rather than about the plot**, which is
what earns it a control. A coarse scale reads a front as a boundary and a
fine one reads it as a gradient; neither is the right answer in general, and
which one is wanted depends on what is being looked for.

**Three things show the scale and all three follow the count**: the dots, the
color bar beside them, and the swatch beside the menu. The bar was drawn at a
fixed 32 against 24 bins of dots, so it was already showing colors the plot
never drew — invisible at a 32-against-24 rounding difference, and a legend
for a different picture as soon as the count could be 5. The swatch is banded
with hard stops at the same midpoints the dots use, so at 256 it is smooth
again, which is the honest rendering of 256 steps.

**Blank means the preset; a number is clamped.** Told `0`, jumping back to 24
would be a control silently disagreeing with its own box, so it goes to the
floor — as near to what was asked for as can be given. Zero steps divides by
zero and ten thousand is a DOM node per point, which is the pause the binning
exists to avoid.

`test:slocum-page` sets 5 and 40 and requires the bar, the distinct dot
colors and the swatch to move together, holds the clamp at both ends, and
pins the default. The dot colors are held to `<=` the count rather than `=`:
a bin with no points in it draws nothing, which is ordinary. Mutation-tested
against a fixed-32 bar and against a swatch that ignores the count.

### Hovering a point names it

X, Y and — when there is one — the color value, in a box beside the pointer,
with a ring on the point being described.

**The search is numeric, not a hit test.** The dots are a path per color step,
so there is no element per point for `elementFromPoint` to return; the draw
records where it put each point and the readout scans for the nearest. At
most 4,000 candidates, which is a small fraction of a frame.

**It is HTML over the chart, not SVG inside it.** `standaloneSvg` serializes
the chart's own markup for the PNG, so a marker drawn inside would be
composited into every saved figure — a pointer artifact in a paper.

**Everything goes through the SVG's own scale.** `max-inline-size: 100%`
means a wide plot in a narrow window is drawn smaller than its viewBox, so a
CSS pixel is not a plot unit. Assuming it was would put the readout further
from the pointer the narrower the window got — and the readout is verified at
a scale of 0.002, which is a stronger test of that conversion than a 1:1 case
would be.

**Nothing sizes the positioning frame, and that is deliberate.**
`inline-size: max-content` was the first idea, so the frame would hug the
chart. It sets up a cyclic dependency — the SVG's `max-inline-size: 100%` is
a percentage of a box that is asking the SVG how wide it wants to be, which
intrinsic sizing resolves as zero. It buys nothing anyway: every coordinate
the readout uses comes from the SVG's own rect, so it is clamped to the
picture whatever the frame does.

**Out of reach reports nothing.** A readout that follows the pointer into
empty space names a value for water that was never sampled there. The
threshold is 18 screen pixels, measured on screen so it means the same thing
however far the plot has been scaled down.

**A redraw clears it**, or it goes on describing points that have been
replaced — the same staleness the color bar has a note about, one control
along. Mutation-tested both ways: dropping the reach test reports a point
from the far corner, and dropping the clear leaves a stale reading over a
redrawn plot.

### A limit box changes type, and the CSS has to follow

Reported from Safari: the two time boxes on the X row overlapping each
other. The sizing rule was `.plot-controls input[type='number']` — and the
type *changes at runtime*, to `datetime-local`, the moment that axis is set
to time. So the rule stopped matching exactly the control that needed it,
which was then left with no `min-inline-size` and a UA intrinsic width wider
than its column.

**How much wider is the browser's business** — Safari's date field is about
twice Chrome's — so the fix is not a bigger fixed width. The two limit
columns are `minmax(6rem, auto)` and the date field takes what it needs;
measured in Chrome, a time axis widens them from 147px to 185px and a
Safari-width control would widen them further on its own.

**And the same fixed width was left behind in the media query**, which is
why it was reported a second time from an iPhone in portrait. The phone
layout still pinned the two limits to `5rem` each. On a phone there is no
room to widen them in place, so the axis menu takes the whole width and the
two limits get a line of their own: 164px each on a 375px phone against the
80px they had. `min-inline-size: 0` is not enough on its own, because a UA
date control has a minimum it will not shrink below whatever the CSS says —
the fix is room, not a smaller box.

Both are decided over the built stylesheet in `test:slocum-page`, because
jsdom does no layout and cannot see two controls sitting on top of each
other. Mutation-tested by restoring each fixed width.

This is the *rule that cannot match the thing it was written for* from the
list in the root `CLAUDE.md`, in a new form: not a scope boundary but an
attribute the code itself rewrites.

### And the same control caught a third time, on the event

Reported as a date range that changed nothing: with X set to Time (UTC),
typing a window left the plot exactly as it was.

The limit boxes listened for `input` alone, which the comment above them
justified — a limit takes effect as a figure is typed rather than waiting for
the box to lose focus. That is right for a number box. **Safari commits a
date control with `change` and does not fire `input` at all**, so on that
browser the value sat in the box and nothing read it. They listen for both
now.

Two things about finding it are worth keeping. The logic was correct
end to end — reproduced in a browser by setting the value and dispatching
`input`, where the axis moved and 720 points were reported outside the
limits — so reading the parsing, the clamping and the projection found
nothing, because none of them was wrong. What settled it was dispatching
`change` alone and watching the axis stay put. **When every step of a
calculation is right and the answer never arrives, the fault is upstream of
the calculation.**

And it is the third bug on this one control, all from the same root: a limit
box changes its `type` at runtime, so anything keyed to the type — a CSS
selector, twice, and now an event — silently stops applying to the control it
was written for.

`test:slocum-page` drives it with `pick`, which fires `change` and nothing
else, and clears the boxes first so the check is against the automatic range
rather than against limits already set — otherwise it would pass on a page
that ignored `change` entirely. Mutation-tested by restoring the `input`-only
binding, which reports the axis unmoved.

### Saving a plot as a PNG

A button per plot, beside Reset, at **twice** the plot's own size — the
figure is for a slide or a paper, at 1x it is what a screenshot already
gives, and a doubled raster downscales to anything the screen-size one
served while the reverse is not true. The reader's width and height still
set the shape; the scale only decides how many pixels it is drawn with.

**Styling does not travel with a serialized clone**, which is the whole of
the work. The axes, the ticks and the line take their stroke from a class,
and a class means nothing once the markup is out of the page — the file
would open as unstyled shapes. Every computed value is read off the live
element and written onto its copy; read, never re-derived, because a second
opinion about a color would put something in the file that was never on
screen. The dots need no help: their color and size are already inline, for
the unrelated reason a class rule beats a presentation attribute. Same trap
the map's PNG export has a paragraph about, met in a much smaller place.

**The background is painted before the image is drawn.** It is a CSS
property of the element rather than part of the SVG's content, so a
serialized clone has none and the PNG comes out transparent — which looks
black in most viewers and white in others, neither being the plot. Read
from the live element, so an export follows the theme: measured, light gives
`241,241,236` and dark `25,30,38`, with identical ink either way.

**The color bar names its variable now**, and that was a gap the export
exposed rather than created. The bar said what the colors meant but not
what they were *of* — the caption was carrying that alone, and a caption
does not travel into a PNG.

`document.fonts.ready` is awaited first: a canvas does not take part in font
loading the way layout does, and text drawn against an unresolved face is
measured against a different one.

**The rasterising cannot be gated**, because jsdom has no `Image` and no
`canvas.toBlob`. What `test:slocum-page` checks is the button, and that a
failure is *reported* rather than swallowed — jsdom rejects its own Blob in
`URL.createObjectURL`, so the export fails there, and that failure reaching
the note is the evidence the serializing and naming ahead of it ran.
Verified in a browser by reading the PNG back and sampling it: 1280x840
from a 640x420 plot, opaque, with ink in every place the axes, the tick
labels, both axis names, the color bar and its label are drawn.

### What a reload keeps

Reported: every plot went away on reload and nothing had been kept. The
sensor-list caches were held from the first version and the data was not,
which is the worst of both — the reader is handed an empty decoder with no
sign that the hard part is still remembered.

**Two stores, because the two things are different sizes.** The files go in
IndexedDB beside the caches (version 2 of the same database, which creates
whichever object stores are missing so a reader upgrading from version 1 is
not asked to start over). The reader's own setup — both plots, and the three
choices that shape the table they draw from — is one small JSON object in
localStorage, which has to be readable synchronously, before the first draw.

**Bytes, not the decoded table.** A decode is 40 ms and a table is far
larger than the file it came from. The restore runs the bytes back through
the same `take` a drop takes, so there is one decode path and one set of
rules about what a file needs.

**A saved axis the new files lack does not take.** A plot can only be set to
something its menus offer, so `seed` holds the state until the first
`rebuild` has filled them, and a stale or hand-edited choice falls through to
the preset instead of leaving an empty plot with nothing to say why. The
limit boxes are typed *before* their values go in, or a saved clock lands in
a number box and is dropped.

**Two ways out, because the two halves are not equally cheap to get back.**
A cache lives in the glider's `cache` directory, which the file dialog cannot
reach in the same pick as the data, so a reader working through the segments
of one glider — or across its missions — wants the data gone and the caches
kept, every time. `Clear the data files` does exactly that and nothing else;
`Forget everything, caches too` takes the files, the caches and the saved
view. Two buttons rather than one with a modifier nobody would find.

**And a third way, which is neither of those: one deployment at a time.**
Both buttons above are all-or-nothing, and the reader this page is for works
through several of a glider's missions — or several gliders — and finishes
with one of them at a time. Without this, being rid of one means clearing the
lot and re-adding the rest. `Remove this one` sits beside the deployment
picker and takes the deployment on show.

It appears with the picker, so it is offered only where there is more than
one deployment; with a single one it would be `Clear the data files` under
another name.

**It removes the files from the store, not only from the page.** Removing
them from the page alone looks right until the next visit, when the restore
reads the store and brings the deployment back — a deletion that undoes
itself is worse than none, because by then the reader has stopped expecting
it to be there. That is the failure `test:slocum-page` is written against,
and the fixtures being a single deployment does not weaken it: what the check
exercises is the mechanism and the reopen, which is the half a
multi-deployment fixture would not test any better. Mutation-tested by
dropping the store deletion, which fails both the count and the next visit.

A file still waiting for its cache belongs to no deployment yet, so it is not
caught by the segments — but if its name is one of those going, it goes too,
or it reappears the moment its cache does.

No confirmation, on the same reasoning as the two buttons beside it: what is
removed is the reader's own files, which are still on their disk, and the
picker names the one that will go. What it does say afterwards is what went
and how many files that was.

**The plot setup survives the data-only clear, and that is the point** rather
than an oversight: the next segment off the same glider has the same sensors,
so the axes still resolve and the next files come up drawn the way the last
ones were. Verified — clear the data, drop the next segment with no `.cac` at
all, and it decodes against the stored caches straight into `cmo.haline`.

**The data-only button never appeared at first, and the caches button hid
it.** `showCaches` is called after the caches are stored and *before* any
file is decoded, so `decoded` was still empty and the button hid itself.
`Forget everything` showed anyway — it is offered on the caches alone — so
the fault looked like nothing. It is called again once the decode is done.
Caught by a check that asserts the button is *offered*, added only because a
mutation survived: every other check clicked it directly, which cannot see a
button nobody can reach.

### The picker is a catalog; the table is a view of it

The table is built from the *selected* sensors, deliberately: the rows are
the union of their times, so a one-sensor export is not thousands of rows
nothing fills. Two bugs came out of that, and the second was mine, made
while fixing the first.

**A derived column has to keep its inputs.** The seawater columns are
computed from the table this builds, so narrowing it to the selection took
the CTD out from under a salinity the reader had ticked and the derived
columns silently vanished — reported as the preview dropping from four
columns to two the moment an unrelated `m_` sensor was ticked, with a note
claiming the files carried no conductivity. `isSeawaterInput` is exported
from `derive.ts` rather than the CTD names being written out again here, and
the inputs are kept **when a derived column is selected** — not merely when
the box is ticked, or a one-sensor export would drag the whole CTD's rows
along behind it. Both halves are mutation-tested.

**And the picker must not shrink with the table.** Redrawing it from the
narrowed build lost 59 of 69 sensors with no way to tick one back, which is
worse than the bug being fixed. The picker lists a `catalog` of every
sensor these files have ever shown, accumulated across builds; the table is
one view of it. Derived columns are the exception and are replaced rather
than accumulated, or unticking the box leaves six labels that tick to
nothing.

**Found by running the reported sequence in a browser, not by any check.**
The gate was green through both. It now drives the whole sequence — select
none, tick three derived, tick one engineering sensor — and holds the
column count, the row count, the notes, the picker's length against its own
count, and what unticking the box removes.

### The plot styles, the point size, and the order of the menus

Three things reported together, all about reading the plot rather than
computing it.

**Scatter, line, or both**, as a menu rather than the Join checkbox it
replaced. The checkbox could not say "line only", and — more to the point —
a checkbox does not tell the reader what the two states are. A time axis
opens on *both*: a line through an ordered axis says something true, and the
dots are what carry the color, so `line` alone has nothing to paint. That
is why the default for a time series is `both` and not `line`.

**The point size is the reader's**, because "too small" is a property of the
screen and the point count rather than of the data. It persists like
everything else, so one adjustment sticks.

**The menus are ordered `sci_`, `m_`, `c_`, then the rest, alphabetically
within each.** That is not the table's own order — the columns are ordered
for *reading*, named quantities first and then by how populated they are,
which is right for a table and unfindable in a menu of sixty entries. A menu
is searched rather than read, so the only thing it owes is that a name is
always in the same place. The prefix ranking is the order an operator looks
in: what the science computer measured, then the flight computer, then what
was commanded on it, then the engineering channels nobody opens this page
for.

**The sensor picker takes the same order**, and needs it more: a deployment
can put four hundred columns in that list, where fill-descending reads as no
order at all. **It is the picker and not the file** — `exported()` filters
`table.columns`, so the CSV and the netCDF keep the order they were asked
for. Two jobs, two orders, and the gate holds them apart by reading the CSV
the button actually writes.

That check had to be rewritten to be worth anything. The first version read
the *preview* headings, which are drawn from the table directly and cannot
see the export path — it passed with the export deliberately reordered. The
second failure was quieter: the derived-column case ran before the seawater
box had been ticked, so the mutation it was written for was unreachable.
Both are the same lesson as everything else in this file — check the thing,
in the state where it can be wrong.

### The gate had to learn to run the page

`test:slocum-page` read the built output and called the package directly; it
never executed the page's own script, so every piece of the interface was
ungated. A plotting feature cannot be checked that way at all — the controls
would be in the HTML and the CSS would be anchored while the SVG showed
something else entirely.

It imports the bundle into Node's realm now, the way `test:seawater` and
`test:map` already do, hands it the fixtures and drives the controls. Two
things made that cheap: `indexedDB` is absent in jsdom and the cache store
already resolves `null` rather than throwing, which is the private-browsing
path; and the page reads a file with `.name` and `.arrayBuffer()` and
nothing else, so a plain object is a File as far as it is concerned —
jsdom's own `File` is not, since its `arrayBuffer` does not round-trip these
bytes.

Mutation-tested fifteen ways, each caught by the check meant for it:
ignoring the limits, ignoring the size, one color for every point, a Reset
that leaves the limits set, a Reset that leaves the color axis set, the
dive losing its time axis, time limits staying numeric, a time limit read in
local time, both plots sharing one preset, nothing saved, saved state never
read back, a saved axis applied without checking the menu offers it, the
point size ignored, the menus keeping the table order, and every style
drawing both.

**`localStorage` has to be stubbed or the persistence checks test nothing.**
Node has none without `--localstorage-file`, and the page wraps every
storage call in a try/catch so private browsing still gets a working
decoder — so without a stub every save is swallowed and every check passes
against a feature that never ran. `test:seawater` has a note about the same
trap.

**The file half needed a real IndexedDB, and `fake-indexeddb` is one.**
Deleting `rememberFile` used to survive every check here, because jsdom has
no IndexedDB and the store's own try/catch takes the private-browsing path —
so nothing was written, nothing read back, and no check could tell a working
`rememberFile` from a deleted one.

It is a devDependency, and the same category as jsdom itself: the
no-dependency rule governs `packages/`, which is served to readers, and this
never leaves the harness. With it, `reopen({ feed: false })` loads the page
a second time and hands it **nothing** — everything that comes back came out
of storage. Five mutations are caught that were not: files not remembered,
files never recalled, Forget clearing one store, the version upgrade
dropping the existing store instead of adding the missing one, and
connections left open.

**That last one was a real bug in the page, found by the harness needing
`deleteDatabase` to work.** `withStore` opened a connection per call and
never closed one, and an open connection blocks every later *version*
change. Nothing noticed while 2 was the newest — a same-version open is not
blocked — so it would have surfaced as a hang on whichever version came
next, for exactly the readers who had something stored. It closes after each
operation now, and `onblocked` resolves rather than waiting.

Two things in the harness had to move for this. `save()` schedules a revoke
ten seconds after a download, and a run long enough to reach it died on an
unhandled timer — jsdom's `URL` has no `revokeObjectURL`. And the bundle
reads the bare `location` global, which Node's realm does not have; jsdom's
`reload()` is read-only but does not throw, so Forget's two store clears run
and the navigation is a no-op.

**One of those cannot fail in CI, and the check says so.** Reading a time
box as local rather than UTC gives the same answer on a machine that is on
UTC, which CI is. It was mutation-tested here, on `America/New_York`, and
the check asserts the machine-independent half — that the limit reaches the
axis at all.

## The page is full width, and the rule for that cannot live on the page

The text *is* this page — there is no map — so the prose and the tool run the
whole window rather than sitting in a 72rem column with empty screen either
side. `.container.wide` already drops the container's cap, but it re-applies
`--content-width` to every child, which is right for a page built around a
figure and wrong here.

**The rule that undoes that is in `global.css`, and that is not a preference.**
Written on the page as `.slocum > *`, Astro scopes it to
`.slocum > *[data-astro-cid-<page>]` — and the decoder is a component, so its
root element carries a *different* cid and the selector cannot match it. The
prose went full width while the tool below it kept the cap, which reads as a
broken layout rather than a decision. `.container.wide.full > *` lives beside
the rule it overrides, at the same three-class specificity and after it, so it
wins on order and reaches across the scope boundary.

Same trap as the section below, met from the page side rather than the
component side.

## A stylesheet that could not match what it was written for

**The worst bug this page shipped, and it is a new shape for this file.**

Astro scopes a component's styles by stamping a `data-astro-cid-…` attribute
onto the elements in its **markup** and rewriting every selector to require
it. An element built later by `createElement` never gets that attribute, so a
scoped rule **cannot match it** — and nothing errors. The two charts rendered
as solid black blobs, because an SVG `<path>` fills by default; the sensor
list, the preview table, the notes and the summary all came out with browser
defaults.

It was found by reading `getComputedStyle` in a browser, not by looking:
unstyled chrome looks like a design decision. The fix is a
`<style is:global>` block with every selector anchored to `[data-slocum]`,
which is in the markup, so the rules reach the runtime elements without
leaking to the rest of the site.

`test:slocum-page` decides that over the **built stylesheet**, the same tactic
`test:map` uses for the three CSS faults jsdom cannot render its way to: every
rule for a runtime-built element must be global and anchored, none of them may
be written bare, `[hidden]` must still beat the class that sets `display`, and
the chart paths must declare `fill: none`. Mutation-tested — reverting
`is:global` fails it.

**And the `appearance: none` check had to be anchored too.** `builtCss`
concatenates every stylesheet in `dist`, and the map alone carries four
`appearance: none` declarations, so an unanchored search passed with this
component's deleted. The same masking `test:map` already has a note about,
met from a different direction.

Two smaller things the browser found and no gate could:

- **The depth axis label read `25.2447` for a 125 m dive.** The tick text is
  drawn outside the plot area, and the gutter reserved for it was narrower
  than the string, so the leading digit was clipped by the viewBox — a chart
  reporting a fifth of the dive it had just drawn. Widened, and the labels now
  round to a width that fits rather than printing four decimals.
- **The profile chart was correctly empty and looked broken.** In a union
  table the flight computer's `m_pressure` and the science computer's
  `sci_water_temp` share no row at all, so picking a depth column by name
  order gave a plot with nothing in it. The depth that goes with a sensor is
  the one written on the same cycles as it, so the candidates are scored by
  co-occurrence rather than ranked by preference.

## A file that cannot be read

Two failures that ended the same way — a page still saying "Reading…", with
nothing on it naming the file that stopped it.

**`take` was called as `void take(...)` from all four entry points**, so
anything it threw became an unhandled rejection. The decompression of a
compressed cache was the one read outside the per-file `try`, and `.ccc` is
LZ4: a truncated one throws. So did a file the browser could no longer read
between being picked and being opened. **The startup restore is the bad
version of it**, because the stored file is read again on every visit — the
page would come up stuck, every time, with the Forget button the only way
out.

It is `readAll` inside a `try` now, and the cache loop catches per file so
one bad `.ccc` does not cost the reader the others. The rule this page keeps
everywhere else is that what could not be read is *counted and named*; this
is the outer edge of it.

**And `report()` built its lines with `innerHTML`.** A decode failure is
reported as `${name}: ${message}`, so a file named `<img src=x onerror=…>.sbd`
put a live element on the page. The reader picked the file — and a deployment
directory arriving from a colleague or a portal is the ordinary way this page
is used, which is exactly the input `kmz.ts` already refuses to trust with
its descriptions. Nodes now; `<code>` around a CRC is the only markup any of
those lines wanted, so it is the only markup built.

`test:slocum-page` drives both, and both are mutation-tested against the
faults they were written for.

Three smaller things went with them:

- **A quota refusal was silent.** `withStore` resolves `null` rather than
  rejecting — which is what lets private browsing get a decoder that works
  and forgets — but `rememberFile` discarded that, so a deployment too large
  for IndexedDB was accepted with a promise the page could not keep. It
  returns a boolean and the caller reports it.
- **`recallCaches` paired `getAllKeys()` with `getAll()` across two
  transactions** and matched them by index. A write from a second tab — which
  is ordinary here, a reader opens one per segment — shifts one array against
  the other, and a cache filed under the wrong CRC is the failure this
  decoder has least defense against: it parses, and only the counts disagree.
  One cursor, one transaction.
- **Files are held by name**, which is right for the full Slocum names and
  wrong for the 8.3 names a dockserver also writes: `02150008.sbd` is a name
  two vehicles can both have, and splitting deployments means two gliders in
  one drop is a supported case. A clash is now reported rather than silently
  resolved in favor of whichever arrived second.

## What it does not do

It reads files; it does not process them. No thermal-lag correction, no
despiking, no quality control, no gridding, and it does not write the IOOS
Glider DAC's trajectory format. Position is converted from NMEA and otherwise
left as the glider dead-reckoned it.

And it is checked against **one glider and one deployment**, which is the
honest limit when the only thing to check against is another reader.
