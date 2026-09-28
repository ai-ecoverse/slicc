import type { SecureFetch } from 'just-bash';

/**
 * Opt-in switch for the tests that talk to the real npm registry. They never
 * run in CI; run them with `IPK_LIVE_REGISTRY=1 npx vitest run --project webapp
 * packages/webapp/tests/shell/ipk/ipk-live-registry.test.ts`.
 */
export const LIVE_REGISTRY = process.env.IPK_LIVE_REGISTRY === '1';

/** A `SecureFetch` over Node's global `fetch`, for the live-registry tests. */
export const nodeFetch = (async (
  url: string,
  opts?: { method?: string; headers?: Record<string, string> }
) => {
  const res = await fetch(url, { method: opts?.method ?? 'GET', headers: opts?.headers });
  return {
    status: res.status,
    statusText: res.statusText,
    headers: Object.fromEntries(res.headers.entries()),
    body: new Uint8Array(await res.arrayBuffer()),
    url,
  };
}) as unknown as SecureFetch;
