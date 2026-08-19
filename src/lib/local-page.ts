/**
 * The local-files page.
 *
 * Decodes what the reader drops, then hands it to the same figures the DAC
 * pages use. Everything specific to Slocum is in `lib/local.ts`; this is the
 * page's own wiring.
 */

import { decodeFiles, toSource, type CacheStore, type DecodeReport } from './local.ts';
import { makeFigure, type Figure, type Source } from './figure.ts';
import { makeTrack, type Track } from './track.ts';
import { makeTrackLegend, type TrackLegend } from './track-legend.ts';
import { isopycnalUnderlay } from './isopycnals.ts';
import { decodeAtlas, type SalinityAtlas } from '@c4po/teos10/atlas';
import type { Deployment } from '@c4po/slocum';
import { withBase } from './url.ts';

/** Sections open as soon as files land, when the deployment has them. */
const DEFAULT_SECTIONS = ['sci_water_temp', 'salinity_practical', 'sigma0'];

export function startLocalPage(): void {
  const root = document.querySelector<HTMLElement>('[data-drop]');
  if (!root) return;

  const zone = root.querySelector<HTMLElement>('[data-zone]')!;
  const filesInput = root.querySelector<HTMLInputElement>('[data-files]')!;
  const folderInput = root.querySelector<HTMLInputElement>('[data-folder]')!;
  const report = root.querySelector<HTMLElement>('[data-report]')!;
  const deploymentsBox = root.querySelector<HTMLElement>('[data-deployments]')!;
  const deploymentSel = root.querySelector<HTMLSelectElement>('[data-deployment]')!;
  const panels = document.querySelector<HTMLElement>('[data-panels]')!;
  const chips = document.querySelector<HTMLElement>('[data-chips]')!;
  const figuresEl = document.querySelector<HTMLElement>('[data-figures]')!;
  const prototype = document.querySelector<HTMLElement>('[data-figure="prototype"]');

  const caches: CacheStore = new Map();
  let deployments: Deployment[] = [];
  let source: Source | null = null;
  let atlas: SalinityAtlas | null = null;
  let track: Track | null = null;
  let legend: TrackLegend | null = null;
  let tsFigure: Figure | null = null;
  const sectionFigures = new Map<string, Figure>();
  const selected = new Set<string>(DEFAULT_SECTIONS);

  /* Fetched once, on the first decode rather than on page load: a reader who
     never drops a file never pays the 188 KB. */
  let atlasPromise: Promise<SalinityAtlas | null> | null = null;
  function loadAtlas(): Promise<SalinityAtlas | null> {
    if (atlasPromise) return atlasPromise;
    atlasPromise = (async () => {
      try {
        const res = await fetch(withBase('/teos10/saar.bin.gz'));
        if (!res.ok) return null;
        const raw = await res.arrayBuffer();
        const head = new Uint8Array(raw, 0, 2);
        const bytes = head[0] === 0x1f && head[1] === 0x8b
          ? await new Response(
              new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip')),
            ).arrayBuffer()
          : raw;
        return decodeAtlas(bytes);
      } catch {
        /* No atlas means Absolute Salinity falls back to Reference Salinity,
           which the decoder's own notes say out loud. Not a page failure. */
        return null;
      }
    })();
    return atlasPromise;
  }

  // ---- taking files ------------------------------------------------------

  for (const event of ['dragenter', 'dragover'] as const) {
    zone.addEventListener(event, (e) => {
      e.preventDefault();
      zone.classList.add('over');
    });
  }
  for (const event of ['dragleave', 'drop'] as const) {
    zone.addEventListener(event, () => zone.classList.remove('over'));
  }
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) void accept(files);
  });
  /* Set here rather than in the markup: `webkitdirectory` is the only way to
     take a directory and is absent from the HTML attribute types, so writing
     it in the template is a type error that would have to be suppressed. */
  folderInput.setAttribute('webkitdirectory', '');

  for (const input of [filesInput, folderInput]) {
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])];
      if (files.length) void accept(files);
    });
  }

  async function accept(files: File[]): Promise<void> {
    report.textContent = `Decoding ${files.length} file${files.length === 1 ? '' : 's'}…`;
    atlas = await loadAtlas();
    let result: DecodeReport;
    try {
      result = await decodeFiles(files, caches);
    } catch (error) {
      report.textContent = `Nothing could be decoded: ${(error as Error).message}`;
      return;
    }

    deployments = result.deployments;
    say(result);
    if (deployments.length === 0) {
      panels.hidden = true;
      return;
    }

    deploymentsBox.hidden = deployments.length < 2;
    deploymentSel.replaceChildren();
    deployments.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent =
        `${d.glider} · ${stamp(d.start)} → ${stamp(d.end)} · ${d.segments.length} files`;
      deploymentSel.append(opt);
    });
    deploymentSel.value = '0';
    show(0);
  }

  /**
   * What was decoded, and what was not.
   *
   * A missing `.cac` is the commonest failure by far, and naming the CRC is
   * what makes it actionable: the file the reader needs is called
   * `<crc>.cac` and is on the glider or in their own cache directory. A
   * count of failures without the CRC would be a dead end.
   */
  function say(result: DecodeReport): void {
    const lines: string[] = [];
    const files = result.deployments.reduce((n, d) => n + d.segments.length, 0);
    lines.push(
      `${files} file${files === 1 ? '' : 's'} decoded into `
      + `${result.deployments.length} deployment${result.deployments.length === 1 ? '' : 's'}.`,
    );
    for (const [crc, names] of result.missingCaches) {
      lines.push(
        `Need the sensor list ${crc}.cac for ${names.length} file`
        + `${names.length === 1 ? '' : 's'} (${names.slice(0, 3).join(', ')}`
        + `${names.length > 3 ? '…' : ''}) — drop it in and they will decode.`,
      );
    }
    if (result.undated.length) {
      lines.push(`${result.undated.length} file(s) had no usable clock and were left out.`);
    }
    for (const f of result.failed.slice(0, 5)) lines.push(`${f.name}: ${f.reason}`);
    report.textContent = lines.join('\n');
  }

  deploymentSel.addEventListener('change', () => show(Number(deploymentSel.value)));

  // ---- drawing -----------------------------------------------------------

  function show(index: number): void {
    const deployment = deployments[index];
    if (!deployment) return;

    const built = toSource(deployment, atlas);
    source = built.source;
    if (built.notes.length) {
      report.textContent += `\n${built.notes.join('\n')}`;
    }

    panels.hidden = false;

    const mapNode = document.querySelector<HTMLElement>('[data-map]');
    if (mapNode && !track) track = makeTrack(mapNode);
    /* The same legend the deployment pages carry. A decoded Slocum table
       always names its axes the same way, where a DAC dataset names its own
       — which is the only thing the two callers differ in. */
    if (!legend) {
      legend = makeTrackLegend(document, {
        track: () => track,
        source: () => source,
        axes: () => ({
          timeVar: 'time',
          latVar: 'latitude',
          lonVar: 'longitude',
          depthVar: 'depth',
        }),
      });
    }
    legend.paint();

    const tsNode = document.querySelector<HTMLElement>('[data-figure="ts"]');
    if (tsNode && !tsFigure) {
      tsFigure = makeFigure(tsNode, {
        x: pick(['salinity_absolute', 'salinity_reference', 'salinity_practical']),
        y: 'temperature_conservative',
        c: 'depth',
        style: 'dots', dot: 2, height: 420, map: 'cmo.deep',
        underlay: isopycnalUnderlay,
        note: 'contours are σ₀',
      });
    }
    tsFigure?.update(source);

    paintChips();
    paintSections();
  }

  const pick = (names: string[]): string =>
    names.find((n) => source?.columns.has(n)) ?? names[names.length - 1];

  function paintChips(): void {
    if (!source) return;
    chips.replaceChildren();
    for (const v of source.variables) {
      if (!v.section) continue;
      const values = source.columns.get(v.name);
      if (!values || !hasAny(values)) continue;

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
      chip.addEventListener('click', () => {
        if (selected.has(v.name)) selected.delete(v.name);
        else selected.add(v.name);
        chip.setAttribute('aria-pressed', String(selected.has(v.name)));
        paintSections();
      });
      chips.append(chip);
    }
  }

  const hasAny = (values: Float64Array): boolean => {
    for (let i = 0; i < values.length; i++) if (values[i] === values[i]) return true;
    return false;
  };

  function paintSections(): void {
    if (!source || !prototype) return;
    const wanted = [...selected].filter((n) => source!.columns.has(n));

    for (const name of [...sectionFigures.keys()]) {
      if (!wanted.includes(name)) {
        figuresEl.querySelector(`[data-section="${escape(name)}"]`)?.remove();
        sectionFigures.delete(name);
      }
    }

    const depth = 'depth';
    for (const name of wanted) {
      if (sectionFigures.has(name)) continue;
      const v = source.variables.find((x) => x.name === name);
      if (!v) continue;

      const node = prototype.cloneNode(true) as HTMLElement;
      node.hidden = false;
      node.dataset.figure = `section-${name}`;
      node.dataset.section = name;
      const heading = node.querySelector('h3');
      if (heading) heading.textContent = v.units ? `${v.label} (${v.units})` : v.label;
      figuresEl.append(node);

      const figure = makeFigure(node, {
        x: 'time', y: depth, c: name,
        flipY: true, style: 'dots', dot: 2.5, height: 360, map: v.colormap,
        note: v.derived ? 'computed from TEOS-10' : undefined,
      });
      sectionFigures.set(name, figure);
      figure.update(source);
    }

    const order = source.variables.map((v) => v.name).filter((n) => sectionFigures.has(n));
    for (const name of order) {
      const node = figuresEl.querySelector(`[data-section="${escape(name)}"]`);
      if (node) figuresEl.append(node);
    }
  }

  const escape = (s: string): string =>
    typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');

  const stamp = (t: number): string =>
    Number.isFinite(t) ? new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') : '—';
}
