/**
 * proxy-headers — moved to @slicc/shared-ts (#2276 slice E) so the thin
 * chrome extension can import it without reaching into
 * packages/webapp/src. Re-exported here so no webapp-internal import path
 * changes.
 */
export {
  decodeForbiddenRequestHeaders,
  decodeForbiddenResponseHeaders,
  encodeForbiddenRequestHeaders,
  headersToRecord,
  normalizeHeadersInit,
} from '@slicc/shared-ts';
