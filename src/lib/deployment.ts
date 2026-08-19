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
import { makeFigure, type Figure, type Source } from './figure.ts';
import { makeTrack, type Track } from './track.ts';
import { isopycnalUnderlay } from './isopycnals.ts';
import { plottable, type Plottable } from './variables.ts';
import { Deriver } from './derived.ts';
import { DERIVED_NAMES } from './seawater.ts';
import { withBase } from './url.ts';

/** Depth bin for the overview. Five metres keeps the thermocline's shape
    while cutting an eleven-day coastal deployment from 142,000 rows to
    18,700 — measured. The profile explorer loads full rate per window. */
const OVERVIEW_BIN = 5;

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
  const profileFrom = at<HTMLInputElement>('[data-profile-from]');
  const profileTo = at<HTMLInputElement>('[data-profile-to]');
  const profileBtn = at<HTMLButtonElement>('[data-profile-load]');
  const profileNote = at('[data-profile-note]');

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
  let track: Track | null = null;
  let tsFigure: Figure | null = null;
  let profileFigure: Figure | null = null;
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

    /* The profile window defaults to the last day of the mission, which is
       what a reader checking on a live glider is after. */
    profileFrom.value = localStamp(Math.max(info.start, info.end - 86400));
    profileTo.value = localStamp(info.end);
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
    if (!table || !info) return;

    const lat = table.columns.get(info.latVar);
    const lon = table.columns.get(info.lonVar);
    const time = table.columns.get(info.timeVar);
    if (track && lat && lon && time) {
      track.update(lon, lat, time, table.rows);
      trackNote.textContent = 'coloured by time';
    }

    resolutionEl.textContent = table.resolution.kind === 'binned'
      ? `On screen: one sample per ${table.resolution.binMetres} m per profile — `
        + `${table.rows.toLocaleString()} of the deployment’s full rate. The `
        + `profile explorer below loads a time window at full resolution.`
      : `On screen: every sample the server returned — ${table.rows.toLocaleString()} rows.`;
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
    try {
      info = await datasetInfo(id!, { signal: controller?.signal });
    } catch (error) {
      titleEl.textContent = id!;
      say(`This deployment could not be read: ${(error as Error).message}`);
      return;
    }

    vars = plottable(info.variables);
    paintHeader();
    restore();

    // The figures exist before the data does, so the page has its shape from
    // the first paint rather than assembling itself as chunks land.
    const tsNode = document.querySelector<HTMLElement>('[data-figure="ts"]');
    if (tsNode) {
      tsFigure = makeFigure(tsNode, {
        x: 'sa', y: 'ct', c: info.depthVar ?? 'depth',
        style: 'dots', dot: 2, height: 420, map: 'cmo.deep',
        underlay: isopycnalUnderlay,
        note: 'contours are σ₀',
      });
    }
    const profileNode = document.querySelector<HTMLElement>('[data-figure="profile"]');
    if (profileNode) {
      profileFigure = makeFigure(profileNode, {
        x: 'temperature', y: info.depthVar ?? 'depth',
        c: info.timeVar, flipY: true, style: 'dots', dot: 2.5, height: 420,
        map: 'cmo.thermal',
      });
    }
    const mapNode = document.querySelector<HTMLElement>('[data-map]');
    if (mapNode) track = makeTrack(mapNode);

    controller = new AbortController();
    stopBtn.disabled = false;

    /* Everything non-ancillary, because the reader can chip any of it on
       without a second trip to the server — the overview is one pass over
       the deployment and a second one for a variable already fetched would
       cost more than the bytes it saves. */
    const wanted = info.variables
      .filter((v) => !v.ancillary && v.type !== 'String')
      .map((v) => v.name);

    try {
      table = await fetchData(id!, info, {
        variables: wanted,
        binMetres: OVERVIEW_BIN,
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

  // ---- the profile explorer ---------------------------------------------

  profileBtn.addEventListener('click', async () => {
    if (!info) return;
    const from = Date.parse(`${profileFrom.value}Z`) / 1000;
    const to = Date.parse(`${profileTo.value}Z`) / 1000;
    if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from)) {
      profileNote.textContent = 'Pick a window that ends after it starts.';
      return;
    }
    profileBtn.disabled = true;
    profileNote.textContent = 'Loading…';
    try {
      const full = await fetchData(id!, info, {
        variables: info.variables.filter((v) => !v.ancillary && v.type !== 'String').map((v) => v.name),
        start: from,
        end: to,
        applyQc: qcBox.checked,
      });
      const out = canDeriveOn(full)
        ? await deriveOn(full)
        : new Map<string, Float64Array>();
      const columns = new Map(full.columns);
      for (const [k, v] of out) columns.set(k, v);
      profileFigure?.update({
        columns, rows: full.rows, variables: vars, timeVar: info.timeVar,
      });
      profileNote.textContent =
        `${full.rows.toLocaleString()} samples at full rate, ${date(from)} → ${date(to)}`;
    } catch (error) {
      profileNote.textContent = `Could not load: ${(error as Error).message}`;
    } finally {
      profileBtn.disabled = false;
    }
  });

  const canDeriveOn = (data: TableData): boolean =>
    Boolean(data.columns.get('salinity') && data.columns.get('temperature')
      && info?.pressureVar && data.columns.get(info.pressureVar));

  /** The profile window gets its own deriver: the page's one is memoized
      against the overview's columns, and reusing it would hand back arrays
      of the wrong length. */
  async function deriveOn(data: TableData): Promise<Map<string, Float64Array>> {
    const local = new Deriver();
    const out = await local.compute(data, info!, ['sa', 'ct', 'sigma0', 'spice0', 'soundSpeed', 'rho', 'pt']);
    return out.columns;
  }

  // ---- the query string --------------------------------------------------

  function restore(): void {
    const wanted = params.get('vars');
    const names = wanted ? wanted.split(',').filter(Boolean) : DEFAULT_SECTIONS;
    selected = new Set(names.filter((n) => vars.some((v) => v.name === n)));
    if (params.get('qc') === 'off') qcBox.checked = false;
  }

  function remember(): void {
    const next = new URLSearchParams(location.search);
    next.set('dataset', id!);
    if (selected.size) next.set('vars', [...selected].join(','));
    else next.delete('vars');
    if (!qcBox.checked) next.set('qc', 'off');
    else next.delete('qc');
    history.replaceState(null, '', `${location.pathname}?${next}`);
  }

  prototype = document.querySelector<HTMLElement>('[data-figure="prototype"]');
  void load();
}

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
