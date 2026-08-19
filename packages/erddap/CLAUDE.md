# @c4po/erddap

Reading glider deployments off an ERDDAP tabledap server. Written against the
IOOS Glider DAC (`gliders.ioos.us/erddap`, ERDDAP 2.30) — the only server it
is tested against, though the base URL is a parameter everywhere.

Everything below was **measured against the live server**, not read out of the
documentation, and several of the measurements contradict what the obvious
design would have assumed.

## The economics of a request, and why the first plan was wrong

Measured on `electa-20260807T1633` — 11 days, 142,378 rows, 2,083 profiles,
coastal Mid-Atlantic, 172 m deepest:

| request | bytes | wall |
|---|---|---|
| whole deployment | 11.3 MB | 14.8 s |
| whole deployment, `orderByClosest("time,depth/5")` | 1.6 MB | 15.3 s |
| one day | 0.58 MB | 1.1 s |
| one day, depth-binned | 0.09 MB | 1.2 s |

Two facts fall out, and the second one is the load-bearing one:

1. **Depth-binning works and preserves the section.** 142,378 rows collapse to
   18,675 — one sample per 5 m per profile — and the section, the T–S diagram
   and the track all look the same. This is the overview resolution.
2. **Server time scales with the span asked for, not with the rows returned.**
   The bin happens *after* the read, so binning the whole deployment costs the
   same fifteen seconds as not binning it. About **1.35 s per day of
   deployment**, near enough linear, with no meaningful fixed overhead.

Which is why `fetch.ts` sizes its windows by **elapsed time** and not by row
count. The first version sized by rows, which is the design anyone would
write down first and which fails precisely because of (2): fed a binned
request, the estimator sees a low row rate, concludes a 30-day window is
affordable, and the reader waits eleven seconds for the back half of an
eleven-day mission. Rows are a proxy for server cost that binning breaks.

Sizing by a six-hour probe and scaling by how long the probe took, against
the same deployment and the same 18,661 rows:

| planner | first paint | total |
|---|---|---|
| by rows (2 chunks) | 3,197 ms | 14,273 ms |
| by elapsed time (15 chunks) | **925 ms** | **6,100 ms** |

**Concurrency is 3, and more does not help.** Four parallel one-day requests
measured 4.3 s wall against ~4.4 s of serial time — the server queues rather
than parallelises. The concurrency is there so a request is in flight while
another is being parsed; raising it only lengthens the queue in front of the
chunk the reader is actually waiting for.

## An empty result is an HTTP 404 — and a browser cannot read it

`GET …/tabledap/<id>.csv?…` matching no rows returns **404** with a body
containing `message="Not Found: Your query produced no matching results.
(nRows = 0)"`. Not an empty 200.

This is the one that silently breaks a chunked fetcher: a deployment with a
gap in the middle — a glider on the surface, a day of no telemetry — produces
a window with no rows, and a client that treats 404 as a transport failure
reports the whole deployment as broken.

**And then it gets worse in a browser.** The CORS header is on the
*successful* responses only:

```
200 →  Access-Control-Allow-Origin: *
404 →  (no such header)
```

So the browser blocks the error response before any code here sees it, and
`fetch` rejects with a bare `TypeError: Failed to fetch` — no status, no
body, nothing to distinguish "this window is empty" from "the server is
down". `ErddapError.empty` therefore only ever fires under Node, which is
where the tests run and where this was first (misleadingly) confirmed
working.

Verified against the live server on a real gap in `electa-20260807T1633`:
the window `2026-08-17T23:45:43Z … 2026-08-18T00:16:49Z` returns 404 for
`time,temperature`, and the browser reports it as a CORS failure.

What `fetch.ts` does about it:

- a chunk that cannot be read at all is recorded as **empty and
  `unreadable`**, not as a failure;
- `partial` is set, and the page says some windows returned nothing and that
  it cannot tell which reason;
- **only if every window was unreadable and nothing arrived** does
  `fetchData` throw — one request cannot tell a gap from an outage, but the
  whole set can.

The honest sentence on screen is the point: "either the glider reported no
data through them, or the server would not answer for them" is what is
actually known, and picking one would be inventing the other.

## `allDatasets` is a dataset, and takes no paging

The catalog is a real tabledap table with a row per active dataset, so it
takes constraints like any other (`maxTime>=…` for "still reporting"). It
does **not** take `page` or `itemsPerPage` — those belong to the HTML search
form, and passing them to tabledap is a 400 rather than an ignored parameter.

It carries a row for **itself**, which is dropped: left in, the browser page
puts a fake glider at the null island.

There is no working `orderByCount` shortcut for a row count, either.
`orderByCount("time")` returns the distinct profile times — 830 lines for a
two-month mission — rather than a count.

## Times are always strings

Even in `.json`, even though `time` is a `double` with
`units=seconds since 1970-01-01T00:00:00Z`, the wire format is
`2026-08-10T00:03:51Z` and `columnTypes` says `String`. There is no flag to
get epoch seconds out. So every row's timestamp is parsed, which is why
`url.ts` reads the digits by position rather than calling `Date.parse` — the
format is fixed-width and the server emits nothing else, with `Date.parse` as
the fallback for the rare dataset that publishes fractional seconds.

Missing values arrive as `null` in `jsonlCSV` and as an empty field in `csv`.
`jsonlCSV` is used for that reason among others: an empty CSV field has to be
*known* to mean missing rather than zero, and getting that wrong draws a line
through zero where a record has a gap.

## Schema variance across the archive

The core is stable and can be relied on: `time`, `latitude`, `longitude`,
`depth`, `pressure` (dbar), `temperature` (°C, ITS-90), `salinity`
(practical), `conductivity` (S m⁻¹), `density`, `precise_time`,
`precise_lat`, `precise_lon`, `u`/`v`. Present on both a 2018 dataset and a
2026 one.

What varies:

- **QC families.** 2026 datasets carry `qartod_<var>_primary_flag` plus one
  column per test. The 2018 dataset carries those *and* the older
  `<var>_qc`. `qcColumnFor` prefers the primary flag, which is the roll-up.
- **QC may be entirely unpopulated on a realtime dataset.** Every
  `qartod_temperature_primary_flag` on `electa` is `null` at the time of
  writing. Filtering must therefore be a no-op on NaN, not a rejection —
  `applyFlags` only acts on a flag that is a finite number.
- **Variable count.** 126 on `electa` (a full Slocum flight-computer dump),
  73 on the 2018 dataset. Of `electa`'s, 26 are flags.

`ioos_category` is filled in across the DAC and is what separates a science
variable from chrome. Flight-computer variables (`commanded_*`, `measured_*`)
are deliberately **kept plottable** — a pilot reading a mission wants
`measured_avg_climb_rate` against depth — and merely sorted below the science.

## Units, and the one that matters

`pressure` is **dbar** and `temperature` is **ITS-90 °C**, which is what
TEOS-10 wants, so the ERDDAP path needs no unit conversion. This is worth
stating only because the *other* path into this site does: raw Slocum files
carry conductivity in S/m and pressure in bar, both a factor of ten from what
TEOS-10 expects and both silent when wrong. `@c4po/slocum`'s `derive.ts`
handles that; nothing in this package should grow a copy of it.

## Fixtures

`scripts/fixtures/erddap/` holds real responses captured 2026-08-18:
`catalog.json`, `info-electa.json` (2026, 126 vars), `info-amelia-2018.json`
(2018, 73 vars, legacy QC), `rows-electa.jsonl` (163 binned rows including a
`null` flag column and a `null` measurement). The tests run against these with
no network.
