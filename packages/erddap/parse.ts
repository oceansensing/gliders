/**
 * Reading a tabledap response into typed arrays.
 *
 * The format is `jsonlCSV`: one JSON array per line, no header inside the
 * body, missing values as `null`. It is chosen over `csv` for two reasons
 * that matter more than its ~15% extra bytes. `JSON.parse` gets the quoting
 * and the nulls right for free, where a hand-rolled CSV split has to know
 * that an empty field is *missing* rather than zero — the failure that turns
 * a gap in a record into a line through zero on a plot. And a line-oriented
 * body can be consumed **as it arrives**, so a long chunk paints while it is
 * still downloading rather than after.
 *
 * Everything lands in `Float64Array`, flags and all. One container for the
 * whole page means a plot never has to ask what kind of column it was handed,
 * and NaN is the only "missing" there is — which is also what the plot engine
 * already skips.
 */

import { parseIsoTime } from './url.ts';

/** A column being filled. Doubling growth: a deployment's row count is not
    knowable before the last byte, and re-allocating per row is not viable. */
class Growable {
  buf: Float64Array;
  n = 0;

  constructor(capacity = 4096) {
    this.buf = new Float64Array(capacity);
  }

  push(v: number): void {
    if (this.n === this.buf.length) {
      const next = new Float64Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.n++] = v;
  }

  /** The filled part, as its own array. */
  take(): Float64Array {
    return this.buf.subarray(0, this.n).slice();
  }
}

export interface ParseResult {
  columns: Map<string, Float64Array>;
  rows: number;
}

export interface ParseOptions {
  /** Column names, in the order the server returns them. */
  names: readonly string[];
  /** Which columns hold ISO timestamps rather than numbers. */
  timeColumns?: ReadonlySet<string>;
  /** Called as rows accumulate, so a caller can paint mid-download. */
  onRows?: (rows: number) => void;
  /** How often to call `onRows`. */
  notifyEvery?: number;
}

/**
 * Parse a whole `jsonlCSV` body.
 *
 * Split from the streaming path deliberately: tests hand it a fixture string
 * and get the same arrays the network path produces, with no `ReadableStream`
 * to stand up. The streaming path is the same parser fed differently.
 */
export function parseJsonlCsv(text: string, opts: ParseOptions): ParseResult {
  const sink = new Sink(opts);
  sink.write(text);
  return sink.finish();
}

/**
 * Parse a response body as it streams.
 *
 * Falls back to reading the whole body where the runtime has no
 * `Response.body` — jsdom, in the page tests, being the one that matters.
 */
export async function parseJsonlCsvStream(
  response: Response,
  opts: ParseOptions,
): Promise<ParseResult> {
  const sink = new Sink(opts);
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    sink.write(await response.text());
    return sink.finish();
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    sink.write(decoder.decode(value, { stream: true }));
  }
  sink.write(decoder.decode());
  return sink.finish();
}

/** The line-splitting, row-appending half. Holds a partial trailing line
    between writes, which is the whole reason streaming needs a class. */
class Sink {
  private readonly names: readonly string[];
  private readonly isTime: boolean[];
  private readonly cols: Growable[];
  private readonly onRows?: (rows: number) => void;
  private readonly notifyEvery: number;
  private tail = '';
  private rows = 0;
  private lastNotified = 0;

  constructor(opts: ParseOptions) {
    this.names = opts.names;
    this.isTime = opts.names.map((n) => opts.timeColumns?.has(n) ?? false);
    this.cols = opts.names.map(() => new Growable());
    this.onRows = opts.onRows;
    this.notifyEvery = opts.notifyEvery ?? 20000;
  }

  write(chunk: string): void {
    const text = this.tail + chunk;
    let from = 0;
    for (;;) {
      const nl = text.indexOf('\n', from);
      if (nl < 0) break;
      this.line(text.slice(from, nl));
      from = nl + 1;
    }
    this.tail = text.slice(from);

    if (this.onRows && this.rows - this.lastNotified >= this.notifyEvery) {
      this.lastNotified = this.rows;
      this.onRows(this.rows);
    }
  }

  private line(raw: string): void {
    const line = raw.charCodeAt(raw.length - 1) === 13 ? raw.slice(0, -1) : raw;
    /* Blank lines, and the `columnNames` line some ERDDAP versions put first
       when the request asked for it. Only `[` starts a data row. */
    if (line.length === 0 || line.charCodeAt(0) !== 91 /* [ */) return;

    let values: unknown[];
    try {
      values = JSON.parse(line) as unknown[];
    } catch {
      /* A truncated last line, which happens when a response is cut off
         mid-flight. Dropping the row is right; guessing at it is not. */
      return;
    }

    for (let i = 0; i < this.cols.length; i++) {
      this.cols[i].push(this.value(values[i], i));
    }
    this.rows++;
  }

  private value(v: unknown, i: number): number {
    if (v === null || v === undefined) return NaN;
    if (this.isTime[i]) return typeof v === 'string' ? parseIsoTime(v) : Number(v);
    if (typeof v === 'number') return v;
    /* A String column asked for by name — `trajectory`, `source_file`. It has
       no numeric meaning, and NaN says so rather than 0 pretending to. */
    const n = Number(v);
    return n === n && (v as string) !== '' ? n : NaN;
  }

  finish(): ParseResult {
    if (this.tail.length) {
      this.line(this.tail);
      this.tail = '';
    }
    const columns = new Map<string, Float64Array>();
    for (let i = 0; i < this.names.length; i++) {
      columns.set(this.names[i], this.cols[i].take());
    }
    this.onRows?.(this.rows);
    return { columns, rows: this.rows };
  }
}
