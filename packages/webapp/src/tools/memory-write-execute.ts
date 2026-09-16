/**
 * `memory_write` implementation (#3157), loaded on the first call — see
 * `memory-write-tool.ts` for the registration.
 *
 * Every other writer (`write_file`, `edit`, the shell) is refused on a
 * memory file by `fs/memory-guard-fs.ts`; this tool gets the undecorated
 * handle and owns the budget rule:
 *
 * - under budget: any write lands;
 * - over budget: a write lands only if it SHRINKS the file — an over-budget
 *   file may get smaller, never larger, and a file may never cross the
 *   budget upward;
 * - every result reports the size that landed and the remaining room or
 *   overage, so the caller never spends a turn on `wc -c` to learn it.
 *
 * Two shapes, one rule: a whole-file `content` (the curator's single write)
 * or exact-match `edits` (a cone recording one fact without re-emitting an
 * 80 KB file — the re-emission that burned the #3157 dreamers' budgets).
 * Both compute the resulting text first and gate it the same way.
 */

import { computeBudget, isMemoryFilePath } from '../base/memory-budget.js';
import type { VirtualFS } from '../fs/index.js';
import { normalizePath } from '../fs/path-utils.js';
import type { MemoryWriteInput, MemoryWriteToolDeps } from './memory-write-tool.js';
import type { ToolResult } from './types.js';
import { verifyWriteLanded } from './write-verification.js';

/** One exact replacement; `oldText` must occur exactly once. */
export interface MemoryEdit {
  oldText: string;
  newText: string;
}

function isEditList(value: unknown): value is MemoryEdit[] {
  return (
    Array.isArray(value) &&
    value.every(
      (edit) =>
        edit !== null &&
        typeof edit === 'object' &&
        typeof (edit as MemoryEdit).oldText === 'string' &&
        typeof (edit as MemoryEdit).newText === 'string'
    )
  );
}

/** Apply exact, unique replacements; a miss or an ambiguous match is an error. */
export function applyMemoryEdits(
  current: string,
  edits: readonly MemoryEdit[]
): { ok: true; content: string } | { ok: false; error: string } {
  let text = current;
  for (const [index, edit] of edits.entries()) {
    if (edit.oldText.length === 0) {
      return { ok: false, error: `edit ${index + 1}: oldText must not be empty` };
    }
    const first = text.indexOf(edit.oldText);
    if (first === -1) {
      return { ok: false, error: `edit ${index + 1}: oldText not found in the current file` };
    }
    if (text.indexOf(edit.oldText, first + 1) !== -1) {
      return {
        ok: false,
        error: `edit ${index + 1}: oldText occurs more than once; include more context to make it unique`,
      };
    }
    text = text.slice(0, first) + edit.newText + text.slice(first + edit.oldText.length);
  }
  return { ok: true, content: text };
}

/** Size report appended to every successful write. */
export function describeBudgetPosition(size: number, budget: number): string {
  if (size <= budget) {
    return `${size} chars, ${budget - size} under the ${budget}-char budget.`;
  }
  return `${size} chars, ${size - budget} OVER the ${budget}-char budget — the next write must be smaller than ${size} chars.`;
}

/**
 * The budget rule. Growth is refused only while the RESULT would sit over
 * budget: an over-budget file may shrink by any amount, and an under-budget
 * file may grow up to the budget, never past it.
 */
export function memoryWriteVerdict(
  currentSize: number,
  nextSize: number,
  budget: number
): { allowed: true } | { allowed: false; reason: string } {
  if (nextSize <= budget || nextSize < currentSize) return { allowed: true };
  const overage = nextSize - budget;
  const change =
    nextSize === currentSize
      ? `stay at ${currentSize} chars`
      : `grow from ${currentSize} to ${nextSize} chars`;
  return {
    allowed: false,
    reason: `Rejected: the file would ${change}, ${overage} over the ${budget}-char budget. Over budget, a write must shrink the file — cut a whole section rather than shaving characters, then write again.`,
  };
}

async function readCurrent(fs: VirtualFS, path: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path, { encoding: 'utf-8' });
    return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'ENOENT') return null;
    throw err;
  }
}

function resolveNext(
  input: MemoryWriteInput,
  current: string | null,
  path: string
): { ok: true; next: string } | { ok: false; error: string } {
  if (typeof input.content === 'string') return { ok: true, next: input.content };
  if (!isEditList(input.edits)) {
    return { ok: false, error: '`edits` must be a list of { oldText, newText }' };
  }
  if (current === null) {
    return { ok: false, error: `${path} does not exist yet — pass \`content\` to create it` };
  }
  const applied = applyMemoryEdits(current, input.edits);
  return applied.ok ? { ok: true, next: applied.content } : applied;
}

export async function executeMemoryWrite(
  fs: VirtualFS,
  deps: MemoryWriteToolDeps,
  input: MemoryWriteInput
): Promise<ToolResult> {
  if (typeof input.path !== 'string' || input.path.length === 0) {
    return { content: 'memory_write: `path` is required', isError: true };
  }
  const path = normalizePath(input.path);
  if (!isMemoryFilePath(path)) {
    return {
      content: `memory_write: ${path} is not a memory file — use write_file or edit for ordinary files`,
      isError: true,
    };
  }
  if ((typeof input.content === 'string') === (input.edits !== undefined)) {
    return {
      content:
        'memory_write: pass exactly one of `content` (whole file) or `edits` (exact replacements)',
      isError: true,
    };
  }
  try {
    const current = await readCurrent(fs, path);
    const resolved = resolveNext(input, current, path);
    if (!resolved.ok) return { content: `memory_write: ${resolved.error}`, isError: true };
    const budget = computeBudget(await deps.readSessionCount());
    const verdict = memoryWriteVerdict(current?.length ?? 0, resolved.next.length, budget);
    if (!verdict.allowed) return { content: `memory_write: ${verdict.reason}`, isError: true };
    await fs.writeFile(path, resolved.next);
    const durabilityError = await verifyWriteLanded(fs, path, resolved.next);
    if (durabilityError) return { content: durabilityError, isError: true };
    return { content: `Wrote ${path}: ${describeBudgetPosition(resolved.next.length, budget)}` };
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }
}
