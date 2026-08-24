/**
 * Float fingerprinting for the floatbar: which runtime serves this page.
 * Standalone hides the answer behind `/api/status` (`slicc-server` →
 * sliccstart, `slicc-node-server` → npx). Unknown/unreachable → standalone.
 */

import type { FloatbarFloatKind } from '@slicc/webcomponents';
import { floatKindLabel } from '@slicc/webcomponents';
import { apiHeaders, resolveApiUrl } from '../../shell/proxied-fetch.js';
import type { UiRuntimeMode } from '../runtime-mode.js';

const FLOAT_KIND_BY_SERVICE: Record<string, FloatbarFloatKind> = {
  'slicc-server': 'sliccstart',
  'slicc-node-server': 'npx',
};

export function floatLabelForKind(kind: FloatbarFloatKind): string {
  return floatKindLabel(kind);
}

export function floatKindForRuntimeMode(mode: UiRuntimeMode): FloatbarFloatKind {
  switch (mode) {
    case 'extension':
    case 'extension-detached':
      return 'extension';
    case 'cherry':
      return 'cherry';
    case 'hosted-leader':
      return 'hosted';
    case 'electron-overlay':
      return 'electron';
    case 'follower':
      return 'standalone';
    default:
      return 'standalone';
  }
}

export async function resolveStandaloneFloatKind(opts?: {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): Promise<FloatbarFloatKind> {
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
    if (!res.ok) return 'standalone';
    const body = (await res.json()) as { service?: string };
    const kind = body.service ? FLOAT_KIND_BY_SERVICE[body.service] : undefined;
    return kind ?? 'standalone';
  } catch {
    return 'standalone';
  }
}
