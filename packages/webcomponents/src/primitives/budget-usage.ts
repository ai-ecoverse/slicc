export type BudgetStatus = 'ok' | 'rate-limited';

export type BudgetLevel = 'ok' | 'warn' | 'critical';

export interface BudgetUsage {
  percent: number;

  status?: BudgetStatus;

  window?: string;

  resets?: string;
}

export const BUDGET_WARN_PERCENT = 80;

export const BUDGET_CRITICAL_PERCENT = 95;

const DEFAULT_WINDOW = 'weekly';

export function budgetLevel(usage: BudgetUsage): BudgetLevel {
  if (usage.status === 'rate-limited') return 'critical';
  if (usage.percent >= BUDGET_CRITICAL_PERCENT) return 'critical';
  if (usage.percent >= BUDGET_WARN_PERCENT) return 'warn';
  return 'ok';
}

export function budgetRatio(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(1, percent / 100));
}

export function formatBudgetPercent(percent: number): string {
  if (!Number.isFinite(percent)) return '0';
  const value = Math.max(0, percent);
  return value < 10 ? String(Number(value.toFixed(1))) : String(Math.round(value));
}

export function formatBudgetFigure(percent: number): string {
  return `${formatBudgetPercent(percent)}%`;
}

export function budgetWindowLabel(usage: BudgetUsage): string {
  return `${usage.window ?? DEFAULT_WINDOW} budget`;
}

export function budgetTipFragments(usage: BudgetUsage): string[] {
  const parts = [`${formatBudgetFigure(usage.percent)} of ${budgetWindowLabel(usage)} used`];
  if (usage.status === 'rate-limited') parts.push('rate-limited');
  if (usage.resets) parts.push(usage.resets);
  return parts;
}

export function budgetHue(level: BudgetLevel): string {
  if (level === 'critical') return 'var(--rose)';
  if (level === 'warn') return 'var(--waffle)';
  return 'var(--green)';
}
