/**
 * Well-known probe for Agentic Resource Discovery (ARD) artifacts.
 *
 * When a response carries no `ai-catalog` `Link` header (see
 * `discovery-link.ts`), an origin can still publish discovery artifacts at
 * their standardized well-known locations:
 *
 *   - `/.well-known/ai-catalog.json` — the ARD capability manifest
 *   - `/llms.txt`                    — the llmstxt.org digest for LLMs
 *
 * `probeWellKnown` issues a bounded GET to each location and returns the ones
 * that answer `200` with a plausible content-type. It is pure core: the fetch
 * implementation is injected and every network failure / timeout is caught and
 * treated as "no match" (never thrown). No float wiring lives here.
 *
 * Content-type is lenient by design — a missing header is accepted (some static
 * hosts omit it), but an HTML response is always rejected: a manifest / digest
 * served as HTML is a misconfiguration, not the artifact.
 */

import type { DiscoveryKind } from '@slicc/shared-ts';

/** Structural subset of a `fetch` Response the probe needs (no DOM lib dep). */
export interface ProbeResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
}

/** Injected fetch. Compatible with the global `fetch`. */
export type ProbeFetch = (
  url: string,
  init?: { method?: string; signal?: AbortSignal; redirect?: string }
) => Promise<ProbeResponse>;

export interface DiscoveryProbeMatch {
  kind: DiscoveryKind;
  /** Absolute URL of the artifact that answered. */
  url: string;
}

export interface ProbeOptions {
  /** Per-request timeout in milliseconds. Defaults to 3000. */
  timeoutMs?: number;
}

interface ProbeTarget {
  kind: DiscoveryKind;
  path: string;
}

const TARGETS: readonly ProbeTarget[] = [
  { kind: 'ai-catalog', path: '/.well-known/ai-catalog.json' },
  { kind: 'llms-txt', path: '/llms.txt' },
];

const DEFAULT_TIMEOUT_MS = 3000;

/**
 * Probe an origin's well-known discovery locations. Returns one match per
 * artifact that answered `200` with a plausible content-type. Both probes run
 * concurrently; a failure of one never affects the other.
 */
export async function probeWellKnown(
  origin: string,
  fetchImpl: ProbeFetch,
  options: ProbeOptions = {}
): Promise<DiscoveryProbeMatch[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let base: string;
  try {
    base = new URL(origin).origin;
  } catch {
    return [];
  }

  const settled = await Promise.all(
    TARGETS.map((target) => probeOne(base, target, fetchImpl, timeoutMs))
  );
  return settled.filter((m): m is DiscoveryProbeMatch => m !== null);
}

async function probeOne(
  base: string,
  target: ProbeTarget,
  fetchImpl: ProbeFetch,
  timeoutMs: number
): Promise<DiscoveryProbeMatch | null> {
  const url = base + target.path;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'GET', signal: ctrl.signal });
    // Require an exact 200. `res.ok` also accepts 204 No Content / 206 Partial
    // Content, which would surface a discovery lick for an empty / no-body
    // artifact (especially when the server omits a content-type).
    if (res.status !== 200) return null;
    if (!contentTypeOk(res.headers.get('content-type'), target.kind)) return null;
    return { kind: target.kind, url };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decide whether a response content-type is plausible for the given artifact.
 * HTML is always rejected; a missing/empty header is accepted (lenient).
 */
export function contentTypeOk(raw: string | null, kind: DiscoveryKind): boolean {
  if (raw == null) return true;
  const ct = raw.toLowerCase();
  if (ct.length === 0) return true;
  if (ct.includes('text/html') || ct.includes('application/xhtml')) return false;
  if (kind === 'ai-catalog') {
    return ct.includes('json') || ct.includes('text/plain') || ct.includes('octet-stream');
  }
  // llms-txt
  return ct.includes('text/plain') || ct.includes('markdown') || ct.includes('octet-stream');
}
