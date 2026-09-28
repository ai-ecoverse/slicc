import type { SecureFetch } from 'just-bash';

export const LIVE_REGISTRY = process.env.IPK_LIVE_REGISTRY === '1';

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
