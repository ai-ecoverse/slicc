import { type ProviderBudgetWindow, parseProviderUsage } from './provider-budget.js';

export type UsageFetch = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const USAGE_TIMEOUT_MS = 8_000;

export async function fetchAdobeUsage(
  proxyEndpoint: string,
  accessToken: string,
  fetchImpl: UsageFetch,
  opts: { headers?: Record<string, string>; timeoutMs?: number } = {}
): Promise<ProviderBudgetWindow | null> {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), opts.timeoutMs ?? USAGE_TIMEOUT_MS)
    : null;
  try {
    const res = await fetchImpl(`${proxyEndpoint.replace(/\/$/, '')}/v1/usage`, {
      headers: { ...opts.headers, Authorization: `Bearer ${accessToken}` },
      ...(controller ? { signal: controller.signal } : {}),
    });

    if (res.status === 404 || res.status === 501) return null;
    if (!res.ok) throw new Error(`Adobe /v1/usage returned ${res.status}`);
    return parseProviderUsage(await res.json());
  } finally {
    if (timer) clearTimeout(timer);
  }
}
