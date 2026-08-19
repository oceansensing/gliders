/**
 * Colour limits that a single bad sample cannot set.
 *
 * The engine's own bounds are the honest ones — the true minimum and maximum
 * of what it was given — and for an *axis* that is right: a plot must not
 * hide a point by scaling it off the edge.
 *
 * A **colour** axis is a different question. It is a lookup table with a few
 * dozen entries, and stretching it to reach one outlier spends nearly all of
 * them on water that is not there. A real case from the DAC: a chlorophyll
 * record whose minimum is −0.08 µg/L — a negative concentration, which does
 * not exist — and whose 98th percentile is a tenth of its maximum. Scaled to
 * the extremes, the entire shelf bloom rendered in the bottom two colours of
 * a twenty-four-colour ramp.
 *
 * So the default colour limits are percentiles. 2 and 98 are the convention
 * (matplotlib's `robust`, xarray's, cmocean's own examples), and they are a
 * *default*: the reader's own limits always win, and the colour bar always
 * shows the numbers actually in force, so nothing here is hidden.
 *
 * **Values outside the range are drawn at the end colours, not dropped.**
 * `plot()` clamps the bin index, so a sample beyond the 98th percentile is
 * still on screen in the last colour — the picture never omits a point that
 * the data contains.
 */

/** The percentiles used when nothing else is asked for. */
export const ROBUST_LOW = 2;
export const ROBUST_HIGH = 98;

/**
 * Percentile limits over `values`, or null when there is nothing to measure.
 *
 * **Sampled rather than fully sorted.** A section is a few hundred thousand
 * samples and this runs on every redraw; sorting a copy of all of them costs
 * more than the drawing does. At 20,000 samples a percentile is settled to
 * far more precision than a colour bar can show, and the stride is
 * deterministic so the same data gives the same limits every time.
 */
export function robustRange(
  values: ArrayLike<number>,
  n: number,
  low = ROBUST_LOW,
  high = ROBUST_HIGH,
  sampleCap = 20000,
): [number, number] | null {
  const count = Math.min(n, values.length);
  if (count < 1) return null;

  const stride = Math.max(1, Math.ceil(count / sampleCap));
  const sample: number[] = [];
  for (let i = 0; i < count; i += stride) {
    const v = values[i];
    if (Number.isFinite(v)) sample.push(v);
  }
  if (sample.length < 2) return null;

  sample.sort((a, b) => a - b);
  const at = (pct: number): number => {
    const idx = (pct / 100) * (sample.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return lo === hi ? sample[lo] : sample[lo] + (sample[hi] - sample[lo]) * (idx - lo);
  };

  const lo = at(low);
  const hi = at(high);
  /* A field that is flat over the middle 96% — a constant, or a mostly-empty
     column with a few spikes — gets its full range back rather than a
     zero-width scale that would paint everything one colour. */
  if (!(hi > lo)) {
    const min = sample[0];
    const max = sample[sample.length - 1];
    return max > min ? [min, max] : null;
  }
  return [lo, hi];
}
