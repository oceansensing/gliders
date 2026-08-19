#!/usr/bin/env node
/**
 * The ERDDAP client, against saved responses.
 *
 *   npm run test:erddap
 *
 * No network: `scripts/fixtures/erddap/` holds real documents captured from
 * gliders.ioos.us on 2026-08-18 — the catalog, a 2026 dataset's `info`, a
 * 2018 dataset's `info`, and a page of `jsonlCSV` rows including a null
 * measurement and a null flag.
 *
 * What is checked here is what the package promises and what would be
 * expensive to notice in a browser: that a query is *built* the way ERDDAP
 * parses it, that an empty result is read as data rather than as a failure,
 * and that a missing value becomes NaN rather than zero.
 */

import fs from 'node:fs';
import { check, done, near, ok, section } from './lib/check.mjs';
import {
  catalogUrl, infoUrl, tabledapUrl, isoTime, parseIsoTime,
} from '../packages/erddap/url.ts';
import { parseJsonlCsv } from '../packages/erddap/parse.ts';
import { listDatasets, parseInfo, request, ErddapError } from '../packages/erddap/catalog.ts';
import { fetchData } from '../packages/erddap/fetch.ts';
import { applyFlags, qcColumnFor, isFlagColumn, QARTOD } from '../packages/erddap/qc.ts';

const read = (name) => JSON.parse(fs.readFileSync(`scripts/fixtures/erddap/${name}`, 'utf8'));
const BASE = 'https://gliders.ioos.us/erddap';

section('URLs');

{
  const url = tabledapUrl(BASE, 'electa-20260807T1633', 'jsonlCSV',
    ['time', 'depth', 'temperature'],
    { start: 1754000000, end: 1754086400, timeVar: 'time' });
  /* The variable list is the query before the first `&`, comma-separated and
     *not* percent-encoded — encoding the commas makes the server read one
     nonsense variable name and answer 404. */
  ok('variables are comma-separated and unencoded',
    url.includes('.jsonlCSV?time,depth,temperature'), url.slice(0, 90));
  ok('the >= operator is encoded but kept as an operator',
    url.includes('&time%3E=2025-07-31T22:13:20Z'), url);
  ok('the <= operator likewise', url.includes('&time%3C='), url);
}

{
  const url = tabledapUrl(BASE, 'x', 'csv', ['time', 'depth'],
    { binMetres: 5, depthVar: 'depth', timeVar: 'time' });
  ok('the depth bin groups by profile time',
    url.includes('orderByClosest(%22time,depth/5%22)'), url);
  /* ERDDAP applies orderBy after the constraints and rejects a query where
     one precedes the other, so this must always be last. */
  const url2 = tabledapUrl(BASE, 'x', 'csv', ['time', 'depth'],
    { binMetres: 5, depthVar: 'depth', timeVar: 'time', start: 1, end: 2 });
  ok('and always comes after the constraints',
    url2.indexOf('orderByClosest') > url2.lastIndexOf('time%3C'), url2);
}

check('an epoch is written as ERDDAP wants it', isoTime(1754086400), '2025-08-01T22:13:20Z');
check('and read back', parseIsoTime('2025-08-01T22:13:20Z'), 1754086400);
check('a bad stamp is NaN, not zero', parseIsoTime('not a time'), NaN);
ok('the catalog takes no paging parameters',
  !catalogUrl(BASE).includes('page') && !catalogUrl(BASE).includes('itemsPerPage'),
  catalogUrl(BASE));
ok('info is asked for as JSON', infoUrl(BASE, 'x').endsWith('/info/x/index.json'));

section('parsing rows');

{
  const text = fs.readFileSync('scripts/fixtures/erddap/rows-electa.jsonl', 'utf8');
  const names = ['time', 'latitude', 'longitude', 'depth', 'pressure',
    'temperature', 'salinity', 'conductivity', 'qartod_temperature_primary_flag'];
  const { columns, rows } = parseJsonlCsv(text, { names, timeColumns: new Set(['time']) });

  ok('every row parsed', rows > 100, `${rows} rows`);
  check('every column is the same length', columns.get('temperature').length, rows);
  ok('time became epoch seconds',
    columns.get('time')[0] > 1.7e9 && columns.get('time')[0] < 1.9e9,
    String(columns.get('time')[0]));

  /* The fixture's flag column is entirely null — this deployment's QARTOD
     had not run when it was captured — which is the case that matters: a
     null flag must not read as 0, because 0 is a QARTOD value. */
  const flags = columns.get('qartod_temperature_primary_flag');
  ok('a null flag is NaN, not zero', Number.isNaN(flags[0]), String(flags[0]));

  const temps = [...columns.get('temperature')].filter(Number.isFinite);
  ok('temperatures are in range',
    Math.min(...temps) > 0 && Math.max(...temps) < 40,
    `${Math.min(...temps).toFixed(2)}…${Math.max(...temps).toFixed(2)} °C`);
}

{
  /* A body cut off mid-line, which is what a dropped connection produces.
     The truncated row is dropped rather than half-parsed. */
  const good = '["2026-08-10T00:00:00Z", 1.5]\n["2026-08-10T00:00:01Z", 2.5]\n';
  const cut = `${good}["2026-08-10T00:00:02Z", 3.`;
  const a = parseJsonlCsv(good, { names: ['time', 'x'], timeColumns: new Set(['time']) });
  const b = parseJsonlCsv(cut, { names: ['time', 'x'], timeColumns: new Set(['time']) });
  check('a whole body reads every row', a.rows, 2);
  check('a truncated last row is dropped, not guessed', b.rows, 2);
}

section('the catalog');

{
  const doc = read('catalog.json');
  const fetchImpl = async () => new Response(JSON.stringify(doc), { status: 200 });
  const list = await listDatasets({ fetchImpl });
  ok('deployments came back', list.length > 5, `${list.length}`);
  ok('`allDatasets` is not one of them', !list.some((d) => d.id === 'allDatasets'));
  const one = list[0];
  ok('times are epoch seconds', one.start > 1e9 && one.end >= one.start,
    `${one.start} → ${one.end}`);
  ok('a bounding box came through',
    Number.isFinite(one.west) && Number.isFinite(one.north), JSON.stringify(one));
}

section('an empty result is a 404');

{
  /* Measured against the live server: a query matching no rows answers 404
     with `nRows = 0` in the body. Read as a failure it turns a gap in a
     deployment into a broken page. */
  const body = 'Error { code=404; message="Not Found: Your query produced no matching results. (nRows = 0)"; }';
  const fetchImpl = async () => new Response(body, { status: 404, statusText: 'Not Found' });
  let caught;
  try {
    await request('https://example.invalid/x', { fetchImpl });
  } catch (error) {
    caught = error;
  }
  ok('it throws an ErddapError', caught instanceof ErddapError);
  ok('flagged as empty rather than broken', caught?.empty === true, String(caught?.message));

  const real = async () => new Response('boom', { status: 500, statusText: 'Server Error' });
  let other;
  try {
    await request('https://example.invalid/x', { fetchImpl: real });
  } catch (error) {
    other = error;
  }
  ok('a real failure is not flagged empty', other?.empty === false, String(other?.message));
}

section('an unreadable window is a gap, not a broken deployment');

{
  /* The subtlest thing about this server. Its *error* responses carry no
     `Access-Control-Allow-Origin` header, so in a browser a 404 — which is
     how it reports an empty time window — arrives as a bare network
     TypeError with no status to inspect. Empty windows are normal: a glider
     on the surface, a day without telemetry.
     So a chunk that cannot be read counts as empty, and only *every* window
     being unreadable is treated as the server being down. */
  const info = parseInfo('electa-20260807T1633', read('info-electa.json'));
  const rows = fs.readFileSync('scripts/fixtures/erddap/rows-electa.jsonl', 'utf8');

  let call = 0;
  const flaky = async () => {
    call++;
    // The probe answers; one later window is unreadable, as a real gap is.
    if (call === 2) throw new TypeError('Failed to fetch');
    return new Response(rows, { status: 200 });
  };
  const data = await fetchData('electa-20260807T1633', info, {
    variables: ['temperature', 'salinity'],
    start: 1786500000, end: 1786500000 + 3 * 86400,
    fetchImpl: flaky, concurrency: 1, now: () => 0,
  });
  ok('the rest of the deployment still arrived', data.rows > 0, `${data.rows} rows`);
  ok('and the result says it is incomplete', data.partial === true);

  const dead = async () => { throw new TypeError('Failed to fetch'); };
  let outage;
  try {
    await fetchData('electa-20260807T1633', info, {
      variables: ['temperature'],
      start: 1786500000, end: 1786500000 + 3 * 86400,
      fetchImpl: dead, concurrency: 1, now: () => 0,
    });
  } catch (error) {
    outage = error;
  }
  /* Nothing readable anywhere is a server that is not answering, and saying
     "this deployment is empty" would be a lie the reader cannot check. */
  ok('but a total outage is reported as one', outage instanceof ErddapError,
    String(outage?.message));
}

section('the depth bin is chosen from the glider');

{
  /* Vertical sampling varies by an order of magnitude across the archive, so
     a fixed bin is wrong at one end or the other: measured, 5 m keeps an
     eighth of a shelf glider's profile and essentially all of a deep one's.
     The finest bin is tried first and coarsened only when the deployment
     really would be too large at it. */
  const info = parseInfo('electa-20260807T1633', read('info-electa.json'));
  const rows = fs.readFileSync('scripts/fixtures/erddap/rows-electa.jsonl', 'utf8');
  const span = 30 * 86400;

  const seen = [];
  const record = async (url) => {
    const m = /depth\/(\d+)/.exec(url);
    seen.push(m ? Number(m[1]) : 0);
    return new Response(rows, { status: 200 });
  };

  /* A budget the fixture cannot blow: 163 rows in six hours projects to
     ~19,500 over 30 days, so the finest bin is kept. */
  seen.length = 0;
  const fine = await fetchData('electa-20260807T1633', info, {
    variables: ['temperature'], start: 0, end: span,
    binMetres: 1, binCandidates: [2, 5, 10], targetRows: 250_000,
    fetchImpl: record, concurrency: 1, now: () => 0, maxChunks: 2,
  });
  check('a deployment that fits keeps the finest bin', fine.resolution.binMetres, 1);
  check('and only probed once', seen[0], 1);

  /* A budget it cannot meet: every candidate is *measured* rather than
     extrapolated, because rows do not scale as 1/bin — halving the bin took
     one real deployment from 18,673 rows to 44,592, not to 93,000. */
  seen.length = 0;
  const coarse = await fetchData('electa-20260807T1633', info, {
    variables: ['temperature'], start: 0, end: span,
    binMetres: 1, binCandidates: [2, 5, 10], targetRows: 100,
    fetchImpl: record, concurrency: 1, now: () => 0, maxChunks: 2,
  });
  check('an over-budget deployment coarsens to the last candidate',
    coarse.resolution.binMetres, 10);
  ok('having probed each candidate in turn',
    seen.slice(0, 4).join(',') === '1,2,5,10', seen.slice(0, 6).join(','));

  /* And the bin it settled on is the one every later chunk uses, rather
     than the finest one it happened to probe with first. */
  ok('the chosen bin is what the rest of the fetch asks for',
    seen.slice(4).every((b) => b === 10), seen.join(','));
}

section('dataset info, 2026 and 2018');

{
  const info = parseInfo('electa-20260807T1633', read('info-electa.json'));
  check('the time axis', info.timeVar, 'time');
  check('the depth axis', info.depthVar, 'depth');
  check('the pressure axis', info.pressureVar, 'pressure');
  ok('institution came from the globals', /Virginia/.test(info.institution), info.institution);

  const temp = info.variables.find((v) => v.name === 'temperature');
  check('temperature is not ancillary', temp.ancillary, false);
  check('and units are as published', temp.units, 'degrees_C');
  check('its QC column is the rolled-up primary flag',
    temp.qcColumn, 'qartod_temperature_primary_flag');

  const flag = info.variables.find((v) => v.name === 'qartod_temperature_primary_flag');
  check('a flag column is ancillary', flag.ancillary, true);

  /* The DAC publishes pressure in dbar and temperature in ITS-90 °C, which
     is what TEOS-10 wants. If this ever changes, the derived properties are
     silently wrong by a factor of ten — so it is asserted rather than
     assumed. */
  check('pressure is dbar', info.variables.find((v) => v.name === 'pressure').units, 'dbar');

  const engineering = info.variables.find((v) => v.name === 'commanded_fin');
  ok('flight-computer channels survive', engineering && !engineering.ancillary,
    String(engineering?.ancillary));
}

{
  const old = parseInfo('amelia-20180501T0000', read('info-amelia-2018.json'));
  ok('an eight-year-old dataset still parses', old.variables.length > 40,
    `${old.variables.length} variables`);
  check('with the same core axes', `${old.timeVar}/${old.latVar}/${old.depthVar}`,
    'time/latitude/depth');
  const temp = old.variables.find((v) => v.name === 'temperature');
  /* It carries both families; the primary flag must win over `_qc`. */
  check('the primary flag wins over the legacy _qc column',
    temp.qcColumn, 'qartod_temperature_primary_flag');
}

section('QC flags');

{
  const names = new Set(['salinity', 'salinity_qc']);
  check('the legacy column is found when there is no primary',
    qcColumnFor('salinity', names), 'salinity_qc');
  check('nothing is invented', qcColumnFor('salinity', new Set(['salinity'])), undefined);
  ok('a flag column is recognised as one', isFlagColumn('qartod_salinity_primary_flag'));
  ok('and so is the legacy form', isFlagColumn('salinity_qc'));
  ok('a measurement is not', !isFlagColumn('salinity'));

  const values = Float64Array.from([10, 11, 12, 13, 14]);
  const flags = Float64Array.from([QARTOD.PASS, QARTOD.SUSPECT, QARTOD.FAIL, QARTOD.MISSING, NaN]);
  const blanked = applyFlags(values, flags);
  check('fail is blanked', values[2], NaN);
  check('missing is blanked', values[3], NaN);
  /* Suspect is kept on purpose: a spike test fires on real thermoclines, and
     hiding "suspect" by default would delete signal. */
  check('suspect is kept', values[1], 11);
  check('pass is kept', values[0], 10);
  /* An unpopulated flag column — which realtime datasets have — must not
     reject everything. */
  check('an unflagged row is kept', values[4], 14);
  check('and the count is reported', blanked, 2);
}

done();
