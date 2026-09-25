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

const CURATION_DRAFT_PATTERN = /^\/sessions\/\.curation\/[^/]+\/draft\.md$/;

const MEMORY_FILE_PATTERNS: readonly RegExp[] = [
  /^\/workspace\/CLAUDE\.md$/,
  /^\/shared\/CLAUDE\.md$/,
  /^\/(?:cones|scoops)\/[^/]+\/CLAUDE\.md$/,
  CURATION_DRAFT_PATTERN,
];

function tidyMemoryPath(path: string): string {
  return `/${path}`
    .replace(/\/+/g, '/')
    .replace(/\/\.(?=\/)/g, '')
    .replace(/\/$/, '');
}

export function isMemoryFilePath(path: string): boolean {
  const normalized = tidyMemoryPath(path);
  return MEMORY_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isCurationDraftPath(path: string): boolean {
  return CURATION_DRAFT_PATTERN.test(tidyMemoryPath(path));
}

export function isMemoryPassSandbox(writablePaths: readonly string[]): boolean {
  return writablePaths.some(isCurationDraftPath);
}

export const MEMORY_WRITE_TOOL_NAME = 'memory_write';

export const MEMORY_FILE_GUARD_MESSAGE = `memory files are budget-guarded — write them with the ${MEMORY_WRITE_TOOL_NAME} tool, which enforces the budget and reports the remaining room`;
