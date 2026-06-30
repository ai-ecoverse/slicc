/**
 * Standalone float fingerprinting for the floatbar label: "standalone" hides
 * which runtime actually serves the page, so ask the server. Both local
 * servers expose `/api/status` whose `service` field names them —
 * `slicc-server` is the native Hummingbird server Sliccstart (mac) launches,
 * `slicc-node-server` is the Node CLI (`npx slicc` / `npm run dev`).
 * Unknown/unreachable keeps the generic label (cherry iframes, old servers).
 */

import { apiHeaders, resolveApiUrl } from '../../shell/proxied-fetch.js';

const FLOAT_BY_SERVICE: Record<string, string> = {
  'slicc-server': 'sliccstart',
  'slicc-node-server': 'npx',
};

export const DEFAULT_STANDALONE_LABEL = 'standalone · live';

export async function resolveStandaloneFloatLabel(opts?: {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): Promise<string> {
  const fetchFn = opts?.fetchFn ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 1500;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetchFn(resolveApiUrl('/api/status'), {
      cache: 'no-store',
      signal: ctrl.signal,
      headers: apiHeaders(),
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return DEFAULT_STANDALONE_LABEL;
    const body = (await res.json()) as { service?: string };
    const float = body.service ? FLOAT_BY_SERVICE[body.service] : undefined;
    return float ? `${float} · live` : DEFAULT_STANDALONE_LABEL;
  } catch {
    return DEFAULT_STANDALONE_LABEL;
  }
}
