/**
 * @c4po/erddap — reading glider deployments from an ERDDAP tabledap server.
 *
 * Written against the IOOS Glider DAC (`gliders.ioos.us/erddap`, ERDDAP
 * 2.30), which is the only server it is tested against — but the base URL is
 * a parameter throughout, because the same three endpoints are what every
 * ERDDAP serves.
 *
 * No DOM, no framework, one dependency-free module per concern, so the tests
 * run under Node's type stripping with fixtures and no network.
 *
 * The two things that are easy to get wrong, both measured rather than
 * assumed, are written up where they live: the request-shape economics in
 * `fetch.ts`, and the fact that **an empty result is an HTTP 404** in
 * `catalog.ts`.
 */

export { listDatasets, datasetInfo, parseInfo, request, ErddapError, DEFAULT_BASE } from './catalog.ts';
export type { RequestOptions } from './catalog.ts';

export { fetchData } from './fetch.ts';
export type { FetchOptions, Progress } from './fetch.ts';

export { parseJsonlCsv, parseJsonlCsvStream } from './parse.ts';
export type { ParseOptions, ParseResult } from './parse.ts';

export {
  tabledapUrl, infoUrl, catalogUrl, datasetPageUrl, isoTime, parseIsoTime,
} from './url.ts';
export type { QueryOptions } from './url.ts';

export {
  QARTOD, DEFAULT_REJECT, qcColumnFor, isFlagColumn, applyFlags,
} from './qc.ts';

export type {
  DatasetInfo, DeploymentSummary, Resolution, TableData, VariableInfo,
} from './types.ts';
