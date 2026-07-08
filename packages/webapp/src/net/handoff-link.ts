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

import { SLICC_HOSTED_ORIGIN } from '@slicc/shared-ts';
import type { ParsedLink } from './link-header.js';
import {
  getLinkHeaderValuesFromCdp,
  getLinkHeaderValuesFromHeaders,
  getLinkHeaderValuesFromWebRequest,
  parseLinkHeader,
} from './link-header.js';

export const HANDOFF_REL = `${SLICC_HOSTED_ORIGIN}/rel/handoff`;
export const UPSKILL_REL = `${SLICC_HOSTED_ORIGIN}/rel/upskill`;

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
  /**
   * Optional branch name carried by the upskill rel's `branch` Link param.
   * Only populated for the upskill verb; the handoff verb ignores both
   * `branch` and `path` because its target is the page itself, not a repo.
   */
  branch?: string;
  /**
   * Optional sub-path under the upskill rel's repo carried by the `path`
   * Link param. Canonical directory form: a trailing `/SKILL.md` (which
   * some emitters include to point at the manifest itself) is stripped so
   * downstream consumers always see the skill's containing directory.
   * Only populated for the upskill verb.
   */
  path?: string;
}

/** Strip a trailing `/SKILL.md` (case-insensitive) so callers see a directory. */
function canonicaliseUpskillPath(raw: string): string {
  const trimmed = raw.replace(/\/+$/, '');
  const lower = trimmed.toLowerCase();
  if (lower.endsWith('/skill.md')) return trimmed.slice(0, -'/skill.md'.length);
  if (lower === 'skill.md') return '';
  return trimmed;
}

/**
 * Shell-metacharacter allowlists for `branch` and `path` Link params.
 *
 * The `Link` header is attacker-controlled (any page the user opens can
 * emit one). The cone consumes the navigate-lick body verbatim and
 * follows the `handoff` SKILL instruction to render `upskill --branch
 * <b> --path <p> <target>` as a `bash` tool call — a string the WASM
 * shell tokenizes. If `b` or `p` carry `;`, backticks, dollar-paren,
 * or a trailing newline, an unquoted/mis-quoted splice could smuggle
 * a second command past the approval card's visible code rows.
 *
 * Defense-in-depth: drop unsafe values here so they never enter the
 * lick body the cone reads. The `upskill` command also re-validates
 * (`upskill-command.ts` imports `isSafeUpskillBranch` /
 * `isSafeUpskillPath`) as a second gate in case a future dispatch
 * path bypasses this extractor.
 *
 * The allowlists are intentionally narrow:
 *
 * - Branch: `git check-ref-format` characters (alphanumerics, `.`,
 *   `_`, `/`, `-`). `..` segments, a leading `-`/`/`, a trailing `/`,
 *   and a `.lock` suffix are rejected to match git's own rules. Max
 *   length 250 (git's `MAX_REF_NAMELEN`).
 * - Path: same character set as branches; no `..` traversal, no
 *   leading `-` (avoids being parsed as a flag) or leading `/` (the
 *   wire format is repo-relative). Max length 1024.
 *
 * Anything beyond ASCII is rejected on purpose: a homoglyph branch
 * name would render identical to a real one in the approval card but
 * resolve to a different ref. Real git branches in the wild are
 * ASCII; the cost of rejecting unicode here is low and the
 * homoglyph-spoofing surface this closes is meaningful.
 */
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

/**
 * Find the first SLICC-recognised handoff link in a parsed Link header set.
 *
 * Rel comparison is case-sensitive: RFC 8288 §2.1.1 mandates URI rels, and
 * generic URI comparison is case-sensitive in path/query. Scheme and host
 * are case-insensitive, but our canonical form uses lowercase already.
 *
 * For the upskill verb, optional `branch` and `path` Link params are
 * surfaced on the match so the dispatch path can pass them through to the
 * `upskill` command's `--branch` / `--path` flags. These params are
 * upskill-only — they are ignored on the handoff verb (whose target is the
 * page itself, not a git tree).
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
      // `parseLinkHeader` lowercases param names and applies RFC 8187
      // ext-value decoding, so `branch`, `branch*=UTF-8''…`, `BRANCH=…`
      // all land here under the same `branch` key.
      //
      // Shell-injection defense: drop branch/path values that contain
      // anything outside the allowlist (see `isSafeUpskillBranch` /
      // `isSafeUpskillPath`). The values are about to ride to the cone
      // inside a navigate-lick body, then back out as flag arguments to
      // the `upskill` bash command — every character has to be safe
      // both as JSON content and as an argv token. Silent drop matches
      // the existing "empty value -> field omitted" contract.
      const branch = link.params.branch;
      if (typeof branch === 'string' && isSafeUpskillBranch(branch)) result.branch = branch;
      const pathParam = link.params.path;
      if (typeof pathParam === 'string' && pathParam.length > 0) {
        const canon = canonicaliseUpskillPath(pathParam);
        if (canon.length > 0 && isSafeUpskillPath(canon)) result.path = canon;
      }
      return result;
    }
  }
  return null;
}

/**
 * Stable identity for a handoff/upskill payload, independent of the page URL
 * that advertised it.
 *
 * A site can emit the same SLICC `Link` rel on every page response (e.g. a
 * site-wide upskill pointing at one repo). Keying dedup on the page URL would
 * never collapse those because the path changes on every navigation, while the
 * payload (`verb` + `target` repo + `branch` + `path`, or for the prose
 * `handoff` verb the page `target` + `instruction`) stays constant. Keying on
 * this fingerprint lets callers process a given handoff once and silently drop
 * repeat sightings of the same payload within a session.
 *
 * The NUL separator can't appear in any of the parts (URLs, git refs, paths,
 * and the RFC 8187-decoded title are all NUL-free), so concatenation is
 * collision-free without hashing.
 */
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
