/**
 * SLICC handoff link extractor.
 *
 * Replaces the legacy `x-slicc` response header with two custom rels carried
 * in a standard RFC 8288 `Link` header:
 *
 *   Link: <https://github.com/owner/repo>; rel="https://www.sliccy.ai/rel/upskill"
 *   Link: <>; rel="https://www.sliccy.ai/rel/handoff";
 *         title*=UTF-8''Continue%20the%20signup%20flow
 *
 * SLICC dispatches by rel — the rel IS the verb. New verbs add new rels under
 * the `https://www.sliccy.ai/rel/` namespace.
 */

import type { ParsedLink } from './link-header.js';
import {
  getLinkHeaderValuesFromCdp,
  getLinkHeaderValuesFromHeaders,
  getLinkHeaderValuesFromWebRequest,
  parseLinkHeader,
} from './link-header.js';

export const HANDOFF_REL = 'https://www.sliccy.ai/rel/handoff';
export const UPSKILL_REL = 'https://www.sliccy.ai/rel/upskill';

export type HandoffVerb = 'handoff' | 'upskill';

export interface HandoffMatch {
  verb: HandoffVerb;
  /**
   * Absolute URL when the verb's payload is a URL (e.g. upskill points at a
   * GitHub repo). For prose-only verbs (handoff), this resolves to the page
   * itself via the empty `<>` anchor convention.
   */
  target: string;
  /** Free-form prose instruction from the link's `title` parameter, if any. */
  instruction?: string;
}

/**
 * Find the first SLICC-recognised handoff link in a parsed Link header set.
 *
 * Rel comparison is case-sensitive: RFC 8288 §2.1.1 mandates URI rels, and
 * generic URI comparison is case-sensitive in path/query. Scheme and host
 * are case-insensitive, but our canonical form uses lowercase already.
 */
export function extractHandoff(links: ParsedLink[]): HandoffMatch | null {
  for (const link of links) {
    if (link.rel.includes(HANDOFF_REL)) {
      const result: HandoffMatch = { verb: 'handoff', target: link.href };
      if (link.title != null && link.title.length > 0) result.instruction = link.title;
      return result;
    }
    if (link.rel.includes(UPSKILL_REL)) {
      const result: HandoffMatch = { verb: 'upskill', target: link.href };
      if (link.title != null && link.title.length > 0) result.instruction = link.title;
      return result;
    }
  }
  return null;
}

/* ────────── header-shape adapters that go straight to a verb match ────────── */

export function extractHandoffFromCdpHeaders(
  headers: Record<string, unknown> | undefined,
  baseUrl?: string
): { match: HandoffMatch | null; links: ParsedLink[] } {
  const values = getLinkHeaderValuesFromCdp(headers);
  if (values.length === 0) return { match: null, links: [] };
  const links = parseLinkHeader(values, baseUrl);
  return { match: extractHandoff(links), links };
}

export function extractHandoffFromWebRequest(
  headers: Array<{ name: string; value?: string }> | undefined,
  baseUrl?: string
): { match: HandoffMatch | null; links: ParsedLink[] } {
  const values = getLinkHeaderValuesFromWebRequest(headers);
  if (values.length === 0) return { match: null, links: [] };
  const links = parseLinkHeader(values, baseUrl);
  return { match: extractHandoff(links), links };
}

export function extractHandoffFromFetchHeaders(
  headers: Headers | undefined,
  baseUrl?: string
): { match: HandoffMatch | null; links: ParsedLink[] } {
  const values = getLinkHeaderValuesFromHeaders(headers);
  if (values.length === 0) return { match: null, links: [] };
  const links = parseLinkHeader(values, baseUrl);
  return { match: extractHandoff(links), links };
}
