import { SLICC_HOSTED_ORIGIN } from './bridge-protocol.js';
import type { ParsedLink } from './link-header.js';
import {
  getLinkHeaderValuesFromCdp,
  getLinkHeaderValuesFromHeaders,
  getLinkHeaderValuesFromWebRequest,
  parseLinkHeader,
} from './link-header.js';

export const HANDOFF_REL = `${SLICC_HOSTED_ORIGIN}/rel/handoff`;
export const UPSKILL_REL = `${SLICC_HOSTED_ORIGIN}/rel/upskill`;

// biome-ignore lint/plugin: opaque CDP Network.Response.headers envelope — genuine protocol boundary; narrowed in getLinkHeaderValuesFromCdp.
export type CdpHeaderBag = Record<string, unknown>;

export type HandoffVerb = 'handoff' | 'upskill';

export interface HandoffMatch {
  verb: HandoffVerb;

  target: string;

  instruction?: string;

  branch?: string;

  path?: string;
}

function canonicaliseUpskillPath(raw: string): string {
  const trimmed = raw.replace(/\/+$/, '');
  const lower = trimmed.toLowerCase();
  if (lower.endsWith('/skill.md')) return trimmed.slice(0, -'/skill.md'.length);
  if (lower === 'skill.md') return '';
  return trimmed;
}

const SAFE_BRANCH_RE = /^[A-Za-z0-9._/-]+$/;
const SAFE_PATH_RE = /^[A-Za-z0-9._/-]+$/;
const MAX_BRANCH_LEN = 250;
const MAX_PATH_LEN = 1024;

export function isSafeUpskillBranch(value: string): boolean {
  if (value.length === 0 || value.length > MAX_BRANCH_LEN) return false;
  if (!SAFE_BRANCH_RE.test(value)) return false;
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/')) return false;
  if (value.includes('..')) return false;
  if (value.endsWith('.lock')) return false;
  return true;
}

export function isSafeUpskillPath(value: string): boolean {
  if (value.length === 0 || value.length > MAX_PATH_LEN) return false;
  if (!SAFE_PATH_RE.test(value)) return false;
  if (value.startsWith('-') || value.startsWith('/')) return false;
  if (value.includes('..')) return false;
  return true;
}

function applyUpskillParams(result: HandoffMatch, params: Record<string, string>): void {
  const branch = params.branch;
  if (typeof branch === 'string' && isSafeUpskillBranch(branch)) result.branch = branch;
  const pathParam = params.path;
  if (typeof pathParam === 'string' && pathParam.length > 0) {
    const canon = canonicaliseUpskillPath(pathParam);
    if (canon.length > 0 && isSafeUpskillPath(canon)) result.path = canon;
  }
}

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
      applyUpskillParams(result, link.params);
      return result;
    }
  }
  return null;
}

export function handoffFingerprint(input: {
  verb: string;
  target: string;
  branch?: string;
  path?: string;
  instruction?: string;
}): string {
  return [
    input.verb,
    input.target,
    input.branch ?? '',
    input.path ?? '',
    input.instruction ?? '',
  ].join('\u0000');
}

export function extractHandoffFromCdpHeaders(
  headers: CdpHeaderBag | undefined,
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
