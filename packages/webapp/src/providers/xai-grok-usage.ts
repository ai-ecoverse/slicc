import type { ProviderBudgetWindow } from './provider-budget.js';

export type XaiUsageFetch = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export const XAI_USAGE_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';

const USAGE_TIMEOUT_MS = 8_000;

const MAX_BODY_BYTES = 64 * 1024;

const MAX_PERCENT = 1_000;

// biome-ignore lint/plugin: parsed third-party JSON — the proxy owns these field names, narrowed structurally below.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseXaiUsage(payload: unknown): ProviderBudgetWindow | null {
  if (!isRecord(payload)) return null;

  const config = isRecord(payload.config) ? payload.config : payload;
  const raw = config.creditUsagePercent;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const percent = Math.min(MAX_PERCENT, Math.max(0, raw));

  const period = isRecord(config.currentPeriod) ? config.currentPeriod : {};

  const type = period.type;
  const named =
    typeof type === 'string' ? type.replace('USAGE_PERIOD_TYPE_', '').toLowerCase() : '';

  const end = period.end ?? config.billingPeriodEnd;
  const resetsAt = typeof end === 'string' && Number.isFinite(Date.parse(end)) ? end : undefined;
  return {
    percent,

    status: 'ok',
    window: named && named !== 'unspecified' ? named : 'billing',
    ...(resetsAt ? { resetsAt } : {}),
  };
}

export async function fetchXaiGrokUsage(
  accessToken: string,
  fetchImpl: XaiUsageFetch,
  opts: { timeoutMs?: number } = {}
): Promise<ProviderBudgetWindow | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? USAGE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(XAI_USAGE_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
    const { status } = res;

    if (status === 404 || status === 501) return null;
    if (!res.ok) {
      const why = status === 401 || status === 403 ? 're-login required' : 'failed';
      throw new Error(`xAI Grok usage: ${why} (${status})`);
    }
    const body = await res.text();

    if (body.length > MAX_BODY_BYTES) return null;
    try {
      return parseXaiUsage(JSON.parse(body));
    } catch {
      return null;
    }
  } finally {
    clearTimeout(timer);
  }
}
