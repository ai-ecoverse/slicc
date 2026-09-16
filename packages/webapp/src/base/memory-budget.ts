/**
 * Cone durable-memory budget policy — pure, dependency-free.
 *
 * Lives in `base/` (bottom rung) so the `memory` shell command can report
 * the budget without a shell → scoops layer back-edge. The consolidation
 * machinery that APPLIES the budget stays in `scoops/cone-memory-budget.ts`,
 * which re-exports these so existing callers keep their import path.
 */

/**
 * The one instruction document both memory passes run under (#3157): the
 * per-session curation pass and the nightly consolidation ("dreaming") pass
 * differ only in the `{{TASK}}` paragraph the runtime fills in and in which
 * timeout bounds them. Under `/etc/` like the other policy files, seeded
 * only when absent so edits survive boots. Here, not in `scoops/`, so the
 * `memory` shell command can name it without a layer back-edge.
 */
export const MEMORY_INSTRUCTIONS_PATH = '/etc/MEMORY.md';

/**
 * Where the curator's and the dreamer's documents lived before they were
 * merged. Nothing reads them any more; `memory status` reports a surviving
 * copy so a customization is carried over by hand instead of silently
 * ignored.
 */
export const LEGACY_MEMORY_INSTRUCTION_PATHS: readonly string[] = [
  '/shared/MEMORY.md',
  '/shared/DREAMING.md',
];

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
