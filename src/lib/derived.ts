/**
 * Asking for a derived property, from the page's side.
 *
 * Holds the worker, the atlas, and a memo of what has already been computed
 * for the table currently on screen. The page asks for names; it gets
 * columns, and does not learn whether they came from the worker or from the
 * main thread.
 *
 * **The main-thread path is a real fallback, not a courtesy.** A worker
 * fails to start under a policy that forbids it, in a test realm with no
 * `Worker` at all, and on a page opened from a `file:` URL. The arithmetic
 * is the same function either way — `seawater.ts` is imported by both — so
 * the fallback cannot drift from the fast path.
 */

import type { TableData } from '@c4po/erddap';
import { decodeAtlas, type SalinityAtlas } from '@c4po/teos10/atlas';
import { derive, DERIVED_NAMES, type Inputs } from './seawater.ts';
import type { DeriveRequest, DeriveResponse } from './derive.worker.ts';
import { withBase } from './url.ts';

/** Where the SAAR atlas lives. `@c4po/teos10` names it root-absolute, which
    is wrong under a base path — so the base is applied here rather than the
    package's own constant being used. */
const ATLAS_PATH = '/teos10/saar.bin.gz';

export interface DeriveOutcome {
  columns: Map<string, Float64Array>;
  /** True when SA is Reference Salinity because no atlas or position was
      available. The page says so; it does not report the wrong number under
      the right name. */
  referenceOnly: boolean;
}

export class Deriver {
  private worker: Worker | null = null;
  private atlasSent = false;
  private atlasPromise: Promise<ArrayBuffer | null> | null = null;
  private pending = new Map<number, (r: DeriveResponse) => void>();
  private nextId = 1;
  /** Computed columns for the table currently loaded. Cleared by `reset`,
      and automatically whenever the table it was computed against changes
      length — see `compute`. */
  private cache = new Map<string, Float64Array>();
  private cachedRows = -1;
  private referenceOnly = false;

  /** Drop everything remembered about the previous table. */
  reset(): void {
    this.cache.clear();
    this.cachedRows = -1;
    this.referenceOnly = false;
  }

  /** Whether anything derived so far fell back to Reference Salinity. */
  get isReferenceOnly(): boolean {
    return this.referenceOnly;
  }

  /**
   * The SAAR atlas bytes, fetched once and inflated.
   *
   * Gzipped on disk because a static host does not compress an unknown
   * binary type; a host that *does* decompress it transparently hands us
   * plain bytes, so the gzip magic is sniffed rather than assumed.
   */
  private atlas(): Promise<ArrayBuffer | null> {
    if (this.atlasPromise) return this.atlasPromise;
    this.atlasPromise = (async () => {
      try {
        const res = await fetch(withBase(ATLAS_PATH));
        if (!res.ok) return null;
        const raw = await res.arrayBuffer();
        const head = new Uint8Array(raw, 0, Math.min(2, raw.byteLength));
        if (head[0] !== 0x1f || head[1] !== 0x8b) return raw;
        if (typeof DecompressionStream === 'undefined') return null;
        const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));
        return await new Response(stream).arrayBuffer();
      } catch {
        /* No atlas means Reference Salinity, which is reported rather than
           silently substituted. It is not a reason to fail the page. */
        return null;
      }
    })();
    return this.atlasPromise;
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    try {
      /* `new URL(..., import.meta.url)` is what lets the bundler find and
         fingerprint the worker, and it is also what carries the site's base
         path — a bare string here would resolve to the site root and 404
         under `/gliders/`. */
      this.worker = new Worker(new URL('./derive.worker.ts', import.meta.url), { type: 'module' });
      this.worker.addEventListener('message', (event: MessageEvent<DeriveResponse>) => {
        const resolve = this.pending.get(event.data.id);
        if (resolve) {
          this.pending.delete(event.data.id);
          resolve(event.data);
        }
      });
      this.worker.addEventListener('error', () => {
        /* Whatever is in flight will never answer. Drop the worker so the
           next request takes the main-thread path rather than hanging. */
        for (const [id, resolve] of this.pending) {
          resolve({ id, columns: {}, referenceOnly: false, counts: {}, error: 'worker failed' });
        }
        this.pending.clear();
        this.worker?.terminate();
        this.worker = null;
        this.atlasSent = false;
      });
    } catch {
      this.worker = null;
    }
    return this.worker;
  }

  /**
   * Compute `wanted` from `data`, reusing anything already computed.
   *
   * Returns every requested name that could be produced. A name the dataset
   * has no inputs for is simply absent — the page draws the chips it has
   * columns for rather than empty axes for the ones it does not.
   */
  async compute(
    data: TableData,
    info: { pressureVar?: string; latVar: string; lonVar: string },
    wanted: readonly string[],
  ): Promise<DeriveOutcome> {
    /* **The memo is keyed by the table, not only by the name.** A deployment
       arrives in chunks and the table grows with each one, so a cache that
       remembered only "sa was computed" would hand back the first chunk's
       array for the rest of the load — a 500-element column beside a
       19,000-element one, and a plot drawn from the first 500 that never
       grew. It looked like a slow network and was a stale cache. */
    if (data.rows !== this.cachedRows) {
      this.cache.clear();
      this.cachedRows = data.rows;
    }
    const need = wanted.filter((w) => DERIVED_NAMES.has(w) && !this.cache.has(w));
    if (need.length === 0) return this.outcome(wanted);

    const sp = data.columns.get('salinity');
    const t = data.columns.get('temperature');
    const p = info.pressureVar ? data.columns.get(info.pressureVar) : undefined;
    if (!sp || !t || !p) return this.outcome(wanted);

    const lon = data.columns.get(info.lonVar);
    const lat = data.columns.get(info.latVar);
    const atlas = await this.atlas();

    const worker = this.ensureWorker();
    if (worker) {
      const id = this.nextId++;
      const request: DeriveRequest = {
        id,
        atlas: this.atlasSent ? undefined : (atlas ?? undefined),
        wanted: need,
        /* Copies, because the request transfers nothing back that the page
           still needs — the source columns stay on this side and are read
           again for the next property. */
        sp: sp.slice(), t: t.slice(), p: p.slice(),
        lon: lon?.slice(), lat: lat?.slice(),
      };
      if (request.atlas) this.atlasSent = true;

      const response = await new Promise<DeriveResponse>((resolve) => {
        this.pending.set(id, resolve);
        worker.postMessage(request);
      });

      if (!response.error) {
        for (const [name, values] of Object.entries(response.columns)) {
          this.cache.set(name, values);
        }
        this.referenceOnly ||= response.referenceOnly;
        return this.outcome(wanted);
      }
      /* Fall through to the main thread rather than returning nothing. */
    }

    const inputs: Inputs = { sp, t, p, lon, lat };
    const result = derive(inputs, need, this.decoded(atlas));
    for (const [name, values] of result.columns) this.cache.set(name, values);
    this.referenceOnly ||= result.referenceOnly;
    return this.outcome(wanted);
  }

  /** The atlas, decoded once for the main-thread path.
   *
   * Kept rather than decoded per call: `decodeAtlas` walks 365 KB, and the
   * fallback is used repeatedly once it is used at all. Returning null here
   * is what makes SA fall back to Reference Salinity — reported through
   * `referenceOnly`, never substituted silently. */
  private decodedAtlas: SalinityAtlas | null = null;
  private decoded(buffer: ArrayBuffer | null): SalinityAtlas | null {
    if (!buffer) return null;
    if (!this.decodedAtlas) {
      try {
        this.decodedAtlas = decodeAtlas(buffer);
      } catch {
        return null;
      }
    }
    return this.decodedAtlas;
  }

  private outcome(wanted: readonly string[]): DeriveOutcome {
    const columns = new Map<string, Float64Array>();
    for (const name of wanted) {
      const values = this.cache.get(name);
      if (values) columns.set(name, values);
    }
    return { columns, referenceOnly: this.referenceOnly };
  }
}
