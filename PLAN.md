# Where this stands

A working record of what is built, what was decided and why, and what is
still open. `README.md` is for someone using the site; `CLAUDE.md` is for
someone changing it; this is for picking the work back up.

**Live at https://oceansensing.org/gliders/** — GitHub Pages from `main`,
deployed by `.github/workflows/deploy.yml` on every push. `npm run verify`
gates the deploy and runs entirely offline.

---

## Built and shipped

### The catalog page (`/`)

- All 2,534 DAC deployments, live from `allDatasets` (572 KB in 0.25 s), with
  a committed snapshot in `public/data/deployments.json` as the offline
  fallback.
- Search over id/title/institution, year filter, active-only toggle, sortable
  table, 300 rows at a time with the remainder counted.
- **Real mission tracks** on the map, one fix per six hours, coloured on one
  absolute clock shared by all of them, capped at 60 and fetched six at a
  time. Archived tracks cached in `localStorage`.
- A dot at each glider's last known position, styled active vs archived.
- Clicking a track or a dot opens that deployment.

### The deployment page (`/deployment/?dataset=<id>`)

- Chunked, progressively rendered load with a working Stop button.
- **Adaptive depth binning**: 1 m by default, coarsened through 2/5/10 m only
  if the mission would blow the row budget; a chosen time window starts the
  ladder at full rate instead.
- **Time windowing** by the clocks at the top or by dragging across any
  section; the window lives in the URL.
- Track map with colour-by-variable, colormap, explicit colour range, and PNG
  export.
- T–S diagram in SA/CT coloured by depth, with σ₀ isopycnals traced by
  marching squares over a TEOS-10 field.
- Sections for every variable the deployment carries — native and the seven
  computed in a worker (SA, CT, θ, ρ, σ₀, π₀, sound speed).
- Two profile panels side by side, any variable on either.
- QARTOD filtering with a toggle, honest captions on every figure.

### The local page (`/local/`)

- Drag-and-drop Slocum decode in the tab, nothing uploaded.
- The same map, T–S diagram and sections as the DAC path.
- Links to oceansensing.org/data/slocum for CSV/netCDF/OG1 export rather than
  reimplementing it.

### Throughout

- Publication-quality PNG export from every figure and the map.
- Light/dark theme, WCAG AA on every shipped colour pair.
- ~295 offline checks across six suites.

---

## Decisions worth not relitigating

| decision | why |
|---|---|
| Static site, no backend | The DAC sends `Access-Control-Allow-Origin: *`, so the browser can read it directly. Nothing to run, nothing to pay for, nothing to keep up. |
| Served at `/gliders/` under the org domain | Zero DNS work; the org's cert already covers it. A subdomain would need a CNAME. |
| `teos10` and `slocum` vendored, not npm | Both are zero-dependency TypeScript written to be lifted whole. `check:vendored` reports drift; they are currently byte-identical to source. |
| Query-string state, no router | 2,534 datasets and more weekly. A view is a link. |
| No framework | Vanilla TS in component scripts, matching oceansensing.github.io. The heaviest thing on the page is the data. |
| Tests are plain Node scripts | Type stripping runs them against the sources; a runner needing its own transform would put a build between the code and its check. |

---

## Open, roughly in order of value

### The 60-track cap interacts badly with the default sort

Tracks are drawn for the first 60 of whatever is shown, and the default sort
is most-recent-first — so with "Active only" off, the archived tracks that
draw are still the recent ones, and the multi-year colour spread only appears
once the reader filters by year or re-sorts. The cap is printed, so this is
honest rather than hidden, but it is not what someone browsing the archive
expects.

Options: fetch a coarser track (one fix per day) for a much larger set;
sample across the shown set rather than taking the first 60; or drive the
tracks from the map's viewport instead of the table's order.

### No server-side track cache

Every visitor fetches the same archived tracks from the DAC. A build-time
job could bake a coarse track per deployment into a static file, the way
`public/data/deployments.json` bakes the catalog — turning 60 requests into
one. Worth it only if the site gets real traffic.

### The profile explorer lost its full-rate button

That is deliberate — the page window governs every figure now — but there is
no way to pull one profile at full rate while keeping a wide overview. If
that turns out to be wanted, it is a per-figure window rather than a
per-page one.

### Untested corners

- Deployments with no `precise_*` columns, or with only pressure and no
  depth. The code degrades and there is a 2018 fixture, but no dataset in the
  wild has been tried that lacks both.
- Very long missions (a year or more): the bin ladder should coarsen, but the
  longest tested is two months.
- The local page against a full deployment directory (hundreds of files); the
  fixture is a two-file pair.

### Smaller things

- HTTPS is not enforced on the Pages site (`https_enforced: false`). It works
  over HTTPS; HTTP is simply not redirected.
- `actions/checkout` and `actions/setup-node` are pinned to Node 20 SHAs and
  GitHub force-runs them on 24. Harmless, but the pins want bumping.
- Only the IOOS DAC is tested. The ERDDAP client takes a base URL, so OTN,
  VOTO and BODC are a config change plus whatever their schemas differ in.

---

## Working notes

**Verify before pushing.** `npm run verify` builds, type-checks and runs every
suite offline. The deploy re-runs it and will not publish if it fails.

**The scratch loop that worked.** Change → `npm run build` → `npx astro
preview` → drive the real page in a browser and *measure* (heights, counts,
distinct values) rather than eyeballing a screenshot. Most of the bugs in
`CLAUDE.md` §9 were invisible in a screenshot and obvious in a measurement.

**Refreshing the catalog snapshot**: `npm run data:deployments`. It is a
fallback, not the first paint, so it does not need to be current.

**The fixtures are real.** `scripts/fixtures/erddap/` holds live responses
captured 2026-08-18, including a 2018 dataset and a null-flag column;
`scripts/fixtures/slocum/` holds a real flight/science pair with its caches.
Regenerating them means re-capturing, not hand-editing.
