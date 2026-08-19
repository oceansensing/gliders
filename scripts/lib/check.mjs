/**
 * The tiny harness every test here uses.
 *
 * Deliberately not a framework: these run under `node --experimental-strip-types`
 * against TypeScript sources with no build step, and a runner that needs its
 * own transform would put a build between the code and its check.
 */

let failures = 0;
let checks = 0;

/** Assert, and say what was compared either way. */
export function check(what, got, want) {
  checks++;
  const ok = Object.is(got, want) || (typeof got === 'number' && typeof want === 'number'
    && Number.isNaN(got) && Number.isNaN(want));
  if (ok) {
    console.log(`ok    ${what}`);
  } else {
    failures++;
    console.log(`FAIL  ${what}\n        got  ${format(got)}\n        want ${format(want)}`);
  }
  return ok;
}

/** Assert a condition, with the value printed when it does not hold. */
export function ok(what, condition, detail = '') {
  checks++;
  if (condition) {
    console.log(`ok    ${what}${detail ? `  ${detail}` : ''}`);
  } else {
    failures++;
    console.log(`FAIL  ${what}${detail ? `\n        ${detail}` : ''}`);
  }
  return Boolean(condition);
}

/** Assert two numbers agree to `tolerance`. */
export function near(what, got, want, tolerance) {
  const delta = Math.abs(got - want);
  return ok(
    what,
    Number.isFinite(delta) && delta <= tolerance,
    `got ${format(got)}, want ${format(want)} ± ${tolerance} (off by ${format(delta)})`,
  );
}

/** Assert that `fn` throws, optionally matching a pattern. */
export function throws(what, fn, pattern) {
  checks++;
  try {
    fn();
    failures++;
    console.log(`FAIL  ${what}\n        it did not throw`);
    return false;
  } catch (error) {
    if (pattern && !pattern.test(String(error?.message ?? error))) {
      failures++;
      console.log(`FAIL  ${what}\n        threw ${error?.message}, wanted ${pattern}`);
      return false;
    }
    console.log(`ok    ${what}`);
    return true;
  }
}

export function section(title) {
  console.log(`\n-- ${title} --`);
}

/** Exit non-zero if anything failed. Called at the end of every suite. */
export function done() {
  console.log('');
  if (failures) {
    console.log(`${failures} of ${checks} checks failed`);
    process.exit(1);
  }
  console.log(`all ${checks} checks passed`);
}

function format(v) {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (v instanceof Float64Array) return `Float64Array(${v.length})`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
