export type ProviderBudgetStatus = 'ok' | 'rate-limited';

export interface ProviderBudgetWindow {
  percent: number;
  status: ProviderBudgetStatus;

  window: string;

  resetsAt?: string;

  providerId?: string;

  at?: number;
}

const PREFERRED_WINDOW = 'weekly';

// biome-ignore lint/plugin: parsed proxy JSON — window names are the provider's, narrowed structurally by readWindow().
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readWindow(name: string, raw: unknown): ProviderBudgetWindow | null {
  if (!isRecord(raw)) return null;
  const percent = raw.percent;

  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null;
  const status: ProviderBudgetStatus = raw.status === 'rate-limited' ? 'rate-limited' : 'ok';
  const resetsAt = typeof raw.resetsAt === 'string' && raw.resetsAt ? raw.resetsAt : undefined;
  return { percent, status, window: name, resetsAt };
}

export function parseProviderUsage(payload: unknown): ProviderBudgetWindow | null {
  if (!isRecord(payload)) return null;
  const usage = isRecord(payload.usage) ? payload.usage : payload;
  const preferred = readWindow(PREFERRED_WINDOW, usage[PREFERRED_WINDOW]);
  if (preferred) return preferred;
  for (const [name, raw] of Object.entries(usage)) {
    const parsed = readWindow(name, raw);
    if (parsed) return parsed;
  }
  return null;
}

export type BudgetLevel = 'ok' | 'warn' | 'critical';

export const BUDGET_WARN_PERCENT = 80;

export const BUDGET_CRITICAL_PERCENT = 95;

export function budgetLevel(window: {
  percent: number;
  status?: ProviderBudgetStatus;
}): BudgetLevel {
  if (window.status === 'rate-limited') return 'critical';
  if (window.percent >= BUDGET_CRITICAL_PERCENT) return 'critical';
  if (window.percent >= BUDGET_WARN_PERCENT) return 'warn';
  return 'ok';
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function formatBudgetResets(
  resetsAt: string | undefined,
  now: number = Date.now()
): string | undefined {
  if (!resetsAt) return undefined;
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return undefined;
  const delta = at - now;

  if (delta <= 0) return 'resetting now';
  if (delta < HOUR_MS) return `resets in ${Math.max(1, Math.round(delta / MINUTE_MS))}m`;
  if (delta < DAY_MS) return `resets in ${Math.round(delta / HOUR_MS)}h`;
  return `resets in ${Math.round(delta / DAY_MS)}d`;
}

export function formatBudgetPercent(percent: number): string {
  if (!Number.isFinite(percent)) return '0';
  const value = Math.max(0, percent);
  return value < 10 ? String(Number(value.toFixed(1))) : String(Math.round(value));
}

export function describeBudgetWindow(
  window: ProviderBudgetWindow,
  now: number = Date.now()
): string {
  const parts = [`${formatBudgetPercent(window.percent)}% of ${window.window} budget used`];
  if (window.status === 'rate-limited') parts.push('rate-limited');
  const resets = formatBudgetResets(window.resetsAt, now);
  if (resets) parts.push(resets);
  return parts.join(' · ');
}
