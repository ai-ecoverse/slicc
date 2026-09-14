import type { DiscoveryKind } from './agent-wire-types.js';
import type { ParsedLink } from './link-header.js';
import {
  getLinkHeaderValuesFromCdp,
  getLinkHeaderValuesFromHeaders,
  getLinkHeaderValuesFromWebRequest,
  parseLinkHeader,
} from './link-header.js';

export const AI_CATALOG_REL = 'ai-catalog';

export type CdpResponseHeaders = Record<string, string>;

export interface CatalogMatch {
  kind: DiscoveryKind;

  url: string;
}

export function extractCatalog(links: ParsedLink[]): CatalogMatch | null {
  for (const link of links) {
    if (link.rel.includes(AI_CATALOG_REL)) {
      return { kind: 'ai-catalog', url: link.href };
    }
  }
  return null;
}

export function discoveryFingerprint(input: {
  origin?: string;
  kind?: string;
  url?: string;
}): string {
  return [input.origin ?? '', input.kind ?? '', input.url ?? ''].join('\u0000');
}

export function extractCatalogFromCdpHeaders(
  headers: CdpResponseHeaders | undefined,
  baseUrl?: string
): { match: CatalogMatch | null; links: ParsedLink[] } {
  const values = getLinkHeaderValuesFromCdp(headers);
  if (values.length === 0) return { match: null, links: [] };
  const links = parseLinkHeader(values, baseUrl);
  return { match: extractCatalog(links), links };
}

export function extractCatalogFromWebRequest(
  headers: Array<{ name: string; value?: string }> | undefined,
  baseUrl?: string
): { match: CatalogMatch | null; links: ParsedLink[] } {
  const values = getLinkHeaderValuesFromWebRequest(headers);
  if (values.length === 0) return { match: null, links: [] };
  const links = parseLinkHeader(values, baseUrl);
  return { match: extractCatalog(links), links };
}

export function extractCatalogFromFetchHeaders(
  headers: Headers | undefined,
  baseUrl?: string
): { match: CatalogMatch | null; links: ParsedLink[] } {
  const values = getLinkHeaderValuesFromHeaders(headers);
  if (values.length === 0) return { match: null, links: [] };
  const links = parseLinkHeader(values, baseUrl);
  return { match: extractCatalog(links), links };
}
