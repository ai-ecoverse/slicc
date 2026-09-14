export const MEMORY_BASE_CHARS = 4000;

export const MEMORY_PER_LOG_CHARS = 2000;

export function computeBudget(sessionCount: number): number {
  const n = Number.isFinite(sessionCount) && sessionCount >= 0 ? sessionCount : 0;
  return Math.round(MEMORY_BASE_CHARS + MEMORY_PER_LOG_CHARS * Math.log2(n + 2));
}
