/**
 * Pure Adobe `/v1/usage` client.
 *
 * Extracted from `providers/adobe.ts` so it has zero DOM / `chrome` /
 * `import.meta.glob` dependencies and can be unit-tested directly (adobe.ts
 * itself cannot be imported under vitest) — the same extraction pattern as
 * `adobe-model-metadata.ts` and `family-cost.ts`.
 *
 * The proxy reports one rolling 7-day window in OpenCode Go's public shape,
 * authenticated with the same IMS token as `/v1/messages`:
 *
 * ```json
 * { "usage": { "weekly": { "status": "ok", "percent": 9.5,
 *                          "resetsAt": "2026-09-14T00:00:00.000Z" } } }
 * ```
 */

import { type ProviderBudgetWindow, parseProviderUsage } from './provider-budget.js';

/** Minimal `fetch` surface, injected so tests need no network. */
export type UsageFetch = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** A proxy this slow is not answering; the reading is not worth a stalled poll. */
const USAGE_TIMEOUT_MS = 8_000;

/**
 * Fetch the proxy's budget window.
 *
 * `opts.headers` carries the call site's `X-Session-Id` (a webapp-wide Adobe
 * invariant), so the probe is attributable rather than hashed into an opaque
 * id by the proxy.
 *
 * Returns `null` for "this proxy has no such window" — a 404/501 from a
 * deployment that predates the endpoint, or a 200 carrying nothing parseable.
 * THROWS for a call that failed (network error, 401, 5xx): the two get
 * different retry clocks upstream, and a proxy that is merely down must not be
 * written off as budget-less for the next half hour.
 */
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
      // Caller headers first: the call site owns `X-Session-Id`, and the
      // credential is this function's own business, so it wins the collision.
      headers: { ...opts.headers, Authorization: `Bearer ${accessToken}` },
      ...(controller ? { signal: controller.signal } : {}),
    });
    // 404/501 is the endpoint saying it does not exist — an answer, not a
    // failure. Every other non-OK status is a failure worth retrying sooner.
    if (res.status === 404 || res.status === 501) return null;
    if (!res.ok) throw new Error(`Adobe /v1/usage returned ${res.status}`);
    return parseProviderUsage(await res.json());
  } finally {
    if (timer) clearTimeout(timer);
  }
}
