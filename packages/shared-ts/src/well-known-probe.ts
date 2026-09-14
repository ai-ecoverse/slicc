import type { DiscoveryKind } from './agent-wire-types.js';

export interface ProbeResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
}

export type ProbeFetch = (
  url: string,
  init?: { method?: string; signal?: AbortSignal; redirect?: string; credentials?: string }
) => Promise<ProbeResponse>;

export interface DiscoveryProbeMatch {
  kind: DiscoveryKind;

  url: string;
}

export interface ProbeOptions {
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
    const res = await fetchImpl(url, {
      method: 'GET',
      signal: ctrl.signal,
      redirect: 'manual',
      credentials: 'omit',
    });

    if (res.status !== 200) return null;
    if (!contentTypeOk(res.headers.get('content-type'), target.kind)) return null;
    return { kind: target.kind, url };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function contentTypeOk(raw: string | null, kind: DiscoveryKind): boolean {
  if (raw == null) return true;
  const ct = raw.toLowerCase();
  if (ct.length === 0) return true;
  if (ct.includes('text/html') || ct.includes('application/xhtml')) return false;
  if (kind === 'ai-catalog') {
    return ct.includes('json') || ct.includes('text/plain') || ct.includes('octet-stream');
  }

  return ct.includes('text/plain') || ct.includes('markdown') || ct.includes('octet-stream');
}
