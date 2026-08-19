/**
 * The derived properties, off the main thread.
 *
 * Measured: 3.6 µs a sample for the whole chain, so a 200,000-row overview
 * is about 0.7 s of arithmetic. That is not slow, but it is far longer than
 * a frame, and it lands exactly while chunks are still arriving and the
 * progress bar is meant to be moving. The worker is here to keep that bar
 * honest, not because the Gibbs function is expensive.
 *
 * `@c4po/teos10` imports no DOM, by design, which is what lets it be loaded
 * here at all.
 */

import { decodeAtlas, type SalinityAtlas } from '@c4po/teos10/atlas';
import { derive, type Inputs } from './seawater.ts';

export interface DeriveRequest {
  id: number;
  /** The SAAR atlas, inflated, sent once. Kept across requests. */
  atlas?: ArrayBuffer;
  wanted: string[];
  sp: Float64Array;
  t: Float64Array;
  p: Float64Array;
  lon?: Float64Array;
  lat?: Float64Array;
}

export interface DeriveResponse {
  id: number;
  columns: Record<string, Float64Array>;
  referenceOnly: boolean;
  counts: Record<string, number>;
  error?: string;
}

let atlas: SalinityAtlas | null = null;

self.addEventListener('message', (event: MessageEvent<DeriveRequest>) => {
  const req = event.data;
  try {
    /* Sent once and kept: the atlas is 365 KB inflated, and a page that
       re-sent it per variable would copy it a dozen times over a session. */
    if (req.atlas) atlas = decodeAtlas(req.atlas);

    const inputs: Inputs = {
      sp: req.sp, t: req.t, p: req.p, lon: req.lon, lat: req.lat,
    };
    const result = derive(inputs, req.wanted, atlas);

    const columns: Record<string, Float64Array> = {};
    const transfer: ArrayBuffer[] = [];
    for (const [name, values] of result.columns) {
      columns[name] = values;
      transfer.push(values.buffer as ArrayBuffer);
    }

    const response: DeriveResponse = {
      id: req.id,
      columns,
      referenceOnly: result.referenceOnly,
      counts: Object.fromEntries(result.counts),
    };
    /* Transferred rather than copied: these are the arrays the plot will
       read, and at a million rows a copy is 8 MB per property. */
    (self as unknown as Worker).postMessage(response, transfer);
  } catch (error) {
    const response: DeriveResponse = {
      id: req.id,
      columns: {},
      referenceOnly: false,
      counts: {},
      error: (error as Error).message,
    };
    (self as unknown as Worker).postMessage(response);
  }
});
