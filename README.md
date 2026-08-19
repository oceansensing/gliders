# Gliders

Maps, sections, profiles and T–S diagrams for any glider deployment on the
[IOOS Glider DAC](https://gliders.ioos.us/erddap/) — and for raw Slocum
files, read on your own machine.

**https://oceansensing.org/gliders/**

A static site. There is no server, no database and no precomputed figure:
your browser asks the DAC for the profiles and draws them, and the derived
seawater properties are computed from TEOS-10 as you look at them.

## What it shows

### Every deployment, on one map

All 2,534 deployments back to 2003, searchable by glider, institution or
year. The map draws each mission's **actual track**, coloured on a shared
clock so two gliders out the same season look alike and a 2019 deployment
does not, with a dot at each glider's last known position. Click any track to
open it.

### One deployment

- **The track**, coloured by any variable the mission carries — temperature,
  salinity, σ₀, chlorophyll — with your own colour scale and range.
- **A T–S diagram** in Absolute Salinity and Conservative Temperature,
  coloured by depth, with σ₀ isopycnals traced behind the points.
- **Sections** against time and depth of everything the deployment carries,
  plus the properties computed here: Conservative Temperature, Absolute
  Salinity, potential temperature, in-situ density, σ₀, spiciness π₀ and
  sound speed.
- **Two profile panels** side by side, so temperature can be read against
  salinity.

Narrow to any stretch of the mission with the clocks at the top or by
**dragging across a section**, and it reloads at finer resolution — at full
rate if the window is small enough. Every view is a link.

### Raw Slocum files

Drop `sbd`/`tbd`/`dbd`/`ebd`/`mbd`/`nbd` files and their `.cac` sensor lists
on the [local files](https://oceansensing.org/gliders/local/) page and get
the same figures. Nothing is uploaded; the decode happens in the tab.

### Taking figures away

Every figure and the map export a **publication-quality PNG** — 3×
resolution, title and caption drawn in, boxed, on white, and for the map the
colour bar and basemap attribution too.

## Running it

```bash
npm install
npm run dev
```

```bash
npm run verify
```

`verify` builds, type-checks and runs every test. It needs no network: each
suite reads a committed fixture.

| command | what it does |
|---|---|
| `npm run dev` | the site, at `/gliders/` |
| `npm run build` | static output into `dist/` |
| `npm run verify` | build + check + every test |
| `npm run data:deployments` | refresh the offline catalog snapshot |
| `npm run check:vendored` | report drift in the copied packages |

## How it is put together

Astro 7, static output, no front-end framework — vanilla TypeScript in
component scripts, Leaflet for the maps. Four workspace packages:

| package | what it is |
|---|---|
| `packages/erddap` | the tabledap client: catalog, metadata, chunked and decimated fetching, QARTOD filtering |
| `packages/plot` | the SVG scatter/line engine with a colour axis, 20 colormaps, and the PNG export |
| `packages/teos10` | TEOS-10 evaluated from the Gibbs function, with the measured salinity-anomaly atlas |
| `packages/slocum` | the Slocum dinkum-binary decoder |

`teos10` and `slocum` are **copies** of the packages behind
[oceansensing.org](https://oceansensing.org/data/slocum/), where they are
maintained; `check:vendored` reports when they drift. `packages/plot` was
extracted from that site's Slocum decoder.

The two data paths meet at one interface — a map of `Float64Array` columns and
a list of what can be plotted — which is why the same map, sections, T–S
diagram and profiles serve both the DAC and a decoded file.

`CLAUDE.md` records the measurements the design rests on: what a request to
the DAC actually costs, why the depth bin is chosen per glider, why colour
limits are percentiles, and the failures that were only found by running it.
`PLAN.md` says what is built, what was decided, and what is still open.

## Licence

See `LICENSE` — the same terms as the rest of the C4PO site: public so it can
be served and inspected, not a grant of permission to reuse.

The observations are not ours and are not redistributed here: every profile
is read from the IOOS Glider DAC as you look at it, and remains the work of
the operator named on the deployment.
