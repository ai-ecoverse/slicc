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

/**
 * The files the memory budget governs — every durable-memory file an agent
 * can be pointed at, and nothing else:
 *
 * - the primary cone's memory (`/workspace/CLAUDE.md`);
 * - an extra cone's or a scoop's memory (`/cones/<f>/CLAUDE.md`,
 *   `/scoops/<f>/CLAUDE.md` — `workspaceFor(...).memoryPath`);
 * - the global memory every unit reads (`/shared/CLAUDE.md`);
 * - a curation pass's staged draft (`/sessions/.curation/<key>/draft.md`),
 *   which `{{MEMORY_PATH}}` resolves to and the runtime merges back.
 *
 * Deliberately NOT "any file named CLAUDE.md": a repository checked out under
 * the workspace carries developer docs of that name, and those are neither
 * memory nor subject to the memory budget.
 */
/** A curation pass's staged draft — what `{{MEMORY_PATH}}` resolves to. */
const CURATION_DRAFT_PATTERN = /^\/sessions\/\.curation\/[^/]+\/draft\.md$/;

const MEMORY_FILE_PATTERNS: readonly RegExp[] = [
  /^\/workspace\/CLAUDE\.md$/,
  /^\/shared\/CLAUDE\.md$/,
  /^\/(?:cones|scoops)\/[^/]+\/CLAUDE\.md$/,
  CURATION_DRAFT_PATTERN,
];

/**
 * Accept the un-normalized spellings a shell produces (`//`, `/./`, a
 * trailing slash) without resolving `..` — a caller that needs symlink-safe
 * resolution normalizes first.
 */
function tidyMemoryPath(path: string): string {
  return `/${path}`
    .replace(/\/+/g, '/')
    .replace(/\/\.(?=\/)/g, '')
    .replace(/\/$/, '');
}

/**
 * Whether `path` is a budget-governed memory file (see
 * {@link MEMORY_FILE_PATTERNS}).
 */
export function isMemoryFilePath(path: string): boolean {
  const normalized = tidyMemoryPath(path);
  return MEMORY_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** Whether `path` is a curation pass's staged draft (`/sessions/.curation/<key>/draft.md`). */
export function isCurationDraftPath(path: string): boolean {
  return CURATION_DRAFT_PATTERN.test(tidyMemoryPath(path));
}

/**
 * Whether a sandbox is a memory pass's: the only units granted a write on a
 * staged curation draft are the curator and the dreamer (`redirectWritesToDraft`
 * in `scoops/agentic-memory.ts` puts it there for every pass). Derived from
 * the grant rather than from a flag so it holds for restored units and for a
 * customized `/etc/MEMORY.md` alike — the grant is what makes the unit a pass.
 * The bridge spells file grants with a trailing slash, which the predicate
 * tolerates (#3459).
 */
export function isMemoryPassSandbox(writablePaths: readonly string[]): boolean {
  return writablePaths.some(isCurationDraftPath);
}

/** Tool name every memory-file write is routed through. */
export const MEMORY_WRITE_TOOL_NAME = 'memory_write';

/**
 * Refusal every other write path (`write_file`, `edit`, a shell
 * redirection, `cp`) reports for a memory file — names the tool that IS
 * allowed to write it, and why.
 */
export const MEMORY_FILE_GUARD_MESSAGE = `memory files are budget-guarded — write them with the ${MEMORY_WRITE_TOOL_NAME} tool, which enforces the budget and reports the remaining room`;
