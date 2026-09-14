import type { ParsedLink } from './link-header.js';

export const P0_RELS = [
  'api-catalog',
  'service-desc',
  'service-meta',
  'status',
  'https://llmstxt.org/rel/llms-txt',
] as const;

export type P0Rel = (typeof P0_RELS)[number];

export interface DiscoveryResult {
  links: ParsedLink[];
  catalog?: unknown;
  serviceDesc?: unknown;
  serviceMeta?: unknown;
  status?: unknown;
  llmsTxt?: string;
  failures: Array<{ rel: string; href: string; error: string }>;
}

export interface DiscoverOptions {
  fetchImpl?: typeof fetch;

  timeoutMs?: number;

  signal?: AbortSignal;
}

export async function discoverLinks(
  links: ParsedLink[],
  options: DiscoverOptions = {}
): Promise<DiscoveryResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 3000;
  const result: DiscoveryResult = { links, failures: [] };

  const tasks: Array<Promise<void>> = [];
  const seen = new Set<P0Rel>();
  for (const link of links) {
    for (const rel of link.rel) {
      if (!P0_RELS.includes(rel as P0Rel)) continue;
      if (seen.has(rel as P0Rel)) continue;
      seen.add(rel as P0Rel);
      tasks.push(
        fetchOne(fetchImpl, link.href, timeoutMs, options.signal)
          .then((data) => assignToResult(result, rel as P0Rel, data))
          .catch((err) => {
            result.failures.push({
              rel,
              href: link.href,
              error: err instanceof Error ? err.message : String(err),
            });
          })
      );
    }
  }
  await Promise.all(tasks);
  return result;
}

async function fetchOne(
  fetchImpl: typeof fetch,
  href: string,
  timeoutMs: number,
  outerSignal?: AbortSignal
): Promise<{ contentType: string; body: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => ctrl.abort(new Error('aborted'));
  if (outerSignal) outerSignal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetchImpl(href, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType = res.headers.get('content-type') ?? '';
    const body = await res.text();
    return { contentType, body };
  } finally {
    clearTimeout(timer);
    if (outerSignal) outerSignal.removeEventListener('abort', onAbort);
  }
}

function assignToResult(
  result: DiscoveryResult,
  rel: P0Rel,
  data: { contentType: string; body: string }
): void {
  if (rel === 'https://llmstxt.org/rel/llms-txt') {
    result.llmsTxt = data.body;
    return;
  }

  const looksJson = data.contentType.includes('json') || data.contentType.includes('linkset');
  let parsed: unknown = data.body;
  if (looksJson) {
    try {
      parsed = JSON.parse(data.body);
    } catch {
      parsed = data.body;
    }
  }

  switch (rel) {
    case 'api-catalog':
      result.catalog = parsed;
      break;
    case 'service-desc':
      result.serviceDesc = parsed;
      break;
    case 'service-meta':
      result.serviceMeta = parsed;
      break;
    case 'status':
      result.status = parsed;
      break;
  }
}
