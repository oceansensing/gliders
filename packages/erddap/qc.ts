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
