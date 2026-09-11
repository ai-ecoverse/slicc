/**
 * Cone durable-memory budget policy — pure, dependency-free.
 *
 * Lives in `base/` (bottom rung) so the `memory` shell command can report
 * the budget without a shell → scoops layer back-edge. The consolidation
 * machinery that APPLIES the budget stays in `scoops/cone-memory-budget.ts`,
 * which re-exports these so existing callers keep their import path.
 */

/** Base allowance in characters before the logarithmic term kicks in. */
export const MEMORY_BASE_CHARS = 4000;
/** Per-log2(N+2) growth in characters. */
export const MEMORY_PER_LOG_CHARS = 2000;

/**
 * Budget in characters as a function of session count.
 * `BASE + PER_LOG * log2(N + 2)`. `N + 2` so N=0 yields a non-zero log term.
 */
export function computeBudget(sessionCount: number): number {
  const n = Number.isFinite(sessionCount) && sessionCount >= 0 ? sessionCount : 0;
  return Math.round(MEMORY_BASE_CHARS + MEMORY_PER_LOG_CHARS * Math.log2(n + 2));
}
