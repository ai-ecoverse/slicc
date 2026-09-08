/**
 * Provider budget windows — the wire shape, its parser, and its copy.
 *
 * Some providers do not meter per token: they hand out a rolling allowance.
 * Adobe's LLM proxy reports one 7-day window over `GET /v1/usage`, matching
 * OpenCode Go's public shape:
 *
 * ```json
 * { "usage": { "weekly": { "status": "ok", "percent": 9.5,
 *                          "resetsAt": "2026-09-14T00:00:00.000Z" } } }
 * ```
 *
 * On such a provider the session's dollars are a footnote — a family-priced
 * model can bill $0.00 while the shared window burns down — so the surfaces
 * headline the window instead. Percent USED, never remaining, matching the
 * payload (see `@slicc/webcomponents` `budget-usage.ts`, which owns the
 * presentational half of the same convention).
 *
 * Everything here is pure and realm-free: the shell (`cost`), the kernel
 * facade, and the UI all format the same reading through this one module, so
 * a pill, a panel and a terminal can never disagree about what `9.5%` means.
 */

/** Provider-reported health of a window. */
export type ProviderBudgetStatus = 'ok' | 'rate-limited';

/** One rolling budget window as a provider reports it. */
export interface ProviderBudgetWindow {
  /** Percent of the window's allowance CONSUMED. Not clamped — 104% is a fact. */
  percent: number;
  status: ProviderBudgetStatus;
  /** Window name (`weekly`). Adobe enforces exactly one rolling 7-day window. */
  window: string;
  /** ISO-8601 instant the window turns over, when the provider names one. */
  resetsAt?: string;
  /** Provider the reading came from, so a surface can name it. */
  providerId?: string;
  /** `Date.now()` when the reading was taken — how a consumer ages it. */
  at?: number;
}

/** The window name preferred when a payload reports several. */
const PREFERRED_WINDOW = 'weekly';

/**
 * The `/v1/usage` body is a third-party JSON payload whose windows are named
 * by the proxy, not by us — there is no shape to name until a window has been
 * read out of it, which is what {@link readWindow} does.
 */
// biome-ignore lint/plugin: parsed proxy JSON — window names are the provider's, narrowed structurally by readWindow().
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readWindow(name: string, raw: unknown): ProviderBudgetWindow | null {
  if (!isRecord(raw)) return null;
  const percent = raw.percent;
  // A window without a usable percent is not a window: reporting it as 0%
  // would say "nothing used" about a provider that said nothing at all.
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null;
  const status: ProviderBudgetStatus = raw.status === 'rate-limited' ? 'rate-limited' : 'ok';
  const resetsAt = typeof raw.resetsAt === 'string' && raw.resetsAt ? raw.resetsAt : undefined;
  return { percent, status, window: name, resetsAt };
}

/**
 * Parse a `/v1/usage` body into a window, or `null` when it carries none.
 *
 * `weekly` wins when present; otherwise the first window with a usable
 * percent is taken, so a proxy that later adds `monthly` is readable without
 * a code change. Anything unparseable yields `null` rather than a zeroed
 * reading — "we don't know" and "0% used" must not look alike.
 */
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

/** How the usage reads: fine, worth noticing, or about to stop the session. */
export type BudgetLevel = 'ok' | 'warn' | 'critical';

/** At or above this, a surface tints amber. */
export const BUDGET_WARN_PERCENT = 80;
/** At or above this — or whenever the provider says `rate-limited` — rose. */
export const BUDGET_CRITICAL_PERCENT = 95;

/**
 * Where a window sits on the ok / warn / critical ladder.
 *
 * `rate-limited` is critical whatever the percent says: a provider that has
 * started refusing calls is the fact the surface exists to report, and the
 * percent it last reported can lag that refusal.
 *
 * Mirrors `budgetLevel` in `@slicc/webcomponents` — same thresholds, same
 * rule. The duplication buys the shell and the kernel a copy with no DOM
 * dependency; `provider-budget.test.ts` pins the two together.
 */
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

/**
 * The reset line the surfaces print: `resets in 18h`.
 *
 * Relative, never a calendar date. It is locale-free (so a panel, a pill and
 * a terminal render the same string, and tests are deterministic), and it
 * answers the question actually being asked — "will this window turn over
 * before I need it?" — which a weekday name only answers after arithmetic.
 *
 * Returns `undefined` when the provider named no instant, so callers omit the
 * fragment rather than printing an empty one.
 */
export function formatBudgetResets(
  resetsAt: string | undefined,
  now: number = Date.now()
): string | undefined {
  if (!resetsAt) return undefined;
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return undefined;
  const delta = at - now;
  // A window past its own reset instant has not been re-reported yet. Say
  // that plainly instead of counting up into "resets in -2h".
  if (delta <= 0) return 'resetting now';
  if (delta < HOUR_MS) return `resets in ${Math.max(1, Math.round(delta / MINUTE_MS))}m`;
  if (delta < DAY_MS) return `resets in ${Math.round(delta / HOUR_MS)}h`;
  return `resets in ${Math.round(delta / DAY_MS)}d`;
}

/**
 * The figure, without its `%` — one decimal below 10, whole above.
 *
 * Mirrors `formatBudgetPercent` in `@slicc/webcomponents`: `9.5` is the
 * difference between "nothing yet" and "the morning cost a tenth of the
 * week", while `63.2` vs `63` is noise on a number that moves in whole units.
 * Duplicated rather than imported because the shell command must not pull a
 * DOM-bound component library into the kernel-worker bundle; the two are
 * pinned together by `provider-budget.test.ts`.
 */
export function formatBudgetPercent(percent: number): string {
  if (!Number.isFinite(percent)) return '0';
  const value = Math.max(0, percent);
  return value < 10 ? String(Number(value.toFixed(1))) : String(Math.round(value));
}

/** `9.5% of weekly budget used`, plus the refusal and the reset when they apply. */
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
