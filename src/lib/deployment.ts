/**
 * The deployment page.
 *
 * One prerendered page driven by `?dataset=<id>`: there are 2,534 datasets
 * on the DAC and more every week, so a route per deployment is not a static
 * site's shape. The reader's choices — dataset, variables, QC — live in the
 * query string, so a view is a link.
 *
 * **The render layer takes columns, not ERDDAP.** Everything below the fetch
 * consumes a `Source` of `Float64Array`s and a list of `Plottable`s, which
 * is the same thing the local-file page produces from a Slocum decode. That
 * boundary is the only reason one set of figures serves both.
 */

import {
  datasetInfo, fetchData, datasetPageUrl, tabledapUrl, DEFAULT_BASE,
  type DatasetInfo, type Progress, type TableData,
} from '@c4po/erddap';
import { COLORMAPS, knownColormap, sample } from '@c4po/plot';
import { makeFigure, type Figure, type Source } from './figure.ts';
import { makeTrack, type Track } from './track.ts';
import { isopycnalUnderlay } from './isopycnals.ts';
import { plottable, type Plottable } from './variables.ts';
import { Deriver } from './derived.ts';
import { DERIVED_NAMES } from './seawater.ts';
import { withBase } from './url.ts';

/**
 * The overview's depth bin: one metre, coarsened only if the deployment
 * would be enormous at it.
 *
 * It was a flat 5 m, and that was measurably wrong at the shallow end. A
 * shelf glider samples every ~2.5 m through a thermocline metres thick, so a
 * 5 m bin returned **9 samples per profile out of 68** — an eighth of the
 * record, and a section whose vertical structure was the bin's rather than
 * the ocean's. The same 5 m takes almost nothing off a 961 m glider, which
 * was never sampled finer than about 5 m to begin with.
 *
 * One metre costs 3.9× the rows on that shelf glider and 1.25× on the deep
 * one, and no server time at all — the bin is applied after the read, so a
 * finer one is the same request. See `packages/erddap/fetch.ts`.
 *
 * The candidates below are what it falls back through when a mission really
 * is too long; the page prints whichever it settled on.
 */
const OVERVIEW_BIN = 1;
const BIN_CANDIDATES = [2, 5, 10];

/**
 * The ladder used when the reader has picked a window rather than the whole
 * mission. `0` is full rate — every sample the glider took.
 *
 * A day of an eleven-day deployment is a fortieth of it, so the samples the
 * whole record could not afford fit inside the same budget with room to
 * spare. The ladder still coarsens if the chosen window is itself enormous,
 * which is the point of it being a ladder rather than a switch.
 */
const WINDOW_BIN = 0;
const WINDOW_CANDIDATES = [1, 2, 5, 10];

/** Sections open before the reader chooses anything. */
const DEFAULT_SECTIONS = ['temperature', 'salinity', 'sigma0'];

export function startDeploymentPage(): void {
  const root = document.querySelector<HTMLElement>('[data-view]');
  if (!root) return;

  const at = <T extends Element = HTMLElement>(sel: string): T => root.querySelector<T>(sel)!;
  const titleEl = at('[data-title]');
  const eyebrow = at('[data-eyebrow]');
  const metaEl = at('[data-meta]');
  const progress = at('[data-progress]');
  const bar = at('[data-bar]');
  const progressText = at('[data-progress-text]');
  const stopBtn = at<HTMLButtonElement>('[data-stop]');
  const problem = at('[data-problem]');
  const chips = at('[data-chips]');
  const figuresEl = at('[data-figures]');
  const summaryEl = at('[data-summary]');
  const resolutionEl = at('[data-resolution]');
  const linksEl = at('[data-links]');
  const qcBox = at<HTMLInputElement>('[data-qc]');
  const trackNote = at('[data-track-note]');
  const trackColour = at<HTMLSelectElement>('[data-track-colour]');
  const trackMap = at<HTMLSelectElement>('[data-track-map]');
  const trackRamp = at('[data-track-ramp]');
  const trackLo = at<HTMLInputElement>('[data-track-lo]');
  const trackHi = at<HTMLInputElement>('[data-track-hi]');
  const trackAuto = at<HTMLButtonElement>('[data-track-auto]');
  const fromBox = at<HTMLInputElement>('[data-from]');
  const toBox = at<HTMLInputElement>('[data-to]');
  const applyBtn = at<HTMLButtonElement>('[data-apply]');
  const wholeBtn = at<HTMLButtonElement>('[data-whole]');

  const params = new URLSearchParams(location.search);
  const id = params.get('dataset');
  if (!id) {
    titleEl.textContent = 'No deployment chosen';
    metaEl.textContent = '';
    say('Pick one from the list of deployments.', true);
    const back = document.createElement('a');
    back.href = withBase('/');
    back.textContent = 'Browse deployments';
    problem.append(' ', back);
    return;
  }

  const deriver = new Deriver();
  let info: DatasetInfo | null = null;
  let table: TableData | null = null;
  let vars: Plottable[] = [];
  let selected = new Set<string>();
  let controller: AbortController | null = null;
  /** The stretch of the deployment on screen, or null for all of it. */
  let window_: { from: number; to: number } | null = null;
  let restored = false;
  let track: Track | null = null;
  let tsFigure: Figure | null = null;
  let profileFigure: Figure | null = null;
  let profileFigure2: Figure | null = null;
  const sectionFigures = new Map<string, Figure>();
  /** The prototype cloned for each section. Rendered hidden by the
      component, because a compiled Astro component cannot be instantiated at
      runtime — but its DOM can be copied, and the figure styles are global
      precisely so a clone is styled like the original. */
  let prototype: HTMLElement | null = null;

  function say(text: string, show = true): void {
    problem.textContent = text;
    problem.hidden = !show;
  }

  /** Columns the figures can draw: what came back, plus what was derived. */
  function source(): Source {
    const columns = new Map<string, Float64Array>();
    if (table) for (const [k, v] of table.columns) columns.set(k, v);
    for (const [k, v] of derivedColumns) columns.set(k, v);
    return {
      columns,
      rows: table?.rows ?? 0,
      variables: vars,
      timeVar: info?.timeVar ?? 'time',
    };
  }

  let derivedColumns = new Map<string, Float64Array>();

  // ---- chrome ------------------------------------------------------------

  function paintHeader(): void {
    if (!info) return;
    document.title = `${info.title || id} · Gliders`;
    titleEl.textContent = info.title || id!;
    eyebrow.textContent = info.institution
      ? `IOOS Glider DAC · ${info.institution}`
      : 'IOOS Glider DAC';

    const days = (info.end - info.start) / 86400;
    const live = Date.now() / 1000 - info.end < 7 * 86400;
    metaEl.textContent = [
      info.id,
      `${date(info.start)} → ${date(info.end)}`,
      days >= 1 ? `${days.toFixed(0)} days` : 'under a day',
      live ? 'still reporting' : '',
    ].filter(Boolean).join('  ·  ');

    summaryEl.textContent = info.summary || 'The dataset publishes no summary.';

    linksEl.replaceChildren();
    const dacLink = document.createElement('a');
    dacLink.href = datasetPageUrl(DEFAULT_BASE, info.id);
    dacLink.textContent = 'This dataset on the DAC';
    const csv = document.createElement('a');
    csv.href = tabledapUrl(DEFAULT_BASE, info.id, 'csv',
      info.variables.filter((v) => !v.ancillary || v.name === info!.timeVar).map((v) => v.name).slice(0, 40));
    csv.textContent = 'Download CSV';
    const nc = document.createElement('a');
    nc.href = tabledapUrl(DEFAULT_BASE, info.id, 'nc',
      info.variables.filter((v) => !v.ancillary || v.name === info!.timeVar).map((v) => v.name).slice(0, 40));
    nc.textContent = 'Download netCDF';
    linksEl.append(dacLink, ' · ', csv, ' · ', nc);

    /* The boxes show whatever is loaded, so they are a readout as much as a
       control: after a drag they say what the drag selected. */
    fromBox.value = localStamp(window_?.from ?? info.start);
    toBox.value = localStamp(window_?.to ?? info.end);
    wholeBtn.disabled = !window_;
  }

  function paintChips(): void {
    chips.replaceChildren();
    for (const v of vars) {
      // Time, depth and position are axes, not sections. They stay in the
      // menus and out of this row.
      if (!v.section) continue;
      // A native column with nothing in it is not offered: the DAC declares
      // sensors a deployment never carried, and a chip that draws an empty
      // axis is worse than no chip.
      if (!v.derived && !hasData(v.name)) continue;
      if (v.derived && !canDerive()) continue;

      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.variable = v.name;
      chip.setAttribute('aria-pressed', String(selected.has(v.name)));
      if (v.derived) {
        const dot = document.createElement('span');
        dot.className = 'computed';
        chip.append(dot);
      }
      chip.append(document.createTextNode(v.label));
      if (v.note) chip.title = v.note;
      chip.addEventListener('click', () => void toggle(v.name));
      chips.append(chip);
    }
  }

  const hasData = (name: string): boolean => {
    const col = table?.columns.get(name);
    if (!col) return false;
    for (let i = 0; i < col.length; i++) if (col[i] === col[i]) return true;
    return false;
  };

  const canDerive = (): boolean =>
    Boolean(table?.columns.get('salinity') && table.columns.get('temperature')
      && info?.pressureVar && table.columns.get(info.pressureVar));

  async function toggle(name: string): Promise<void> {
    if (selected.has(name)) selected.delete(name);
    else selected.add(name);
    const chip = chips.querySelector<HTMLElement>(`[data-variable="${cssEscape(name)}"]`);
    chip?.setAttribute('aria-pressed', String(selected.has(name)));
    remember();
    await ensureDerived();
    paintSections();
  }

  /** Compute whatever derived properties are wanted but missing. */
  async function ensureDerived(): Promise<void> {
    if (!table || !info) return;
    const wanted = [...selected].filter((n) => DERIVED_NAMES.has(n));
    // The T–S diagram needs SA and CT whether or not a chip asked for them.
    for (const n of ['sa', 'ct']) if (!wanted.includes(n)) wanted.push(n);
    if (!canDerive()) return;
    const out = await deriver.compute(table, info, wanted);
    derivedColumns = out.columns;
    if (out.referenceOnly) {
      resolutionEl.textContent +=
        ' Absolute Salinity could not use the anomaly atlas here, so it is '
        + 'Reference Salinity — the difference is real and this page will not '
        + 'report one under the other’s name.';
    }
  }

  // ---- figures -----------------------------------------------------------

  function paintSections(): void {
    const wanted = [...selected];
    for (const [name, _figure] of sectionFigures) {
      if (!wanted.includes(name)) {
        document.querySelector(`[data-section="${cssEscape(name)}"]`)?.remove();
        sectionFigures.delete(name);
      }
    }

    for (const name of wanted) {
      if (sectionFigures.has(name)) continue;
      const v = vars.find((x) => x.name === name);
      if (!v || !prototype) continue;

      const node = prototype.cloneNode(true) as HTMLElement;
      node.hidden = false;
      node.dataset.figure = `section-${name}`;
      node.dataset.section = name;
      const heading = node.querySelector('h3');
      if (heading) heading.textContent = v.units ? `${v.label} (${v.units})` : v.label;
      const svgTitle = node.querySelector('svg > title');
      if (svgTitle) svgTitle.textContent = v.label;
      figuresEl.append(node);

      const figure = makeFigure(node, {
        x: info?.timeVar ?? 'time',
        y: info?.depthVar ?? 'depth',
        c: name,
        flipY: true,
        style: 'dots',
        dot: 2.5,
        height: 360,
        map: v.colormap,
        note: v.derived ? 'computed here from TEOS-10' : undefined,
        /* Sweep across a feature to load it properly. The gesture is the one
           a reader already makes at a section, so it is the one that asks
           for more of it. */
        onSelectX: (from, to) => void loadWindow(from, to),
      });
      sectionFigures.set(name, figure);
      figure.update(source());
    }

    // Order the figures the way the chips are ordered, so adding one does
    // not shuffle the page.
    const order = vars.map((v) => v.name).filter((n) => sectionFigures.has(n));
    for (const name of order) {
      const node = figuresEl.querySelector(`[data-section="${cssEscape(name)}"]`);
      if (node) figuresEl.append(node);
    }
  }

  function refresh(): void {
    const src = source();
    for (const figure of sectionFigures.values()) figure.update(src);
    tsFigure?.update(src);
    /* The profile view is the same rows against depth rather than time, so
       it reads whatever the window loaded — it used to fetch its own copy,
       which was a second answer to keep in step with the first. */
    profileFigure?.update(src);
    profileFigure2?.update(src);
    if (!table || !info) return;

    paintTrack();

    const scope = window_
      ? `${date(window_.from)} → ${date(window_.to)}`
      : 'the whole deployment';
    resolutionEl.textContent = table.resolution.kind === 'binned'
      ? `On screen: ${scope}, at most one sample per `
        + `${table.resolution.binMetres} m per profile — `
        + `${table.rows.toLocaleString()} rows. Where the glider sampled more `
        + `coarsely than that, this is every sample it took. Narrow the window `
        + `above, or drag across a section, to load a stretch at full rate.`
      : `On screen: ${scope} at full rate — every sample the glider took, `
        + `${table.rows.toLocaleString()} rows.`;
    if (table.partial) {
      /* A window the server would not answer for. On this server that is
         also how an *empty* window arrives — a glider on the surface, a day
         without telemetry — and one request cannot tell the two apart, so
         the sentence does not pretend to. */
      resolutionEl.textContent +=
        ' Some time windows returned nothing: either the glider reported no'
        + ' data through them, or the server would not answer for them.';
    }
  }

  /**
   * The track, coloured by whatever the reader picked.
   *
   * The value that reaches the map is the **shallowest** one in each
   * profile — a track coloured by temperature is asking what the water was
   * like where the glider surfaced, not what it was at the bottom of the
   * dive. `makeTrack` does that reduction; this decides which column and
   * which scale it uses.
   */
  function paintTrack(): void {
    if (!track || !table || !info) return;
    const src = source();
    const lat = src.columns.get(info.latVar);
    const lon = src.columns.get(info.lonVar);
    const time = src.columns.get(info.timeVar);
    if (!lat || !lon || !time) return;

    fillTrackMaps();
    fillTrackColours();
    const name = trackColour.value;
    const v = name && name !== info.timeVar ? src.columns.get(name) : undefined;
    const meta = vars.find((x) => x.name === name);

    /* The scale follows the variable until the reader picks one, then stays
       put — the same rule the figures keep, and tracked by a flag rather
       than by comparing against a default, so choosing viridis deliberately
       is not mistaken for not having chosen. */
    if (!trackMapTouched) {
      trackMap.value = meta?.colormap ?? (name === info.timeVar ? 'cmo.thermal' : 'viridis');
    }
    paintTrackRamp();

    const isTimeAxis = !v;
    retypeRange(isTimeAxis);
    const lo = readRange(trackLo, isTimeAxis);
    const hi = readRange(trackHi, isTimeAxis);

    track.update({
      lon, lat, time, n: table.rows,
      colour: v
        ? { values: v, colormap: trackMap.value, depth: src.columns.get(info.depthVar ?? 'depth') }
        : undefined,
      colormap: trackMap.value,
      range: lo !== null && hi !== null ? { lo, hi } : undefined,
    });

    /* The readout says what the colours actually span, and the placeholders
       say what the data does — so a reader can see at a glance whether they
       have narrowed it and what they narrowed it from. */
    const auto = track.dataRange;
    if (auto) {
      trackLo.placeholder = isTimeAxis ? stampOf(auto.lo) : trim(auto.lo);
      trackHi.placeholder = isTimeAxis ? stampOf(auto.hi) : trim(auto.hi);
    }
    const range = track.range;
    if (!range) { trackNote.textContent = ''; return; }
    const narrowed = auto && (range.lo !== auto.lo || range.hi !== auto.hi);
    const text = v && meta
      ? `${trim(range.lo)} – ${trim(range.hi)}${meta.units ? ` ${meta.units}` : ''}`
      : `${date(range.lo)} → ${date(range.hi)}`;
    trackNote.textContent = narrowed ? `${text} (set)` : text;
  }

  /** A range box is a clock on a time axis and a number otherwise — an epoch
      is not something anyone types. Switching wipes the value, because the
      old one means nothing on the new axis. */
  function retypeRange(isTime: boolean): void {
    const want = isTime ? 'datetime-local' : 'number';
    for (const box of [trackLo, trackHi]) {
      if (box.type !== want) {
        box.type = want;
        box.value = '';
      }
    }
  }

  const readRange = (box: HTMLInputElement, isTime: boolean): number | null => {
    const raw = box.value.trim();
    if (!raw) return null;
    const v = isTime ? Date.parse(`${raw}Z`) / 1000 : Number(raw);
    return Number.isFinite(v) ? v : null;
  };

  const stampOf = (t: number): string =>
    Number.isFinite(t) ? new Date(t * 1000).toISOString().slice(0, 16) : '';

  /** The colour menu, filled from what the deployment actually has. */
  function fillTrackColours(): void {
    if (!info) return;
    const options = vars.filter((v) =>
      (v.name === info!.timeVar || v.section) && hasAnyIn(v.name));
    const key = options.map((v) => v.name).join(',');
    if (key === trackColourKey) return;
    trackColourKey = key;

    const keep = trackColour.value || wantedTrack || '';
    trackColour.replaceChildren();
    for (const v of options) {
      const opt = document.createElement('option');
      opt.value = v.name;
      opt.textContent = v.units ? `${v.label} (${v.units})` : v.label;
      trackColour.append(opt);
    }
    trackColour.value = options.some((v) => v.name === keep) ? keep : info.timeVar;
    /* Honoured once; after that the reader's own choice is what `keep`
       carries, and a stale link value must not keep overriding it. */
    if (trackColour.value === wantedTrack) wantedTrack = null;
  }

  let trackColourKey = '';
  let trackMapTouched = false;

  /** The scale menu, filled once — the list is fixed, not something the data
      decides. */
  let pendingTrackMap: string | null = null;

  function fillTrackMaps(): void {
    if (trackMap.options.length) return;
    for (const cmap of Object.keys(COLORMAPS)) {
      const opt = document.createElement('option');
      opt.value = cmap;
      opt.textContent = cmap;
      trackMap.append(opt);
    }
    /* A link's choice, applied now that there is a menu to apply it to —
       the same trap the colour variable fell into: assigning to an empty
       select does nothing at all. */
    if (pendingTrackMap) {
      trackMap.value = pendingTrackMap;
      pendingTrackMap = null;
    }
  }

  function paintTrackRamp(): void {
    const stops = 20;
    trackRamp.replaceChildren();
    for (let i = 0; i < stops; i++) {
      const cell = document.createElement('span');
      cell.style.background = sample(trackMap.value, (i + 0.5) / stops);
      trackRamp.append(cell);
    }
  }
  /** A colour asked for by the link, until the menu exists to honour it. */
  let wantedTrack: string | null = null;

  /** True when the column exists in what is loaded *or* derived and holds a
      value somewhere — a chip's worth of data, for the map's menu. */
  const hasAnyIn = (name: string): boolean => {
    const col = table?.columns.get(name) ?? derivedColumns.get(name);
    if (!col) return false;
    for (let i = 0; i < col.length; i++) if (col[i] === col[i]) return true;
    return false;
  };

  trackColour.addEventListener('change', () => {
    /* A new variable brings its own conventional scale back, unless the
       reader has expressed a preference — and its own range always, because
       limits set for temperature mean nothing on salinity. */
    trackMapTouched = false;
    trackLo.value = '';
    trackHi.value = '';
    paintTrack();
    remember();
  });

  trackMap.addEventListener('change', () => {
    trackMapTouched = true;
    paintTrack();
    remember();
  });

  for (const box of [trackLo, trackHi]) {
    box.addEventListener('input', () => {
      paintTrack();
      remember();
    });
  }

  trackAuto.addEventListener('click', () => {
    trackLo.value = '';
    trackHi.value = '';
    paintTrack();
    remember();
  });

  // ---- loading -----------------------------------------------------------

  function onProgress(next: TableData, p: Progress): void {
    table = next;
    progress.hidden = false;
    bar.querySelector('span')?.setAttribute('style', `width:${(p.done / p.total * 100).toFixed(0)}%`);
    progressText.textContent =
      `${p.done} of ${p.total} · ${p.rows.toLocaleString()} rows`
      + (p.unread ? ` · ${p.unread} empty` : '');
    // Chips depend on which columns have data, which only the first chunk
    // reveals; repainted each time so a sensor that starts mid-mission
    // appears rather than being judged on chunk one.
    paintChips();
    /* The sections are created here rather than only when the load finishes.
       They were not, and the page spent the whole fetch with a filled T–S
       diagram above an empty "Sections" heading — the figures existed in the
       code and appeared, complete, at the very end. Creating them on the
       first chunk means they grow with everything else. */
    void ensureDerived().then(() => {
      paintSections();
      refresh();
    });
  }

  async function load(): Promise<void> {
    /* **A fresh controller before anything is requested.** Reloading for a
       new window aborts the one in flight, and the next `load` used to reach
       `datasetInfo` still holding that aborted signal — so choosing a window
       failed instantly with "signal is aborted without reason" and the page
       emptied. The controller belongs to a load, not to the page. */
    controller = new AbortController();
    stopBtn.disabled = false;

    /* The metadata cannot change between windows, so it is fetched once. */
    if (!info) {
      try {
        info = await datasetInfo(id!, { signal: controller.signal });
      } catch (error) {
        titleEl.textContent = id!;
        if ((error as Error).name !== 'AbortError') {
          say(`This deployment could not be read: ${(error as Error).message}`);
        }
        return;
      }
    }

    vars = plottable(info.variables);
    restore();
    paintHeader();

    // The figures exist before the data does, so the page has its shape from
    // the first paint rather than assembling itself as chunks land.
    const tsNode = document.querySelector<HTMLElement>('[data-figure="ts"]');
    if (tsNode && !tsFigure) {
      tsFigure = makeFigure(tsNode, {
        x: 'sa', y: 'ct', c: info.depthVar ?? 'depth',
        style: 'dots', dot: 2, height: 420, map: 'cmo.deep',
        underlay: isopycnalUnderlay,
        note: 'contours are σ₀',
      });
    }
    /* Two panels, opening on the pair a reader compares first: a
       thermocline and a halocline look the same in one profile and obviously
       different across two. Both are ordinary figures, so either axis can be
       changed to anything the deployment carries. */
    const profileNode = document.querySelector<HTMLElement>('[data-figure="profile"]');
    if (profileNode && !profileFigure) {
      profileFigure = makeFigure(profileNode, {
        x: 'temperature', y: info.depthVar ?? 'depth',
        c: info.timeVar, flipY: true, style: 'dots', dot: 2.5, height: 420,
        map: 'cmo.thermal',
      });
    }
    const profileNode2 = document.querySelector<HTMLElement>('[data-figure="profile2"]');
    if (profileNode2 && !profileFigure2) {
      profileFigure2 = makeFigure(profileNode2, {
        x: 'salinity', y: info.depthVar ?? 'depth',
        c: info.timeVar, flipY: true, style: 'dots', dot: 2.5, height: 420,
        map: 'cmo.haline',
      });
    }
    const mapNode = document.querySelector<HTMLElement>('[data-map]');
    if (mapNode && !track) track = makeTrack(mapNode);

    /* Everything non-ancillary, because the reader can chip any of it on
       without a second trip to the server — the overview is one pass over
       the deployment and a second one for a variable already fetched would
       cost more than the bytes it saves. */
    const wanted = info.variables
      .filter((v) => !v.ancillary && v.type !== 'String')
      .map((v) => v.name);

    /* A chosen window starts the ladder at full rate; the whole mission
       starts it at a metre. Either way the budget is what decides where it
       stops — this only says where to begin looking. */
    const windowed = window_ !== null;

    try {
      table = await fetchData(id!, info, {
        variables: wanted,
        start: window_?.from,
        end: window_?.to,
        binMetres: windowed ? WINDOW_BIN : OVERVIEW_BIN,
        binCandidates: windowed ? WINDOW_CANDIDATES : BIN_CANDIDATES,
        applyQc: qcBox.checked,
        signal: controller.signal,
        onChunk: onProgress,
      });
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        say(`The data stopped arriving: ${(error as Error).message}`);
      }
    }

    progress.hidden = true;
    stopBtn.disabled = true;
    paintChips();
    await ensureDerived();
    paintSections();
    refresh();
  }

  stopBtn.addEventListener('click', () => {
    controller?.abort();
    progress.hidden = true;
    say('Loading stopped — what had arrived is on screen.', true);
  });

  qcBox.addEventListener('change', () => {
    deriver.reset();
    derivedColumns = new Map();
    void load();
  });

  // ---- the window --------------------------------------------------------

  /**
   * Load a stretch of the deployment.
   *
   * Everything is re-fetched rather than filtered from what is already
   * loaded, and that is the whole feature: the point of narrowing is to ask
   * the server for the samples the whole mission could not afford. Filtering
   * would leave the reader looking at the same 1 m overview through a
   * smaller window and wondering why it had not got sharper.
   */
  async function loadWindow(from: number, to: number): Promise<void> {
    if (!info) return;
    if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from)) {
      say('Pick a window that ends after it starts.');
      return;
    }
    /* Clamped to the deployment, so a drag that overshoots the last profile
       does not ask for a week of nothing. */
    window_ = {
      from: Math.max(from, info.start),
      to: Math.min(to, info.end),
    };
    controller?.abort();
    resetForReload();
    remember();
    await load();
  }

  async function loadWhole(): Promise<void> {
    window_ = null;
    controller?.abort();
    resetForReload();
    remember();
    await load();
  }

  /** Drop everything derived from the previous window. The deriver memoizes
      against a row count, and the figures hold columns of the old length. */
  function resetForReload(): void {
    deriver.reset();
    derivedColumns = new Map();
    table = null;
    for (const name of [...sectionFigures.keys()]) {
      figuresEl.querySelector(`[data-section="${cssEscape(name)}"]`)?.remove();
      sectionFigures.delete(name);
    }
    say('', false);
  }

  applyBtn.addEventListener('click', () => {
    void loadWindow(readBox(fromBox), readBox(toBox));
  });
  wholeBtn.addEventListener('click', () => void loadWhole());

  /** A `datetime-local` has no zone; every clock on this page is UTC, so it
      is read as UTC rather than as the reader's own offset. */
  const readBox = (input: HTMLInputElement): number =>
    Date.parse(`${input.value}Z`) / 1000;

  // ---- the query string --------------------------------------------------

  function restore(): void {
    const wanted = params.get('vars');
    const names = wanted ? wanted.split(',').filter(Boolean) : DEFAULT_SECTIONS;
    selected = new Set(names.filter((n) => vars.some((v) => v.name === n)));
    if (params.get('qc') === 'off') qcBox.checked = false;
    /* Held rather than applied: the select has no options until the first
       chunk reveals which columns carry data, and assigning a value to an
       empty select does nothing at all — so the link's choice was silently
       dropped and the map fell back to time. `fillTrackColours` applies it
       once there is something to apply it to. */
    wantedTrack = params.get('track') ?? wantedTrack;
    const wantedRange = params.get('trackrange');
    if (wantedRange && !trackLo.value && !trackHi.value) {
      const [a, b] = wantedRange.split(',');
      if (a && b) { trackLo.value = a; trackHi.value = b; }
    }
    const wantedMap = params.get('trackmap');
    if (wantedMap && knownColormap(wantedMap)) {
      pendingTrackMap = wantedMap;
      trackMapTouched = true;
    }
    /* Only on the first load: after that `window_` is what the reader chose
       and the query string is following it, not leading. */
    if (!restored) {
      const t0 = Number(params.get('t0'));
      const t1 = Number(params.get('t1'));
      if (Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0 && t0 > 0) {
        window_ = { from: t0, to: t1 };
      }
      restored = true;
    }
  }

  function remember(): void {
    const next = new URLSearchParams(location.search);
    next.set('dataset', id!);
    if (selected.size) next.set('vars', [...selected].join(','));
    else next.delete('vars');
    if (!qcBox.checked) next.set('qc', 'off');
    else next.delete('qc');
    if (trackColour.value && trackColour.value !== info?.timeVar) {
      next.set('track', trackColour.value);
    } else {
      next.delete('track');
    }
    if (trackMapTouched && trackMap.value) next.set('trackmap', trackMap.value);
    else next.delete('trackmap');
    if (trackLo.value && trackHi.value) next.set('trackrange', `${trackLo.value},${trackHi.value}`);
    else next.delete('trackrange');
    if (window_) {
      next.set('t0', String(Math.round(window_.from)));
      next.set('t1', String(Math.round(window_.to)));
    } else {
      next.delete('t0');
      next.delete('t1');
    }
    history.replaceState(null, '', `${location.pathname}?${next}`);
  }

  prototype = document.querySelector<HTMLElement>('[data-figure="prototype"]');
  void load();
}

const trim = (v: number): string => {
  if (!Number.isFinite(v)) return '—';
  const size = Math.abs(v);
  if (size !== 0 && (size < 1e-3 || size >= 1e6)) return v.toExponential(2);
  return String(Math.round(v * 100) / 100);
};

const date = (t: number): string =>
  Number.isFinite(t) ? new Date(t * 1000).toISOString().slice(0, 10) : '—';

/** `YYYY-MM-DDTHH:MM` for a `datetime-local`, in UTC — which is what every
    other clock on this page is in, and what the value is read back as. */
const localStamp = (t: number): string =>
  Number.isFinite(t) ? new Date(t * 1000).toISOString().slice(0, 16) : '';

/** `CSS.escape` where it exists. Dataset ids and variable names are plain,
    but they come from a server and are used to build a selector. */
const cssEscape = (s: string): string =>
  typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
