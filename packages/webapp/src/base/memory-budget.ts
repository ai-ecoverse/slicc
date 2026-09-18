export const MEMORY_INSTRUCTIONS_PATH = '/etc/MEMORY.md';

export const LEGACY_MEMORY_INSTRUCTION_PATHS: readonly string[] = [
  '/shared/MEMORY.md',
  '/shared/DREAMING.md',
];

export const MEMORY_BASE_CHARS = 4000;

export const MEMORY_PER_LOG_CHARS = 2000;

export function computeBudget(sessionCount: number): number {
  const n = Number.isFinite(sessionCount) && sessionCount >= 0 ? sessionCount : 0;
  return Math.round(MEMORY_BASE_CHARS + MEMORY_PER_LOG_CHARS * Math.log2(n + 2));
}

const MEMORY_FILE_PATTERNS: readonly RegExp[] = [
  /^\/workspace\/CLAUDE\.md$/,
  /^\/shared\/CLAUDE\.md$/,
  /^\/(?:cones|scoops)\/[^/]+\/CLAUDE\.md$/,
  /^\/sessions\/\.curation\/[^/]+\/draft\.md$/,
];

export function isMemoryFilePath(path: string): boolean {
  const normalized = `/${path}`
    .replace(/\/+/g, '/')
    .replace(/\/\.(?=\/)/g, '')
    .replace(/\/$/, '');
  return MEMORY_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export const MEMORY_WRITE_TOOL_NAME = 'memory_write';

export const MEMORY_FILE_GUARD_MESSAGE = `memory files are budget-guarded — write them with the ${MEMORY_WRITE_TOOL_NAME} tool, which enforces the budget and reports the remaining room`;
