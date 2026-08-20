/**
 * QARTOD flags.
 *
 * The DAC publishes two families and a dataset may carry either or both:
 *
 *   - `qartod_<var>_primary_flag`, plus one column per test
 *     (`gross_range`, `spike`, `rate_of_change`, `flat_line`,
 *     `climatological`). The primary flag is the roll-up — the worst of the
 *     tests — and is the one to act on.
 *   - `<var>_qc`, the older per-variable flag. Every 2018-era dataset
 *     checked carries these and no primary flag.
 *
 * The scale is IOOS QARTOD's:
 *
 *   1 pass · 2 not evaluated · 3 suspect · 4 fail · 9 missing
 *
 * **3 is kept by default and 4 is not.** A spike test that fires on a real
 * thermocline is common enough that hiding "suspect" would quietly delete
 * signal; a "fail" is the test saying the number is not a measurement. The
 * page carries a control for this, and says which way it is set, because
 * either default is wrong for somebody.
 */

export const QARTOD = {
  PASS: 1,
  NOT_EVALUATED: 2,
  SUSPECT: 3,
  FAIL: 4,
  MISSING: 9,
} as const;

/** Flags whose rows are dropped when QC filtering is on. */
export const DEFAULT_REJECT: readonly number[] = [QARTOD.FAIL, QARTOD.MISSING];

/**
 * The flag column belonging to `variable`, chosen from what the dataset has.
 *
 * The primary flag wins over the older `_qc` where a dataset carries both,
 * because it is the roll-up rather than one test's opinion.
 */
export function qcColumnFor(variable: string, available: ReadonlySet<string>): string | undefined {
  const primary = `qartod_${variable}_primary_flag`;
  if (available.has(primary)) return primary;
  const legacy = `${variable}_qc`;
  if (available.has(legacy)) return legacy;
  return undefined;
}

/** True for a column that *is* a flag rather than one that has one. */
export function isFlagColumn(name: string): boolean {
  return /^qartod_.*_flag$/.test(name) || /_qc$/.test(name);
}

/**
 * Blank out values their own flag rejects.
 *
 * In place, and only the flagged column — not the whole row. A temperature
 * that failed its spike test says nothing about the salinity measured beside
 * it, and dropping the row would throw away a good number to hide a bad one.
 */
export function applyFlags(
  values: Float64Array,
  flags: Float64Array,
  reject: readonly number[] = DEFAULT_REJECT,
): number {
  const n = Math.min(values.length, flags.length);
  let blanked = 0;
  for (let i = 0; i < n; i++) {
    const f = flags[i];
    if (f === f && reject.includes(f)) {
      if (values[i] === values[i]) blanked++;
      values[i] = NaN;
    }
  }
  return blanked;
}

/**
 * Blank out the surfacing records some datasets publish as zeros.
 *
 * **A fill value the publisher forgot to mark, which reads as a measurement
 * of fresh water at freezing point.** `cp_1155-20260429T1457` carries one row
 * per surfacing — 170 of them in a four-week window, 1.5% of the record — on
 * which *every* science column is a placeholder: depth, pressure,
 * temperature, salinity, conductivity, chlorophyll, CDOM and PAR are all
 * exactly `0`, and the published density is 999.8445, which is what TEOS-10
 * returns for fresh water at 0 °C. The position and the timestamp are real;
 * that GPS fix is why the row exists at all.
 *
 * Left in, one such row is enough to be visible everywhere at once:
 *
 * - the T–S diagram's axes ran from **SA 0.000** and **CT 0.015**, so every
 *   real sample was crushed into the top-right corner of the plot;
 * - the σ₀ colour bar started at **−0.157 kg/m³**, a negative anomaly no
 *   ocean has;
 * - and the robust 2–98% limits could not save it, because at 3.2% of the
 *   samples with a value the placeholders reach past the 2nd percentile.
 *
 * **The test is the conjunction, and it is exact.** Temperature, salinity and
 * pressure all precisely `0` is not something seawater does — not in the
 * Great Lakes datasets, where the water is fresh but never 0.0000 °C, and not
 * under ice, where it is cold but never 0.0000 dbar. Anything less strict
 * than all three at once would start deleting measurements.
 *
 * Everything on the row goes, not only the three that were tested: a
 * dissolved-oxygen value computed with temperature and salinity compensation
 * from zeros is not a measurement either, whatever it says. Time and position
 * are kept, so the track still shows the glider surfacing.
 *
 * Unconditional, unlike the QARTOD filter, and reported rather than silent —
 * a flag is a test's opinion about a number, and this is not a number.
 */
export function dropFillRows(
  columns: ReadonlyMap<string, Float64Array>,
  rows: number,
  keep: readonly (string | undefined)[],
  probes: readonly (string | undefined)[],
): number {
  const triple = probes
    .map((name) => (name ? columns.get(name) : undefined))
    .filter((c): c is Float64Array => c !== undefined);
  /* All three have to be present to make the judgement. With only two of
     them the conjunction is weaker than it looks, and the whole defence of
     this rule is how narrow it is. */
  if (triple.length < 3) return 0;

  const spare = new Set(keep.filter((n): n is string => Boolean(n)));
  const clear: Float64Array[] = [];
  for (const [name, values] of columns) {
    if (!spare.has(name) && !isFlagColumn(name)) clear.push(values);
  }

  let dropped = 0;
  for (let i = 0; i < rows; i++) {
    if (!triple.every((c) => c[i] === 0)) continue;
    dropped++;
    for (const c of clear) c[i] = NaN;
  }
  return dropped;
}
