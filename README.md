# Gliders

Maps, sections, profiles and T–S diagrams for any glider deployment on the
[IOOS Glider DAC](https://gliders.ioos.us/erddap/) — and for raw Slocum
files, read on your own machine.

**https://oceansensing.org/gliders/**

A static site. There is no server, no database and no precomputed figure:
your browser asks the DAC for the profiles and draws them, and the derived
seawater properties are computed from TEOS-10 as you look at them.

## What it shows

For a deployment:

- **The track**, coloured by time, over a bathymetric basemap.
- **A T–S diagram** in Absolute Salinity and Conservative Temperature,
  coloured by depth, with σ₀ isopycnals traced behind the points.
- **Sections** against time and depth of everything the deployment carries —
  temperature, salinity, conductivity, oxygen, chlorophyll, CDOM, backscatter,
  and every flight-computer channel — plus the properties computed here:
  Conservative Temperature, Absolute Salinity, potential temperature,
  in-situ density, potential density anomaly σ₀, spiciness π₀ and sound speed.
- **A profile explorer** that loads a chosen time window at full resolution.

Any variable can go on any axis, with its own colour scale and window. Every
figure exports a PNG.

For raw Slocum files (`/local/`): the same figures, from `sbd`/`tbd`/`dbd`/
`ebd`/`mbd`/`nbd` files and their compressed forms, decoded in the tab.
Nothing is uploaded.

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
| `packages/erddap` | the tabledap client: catalog, dataset metadata, chunked and decimated fetching, QARTOD filtering |
| `packages/plot` | the SVG scatter/line engine with a colour axis, and 20 colormaps |
| `packages/teos10` | TEOS-10 evaluated from the Gibbs function, with the measured salinity-anomaly atlas |
| `packages/slocum` | the Slocum dinkum-binary decoder |

`teos10` and `slocum` are **copies** of the packages behind
[oceansensing.org](https://oceansensing.org/data/slocum/), which is where
they are maintained; `check:vendored` reports when they drift.
`packages/plot` was extracted from that site's Slocum decoder, where the
same engine draws the same kind of figure.

The two data paths meet at one interface: a map of `Float64Array` columns
and a list of what can be plotted. The DAC path and the Slocum path both
produce one, which is why the same map, sections, T–S diagram and profile
explorer serve both.

`CLAUDE.md` records the measurements the design rests on — what a request to
the DAC actually costs, why the windows are sized by time rather than rows,
and the failures that were found by running it.

## Licence

See `LICENSE` — the same terms as the rest of the C4PO site: public so it can
be served and inspected, not a grant of permission to reuse.

The observations are not ours and are not redistributed here: every profile
is read from the IOOS Glider DAC as you look at it, and remains the work of
the operator named on the deployment.
