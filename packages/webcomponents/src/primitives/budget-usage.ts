/**
 * Budget-mode cost vocabulary, shared by `<slicc-floatbar>` and
 * `<slicc-cost-overlay>`.
 *
 * Some providers do not bill per token at all: they hand out a rolling
 * allowance — Adobe's LLM proxy reports one 7-day window — and the only
 * number that means anything is how much of it is gone. Session dollars are
 * still true there, but they are a footnote: a family-priced model can report
 * $0.00 while the shared window burns down, so a `$` headline says nothing
 * about whether work will stop this afternoon.
 *
 * The convention, matching OpenCode Go's `/v1/usage` shape: **percent USED,
 * never percent remaining**. One direction across every surface — a rising
 * number is a worsening one — because a panel that headlines "9.5%" and a
 * pill that headlines "90.5%" for the same instant is a bug report waiting to
 * be filed.
 *
 * No clock lives here. `resets` is copy the HOST already formatted, like
 * {@link MonitorAlert.age} — a component that computes "in 6d" from a
 * timestamp renders differently every hour and cannot be screenshotted.
 */

/** Provider-reported health of the window. Mirrors `/v1/usage`. */
export type BudgetStatus = 'ok' | 'rate-limited';

/** How the usage reads: fine, worth noticing, or about to stop the session. */
export type BudgetLevel = 'ok' | 'warn' | 'critical';

/**
 * One rolling budget window as the cost surfaces render it.
 *
 * `percent` is not clamped on the way in: a provider that reports 104% has
 * told us something true, and rounding it to 100 hides it. Bars clamp; copy
 * does not.
 */
export interface BudgetUsage {
  /** Percent of the window's allowance CONSUMED. `9.5` renders as `9.5%`. */
  percent: number;
  /** Provider status. Absent is treated as `ok`. */
  status?: BudgetStatus;
  /** Window name used in copy — `weekly` by default (Adobe's only window). */
  window?: string;
  /** Reset copy, ALREADY FORMATTED by the host (`resets Sun 14 Sep`). */
  resets?: string;
}

/** At or above this, the surface tints amber. */
export const BUDGET_WARN_PERCENT = 80;
/** At or above this — or whenever the provider says `rate-limited` — rose. */
export const BUDGET_CRITICAL_PERCENT = 95;

/** Default window name when the host names none. */
const DEFAULT_WINDOW = 'weekly';

/**
 * Where the usage sits on the ok / warn / critical ladder.
 *
 * `rate-limited` is critical whatever the percent says: a provider that has
 * started refusing calls is the fact the surface exists to report, and its
 * percent can lag behind the refusal.
 */
export function budgetLevel(usage: BudgetUsage): BudgetLevel {
  if (usage.status === 'rate-limited') return 'critical';
  if (usage.percent >= BUDGET_CRITICAL_PERCENT) return 'critical';
  if (usage.percent >= BUDGET_WARN_PERCENT) return 'warn';
  return 'ok';
}

/** 0..1 fill for a meter track. Clamped — a bar cannot draw 104%. */
export function budgetRatio(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(1, percent / 100));
}

/**
 * The figure, without its `%`.
 *
 * A decimal below 10 and a whole number above it: `9.5` is the difference
 * between "nothing has happened yet" and "the morning cost a tenth of the
 * week", while `63.2` vs `63` is noise on a number that moves in whole units.
 */
export function formatBudgetPercent(percent: number): string {
  if (!Number.isFinite(percent)) return '0';
  const value = Math.max(0, percent);
  return value < 10 ? String(Number(value.toFixed(1))) : String(Math.round(value));
}

/** The figure with its unit — `9.5%`. */
export function formatBudgetFigure(percent: number): string {
  return `${formatBudgetPercent(percent)}%`;
}

/** `weekly budget` — the window name as it appears mid-sentence. */
export function budgetWindowLabel(usage: BudgetUsage): string {
  return `${usage.window ?? DEFAULT_WINDOW} budget`;
}

/**
 * The sentence fragments a tip or a card puts under the figure, in order:
 * what the number means, then the provider's refusal (only when it is
 * refusing), then when the window turns over.
 */
export function budgetTipFragments(usage: BudgetUsage): string[] {
  const parts = [`${formatBudgetFigure(usage.percent)} of ${budgetWindowLabel(usage)} used`];
  if (usage.status === 'rate-limited') parts.push('rate-limited');
  if (usage.resets) parts.push(usage.resets);
  return parts;
}

/** The token a surface tints with at each level. */
export function budgetHue(level: BudgetLevel): string {
  if (level === 'critical') return 'var(--rose)';
  if (level === 'warn') return 'var(--waffle)';
  return 'var(--green)';
}
