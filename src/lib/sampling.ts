/**
 * How finely a glider sampled the water column.
 *
 * **The number a reader needs when narrowing the window changes nothing.**
 *
 * There are two limits on a section's vertical resolution and they look
 * identical on screen. One is the depth bin this site chose, which answers
 * "how much of the record can we afford" and gets finer as the window
 * narrows. The other is how far apart the glider's own science samples are,
 * which no request can improve.
 *
 * The page has always reported the first and never the second, and for a
 * mission where the second is binding that reads as a bug:
 * `cp_1155-20260429T1457` is a Pioneer glider whose samples are **9.8 m**
 * apart, so its 1 m bin, a 5 m bin and every sample it took are within 3% of
 * one another. Narrowing the window loads the data at full rate, exactly as
 * intended, and the section looks the same — because it is the same.
 */

/**
 * The median absolute step between consecutive fixes that carry a depth.
 *
 * The **median**, because the turn at the bottom of each profile contributes
 * one large step per dive: a mean folds those in and reports a spacing the
 * glider never sampled at. The median steps over them without needing to
 * know where the profiles begin.
 *
 * `null` below fifty steps — a handful of samples has no typical spacing, and
 * a caption that says "about 3 m" on the strength of four of them is worse
 * than one that says nothing.
 */
export function medianVerticalStep(
  depth: ArrayLike<number> | undefined,
  rows: number,
  minimum = 50,
): number | null {
  if (!depth) return null;
  const steps: number[] = [];
  let prev = NaN;
  for (let i = 0; i < rows; i++) {
    const d = depth[i];
    if (!Number.isFinite(d)) continue;
    if (Number.isFinite(prev)) {
      const step = Math.abs(d - prev);
      /* Zero steps are the same depth reported twice — a sample, not a
         spacing — and would drag the median to nothing on any record that
         repeats a fix. */
      if (step > 0) steps.push(step);
    }
    prev = d;
  }
  if (steps.length < minimum) return null;
  steps.sort((a, b) => a - b);
  return steps[Math.floor(steps.length / 2)];
}

/**
 * Whether the chosen bin is what is limiting the section, rather than the
 * glider.
 *
 * Half a bin of slack: a 1 m bin against 1.2 m sampling is not a limit
 * anybody can see, and telling a reader to narrow the window for it would
 * send them after 20% they will not notice. With no measured spacing the
 * answer is yes — the advice to narrow was the old behaviour and is the safe
 * one to keep when there is nothing to say otherwise.
 */
export function binIsTheLimit(binMetres: number, step: number | null): boolean {
  if (!(binMetres > 0)) return false;
  return step === null || binMetres > step * 1.5;
}

/** Rounded the way a spacing is spoken: "about 10 m", "about 0.6 m". */
export function spokenMetres(m: number): string {
  return m >= 10 ? m.toFixed(0) : m >= 1 ? m.toFixed(1) : m.toFixed(2);
}
