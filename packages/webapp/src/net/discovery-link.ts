/**
 * Agentic Resource Discovery (ARD) `Link` extractor.
 *
 * The ARD spec advertises a capability manifest at
 * `/.well-known/ai-catalog.json`. Beyond the well-known file, a response can
 * point agents at it with a bare `rel="ai-catalog"` relation carried in an RFC
 * 8288 `Link` header (or the equivalent HTML `<link rel="ai-catalog">`):
 *
 *   Link: <https://example.com/.well-known/ai-catalog.json>; rel="ai-catalog"
 *
 * Unlike SLICC's `handoff` / `upskill` rels (which are URI rels under the
 * `https://www.sliccy.ai/rel/` namespace), `ai-catalog` is a bare token
 * defined by the ARD spec — so recognition is a plain token match against the
 * parsed `rel` list.
 *
 * This module is pure — no I/O. It is the `Link`-header half of discovery; the
 * `/.well-known` fallback lives in `well-known-probe.ts`.
 */

import type { DiscoveryKind } from '@slicc/shared-ts';
import type { ParsedLink } from './link-header.js';
import {
  getLinkHeaderValuesFromCdp,
  getLinkHeaderValuesFromHeaders,
  getLinkHeaderValuesFromWebRequest,
  parseLinkHeader,
} from './link-header.js';

/** The bare ARD relation token that advertises an `ai-catalog.json` manifest. */
export const AI_CATALOG_REL = 'ai-catalog';

export interface CatalogMatch {
  /** Always `'ai-catalog'` for a `Link`-header match. */
  kind: DiscoveryKind;
  /** Absolute URL of the advertised `ai-catalog.json` manifest. */
  url: string;
}

/**
 * Find the first ARD `ai-catalog` link in a parsed Link header set.
 *
 * Rel comparison is exact-token and case-sensitive: RFC 8288 relation types
 * are compared as-is, and the ARD spec's canonical token is lowercase
 * `ai-catalog`. Returns `null` when no such relation is present.
 */
export function extractCatalog(links: ParsedLink[]): CatalogMatch | null {
  for (const link of links) {
    if (link.rel.includes(AI_CATALOG_REL)) {
      return { kind: 'ai-catalog', url: link.href };
    }
  }
  return null;
}

/**
 * Stable identity for a discovery artifact, independent of the page URL that
 * advertised it.
 *
 * A site can advertise the same `ai-catalog` rel on every page response (and
 * the well-known probe re-checks the same origin on every navigation), so
 * keying dedup on the page URL would never collapse repeats. Keying on the
 * artifact identity (`origin` + `kind` + manifest `url`) lets callers surface a
 * given discovery once per session and drop repeat sightings.
 *
 * The NUL separator can't appear in an origin, kind token, or URL, so
 * concatenation is collision-free without hashing (mirrors
 * `handoffFingerprint`).
 */
export function discoveryFingerprint(input: {
  origin?: string;
  kind?: string;
  url?: string;
}): string {
  return [input.origin ?? '', input.kind ?? '', input.url ?? ''].join('\u0000');
}

/* ────────── header-shape adapters that go straight to a catalog match ────────── */

export function extractCatalogFromCdpHeaders(
  headers: Record<string, unknown> | undefined,
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
