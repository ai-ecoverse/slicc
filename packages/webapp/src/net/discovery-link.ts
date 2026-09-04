/**
 * Agentic Resource Discovery (ARD) `Link` extractor — moved to
 * @slicc/shared-ts (#2276 slice E) so the thin chrome extension can import
 * it without reaching into packages/webapp/src. Re-exported here so no
 * webapp-internal import path changes.
 */

export type { CatalogMatch, CdpResponseHeaders } from '@slicc/shared-ts';
export {
  AI_CATALOG_REL,
  discoveryFingerprint,
  extractCatalog,
  extractCatalogFromCdpHeaders,
  extractCatalogFromFetchHeaders,
  extractCatalogFromWebRequest,
} from '@slicc/shared-ts';
