/**
 * RFC 8288 Web Linking — moved to @slicc/shared-ts (#2276 slice E) so the
 * thin chrome extension can import it without reaching into
 * packages/webapp/src. Re-exported here so no webapp-internal import path
 * changes.
 */

export type { CdpNetworkResponseHeaders, LinkInput, ParsedLink } from '@slicc/shared-ts';
export {
  decodeExtValue,
  formatLink,
  formatLinkHeader,
  getLinkHeaderValuesFromCdp,
  getLinkHeaderValuesFromHeaders,
  getLinkHeaderValuesFromWebRequest,
  parseLinkHeader,
} from '@slicc/shared-ts';
