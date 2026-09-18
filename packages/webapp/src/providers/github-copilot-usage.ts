import type { ProviderBudgetStatus, ProviderBudgetWindow } from './provider-budget.js';

export const COPILOT_USER_URL = 'https://api.github.com/copilot_internal/user';

export type UsageFetch = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

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
      headers: { ...opts.headers, Authorization: `Bearer ${githubAccessToken}` },
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (res.status === 404 || res.status === 501) {
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
