/**
 * Pure GitHub Copilot `/copilot_internal/user` client.
 *
 * Extracted from `providers/github-copilot.ts` for the same reason as
 * `adobe-usage.ts` — zero DOM dependencies, unit-testable directly
 * (`github-copilot.ts` itself cannot be imported under vitest).
 *
 * GitHub reports a rolling MONTHLY premium-interaction allowance (AI Credits)
 * in `quota_snapshots.premium_interactions`, authenticated with the same
 * GitHub OAuth access token used for the Copilot token exchange — NOT the
 * short-lived Copilot completion token. `chat` and `completions` report
 * `unlimited: true` on every plan seen so far; only the premium-model window
 * is finite, so that's the one surfaced here:
 *
 * ```json
 * { "quota_reset_date_utc": "2026-10-01T00:00:00.000Z",
 *   "quota_snapshots": { "premium_interactions": {
 *     "unlimited": false, "percent_remaining": 95.6,
 *     "overage_permitted": true } } }
 * ```
 */

import type { ProviderBudgetStatus, ProviderBudgetWindow } from './provider-budget.js';

export const COPILOT_USER_URL = 'https://api.github.com/copilot_internal/user';

/** Minimal `fetch` surface, injected so tests need no network. */
export type UsageFetch = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** A stalled call is not worth a hung poll. */
const USAGE_TIMEOUT_MS = 8_000;

interface CopilotQuotaSnapshot {
  unlimited?: boolean;
  percent_remaining?: number;
  overage_permitted?: boolean;
}

interface CopilotUserResponse {
  quota_reset_date_utc?: string;
  quota_snapshots?: {
    premium_interactions?: CopilotQuotaSnapshot;
  };
}

/**
 * Parse a `copilot_internal/user` body into the premium-interaction window,
 * or `null` when this plan has none (unlimited, or a shape we don't
 * recognize).
 *
 * "We don't know" and "0% used" must not look alike: a payload with no
 * usable `percent_remaining` yields `null`, never a zeroed reading.
 */
export function parseCopilotUsage(payload: unknown): ProviderBudgetWindow | null {
  if (!payload || typeof payload !== 'object') return null;
  const quota = (payload as CopilotUserResponse).quota_snapshots?.premium_interactions;
  if (!quota || quota.unlimited || typeof quota.percent_remaining !== 'number') return null;
  const percent = Math.max(0, 100 - quota.percent_remaining);
  const status: ProviderBudgetStatus =
    quota.percent_remaining <= 0 && quota.overage_permitted !== true ? 'rate-limited' : 'ok';
  return {
    percent,
    status,
    window: 'monthly',
    resetsAt: (payload as CopilotUserResponse).quota_reset_date_utc,
  };
}

/**
 * Fetch the account's rolling monthly premium-interaction window.
 *
 * Returns `null` for "this account has no metered window" (an unlimited
 * plan, or a 200 carrying nothing parseable). THROWS for a call that failed
 * (network error, 401, 5xx): the two get different retry clocks upstream
 * (`budget-usage-source.ts`), and an account whose token merely expired must
 * not be written off as budget-less for the next half hour.
 */
export async function fetchCopilotUsage(
  githubAccessToken: string,
  fetchImpl: UsageFetch,
  opts: { headers?: Record<string, string>; timeoutMs?: number } = {}
): Promise<ProviderBudgetWindow | null> {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), opts.timeoutMs ?? USAGE_TIMEOUT_MS)
    : null;
  try {
    const res = await fetchImpl(COPILOT_USER_URL, {
      // Caller headers first: the editor-identification headers are this
      // function's own business, so they win the collision.
      headers: { ...opts.headers, Authorization: `Bearer ${githubAccessToken}` },
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (res.status === 404 || res.status === 501) {
      // Route doesn't exist for this account/deployment (or was retired):
      // an unsupported endpoint, not a transient failure. Fall in line with
      // the other budget clients and take the 30-minute "no window" backoff
      // instead of retrying every 5 minutes forever.
      return null;
    }
    if (!res.ok) {
      throw new Error(`GitHub Copilot /copilot_internal/user returned ${res.status}`);
    }
    return parseCopilotUsage(await res.json());
  } finally {
    if (timer) clearTimeout(timer);
  }
}
