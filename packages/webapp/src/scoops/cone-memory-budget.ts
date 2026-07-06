/**
 * Cone memory budget — bound the size of `/workspace/CLAUDE.md` against a
 * logarithmic budget derived from the session count, and run an LLM-driven
 * restructure pass over the auto-extracted tail when an append overshoots.
 *
 * The header above the first `## Auto-extracted` heading is user-authored
 * and preserved verbatim. Only the auto-extracted tail is consolidated.
 */

import type { Api, Model, UserMessage } from '@earendil-works/pi-ai';
import { completeSimple } from '@earendil-works/pi-ai/compat';
import { createLogger } from '../core/logger.js';
import type { LocalVfsClient } from '../kernel/local-vfs-client.js';
import type { WritableVfsClient } from '../kernel/writable-vfs-client.js';

const log = createLogger('cone-memory-budget');

/** Base allowance in characters before the logarithmic term kicks in. */
export const MEMORY_BASE_CHARS = 4000;
/** Per-log2(N+2) growth in characters. */
export const MEMORY_PER_LOG_CHARS = 2000;
/** Ratio over the budget that triggers a restructure pass. */
export const MEMORY_OVERSHOOT_RATIO = 1.25;

export const CONE_MEMORY_PATH = '/workspace/CLAUDE.md';
export const SESSIONS_INDEX_PATH = '/sessions/index.json';

const RESTRUCTURE_MAX_TOKENS = 4096;
const AUTO_EXTRACTED_HEADING_RE = /^## Auto-extracted/m;

const RESTRUCTURE_INSTRUCTION = `Consolidate the auto-extracted memory bullets below into a single tighter set of durable memories.

Rules:
- Output ONLY a single \`## Auto-extracted (consolidated)\` heading followed by markdown bullets.
- One fact per bullet. Drop duplicates and superseded facts. Keep the most recent / specific phrasing.
- Preserve concrete identifiers (file paths, URLs, IDs, names) verbatim.
- Be terse. Aim well under the original size.
- Do NOT add preamble, commentary, or any heading other than the single consolidated one.`;

/**
 * Budget in characters as a function of session count.
 * `BASE + PER_LOG * log2(N + 2)`. `N + 2` so N=0 yields a non-zero log term.
 */
export function computeBudget(sessionCount: number): number {
  const n = Number.isFinite(sessionCount) && sessionCount >= 0 ? sessionCount : 0;
  return Math.round(MEMORY_BASE_CHARS + MEMORY_PER_LOG_CHARS * Math.log2(n + 2));
}

/**
 * Split cone-memory content at the first `## Auto-extracted` heading. The
 * header (everything before that heading) is user-authored and preserved
 * verbatim. The tail is the entire auto-extracted region we may restructure.
 */
export function splitConeMemory(content: string): { header: string; autoExtracted: string } {
  const match = AUTO_EXTRACTED_HEADING_RE.exec(content);
  if (!match) return { header: content, autoExtracted: '' };
  const idx = match.index;
  return { header: content.slice(0, idx), autoExtracted: content.slice(idx) };
}

/** Best-effort read of /sessions/index.json — returns 0 on any failure. */
export async function readSessionCount(vfs: LocalVfsClient): Promise<number> {
  try {
    const raw = await vfs.readFile(SESSIONS_INDEX_PATH, { encoding: 'utf-8' });
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

export interface RestructureConeMemoryOptions {
  /** Current full file content (header + auto-extracted tail). */
  currentContent: string;
  /** Computed budget; only used as advisory context in the system prompt. */
  budget: number;
  model: Model<Api>;
  apiKey: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * Run the LLM consolidation pass over the auto-extracted tail. Returns the
 * new full file content (header preserved verbatim + consolidated tail).
 * Throws on LLM error or when the response is empty — callers should treat
 * any failure as best-effort and keep the unrestructured content in place.
 */
export async function restructureConeMemory(opts: RestructureConeMemoryOptions): Promise<string> {
  const { header, autoExtracted } = splitConeMemory(opts.currentContent);
  if (!autoExtracted.trim()) {
    // No auto-extracted tail to restructure — nothing to do.
    return opts.currentContent;
  }

  const systemPrompt = `You are a memory consolidation assistant. You are given a markdown file's "auto-extracted" section — a list of memory bullets accumulated across sessions of an AI coding assistant. Your job is to rewrite that section as a tighter, deduplicated set of durable memories that fits well within ${opts.budget} characters.

<auto-extracted>
${autoExtracted}
</auto-extracted>`;

  const userMessage: UserMessage = {
    role: 'user',
    content: [{ type: 'text', text: RESTRUCTURE_INSTRUCTION }],
    timestamp: Date.now(),
  };

  const response = await completeSimple(
    opts.model,
    { systemPrompt, messages: [userMessage] },
    {
      apiKey: opts.apiKey,
      maxTokens: RESTRUCTURE_MAX_TOKENS,
      headers: opts.headers,
      signal: opts.signal,
    }
  );
  if (response.stopReason === 'error') {
    throw new Error(`Restructure call failed: ${response.errorMessage || 'Unknown error'}`);
  }
  const consolidated = response.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
    .trim();
  if (!consolidated) {
    throw new Error('Restructure call returned empty content');
  }

  const separator = header.length === 0 || header.endsWith('\n') ? '' : '\n';
  return `${header}${separator}${consolidated}\n`;
}

export interface ApplyConeMemoryBudgetOptions {
  /**
   * Writable VFS handle. Callers under `slicc_opfs_vfs === 'opfs'`
   * pass a `RemoteWritableVfsClient` so reads/writes route through
   * the worker's `VfsRpcHost`; with the flag off, the page-side
   * `VirtualFS` satisfies the same shape.
   */
  vfs: WritableVfsClient;
  model?: Model<Api>;
  apiKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * Read `/workspace/CLAUDE.md`, compute the current budget from
 * `/sessions/index.json`, and if the file is over `budget * overshoot`
 * restructure the auto-extracted tail via {@link restructureConeMemory}
 * and write the result back. No-op when the file is under threshold or
 * when no LLM credentials are wired. Errors are logged and swallowed —
 * callers always succeed and the appended (unrestructured) content stays
 * in place.
 */
export async function applyConeMemoryBudget(
  opts: ApplyConeMemoryBudgetOptions
): Promise<{ restructured: boolean; reason?: string }> {
  if (!opts.model || !opts.apiKey) {
    return { restructured: false, reason: 'no-llm' };
  }
  let current = '';
  try {
    const raw = await opts.vfs.readFile(CONE_MEMORY_PATH, { encoding: 'utf-8' });
    current = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  } catch {
    return { restructured: false, reason: 'missing-file' };
  }

  const sessionCount = await readSessionCount(opts.vfs);
  const budget = computeBudget(sessionCount);
  const threshold = budget * MEMORY_OVERSHOOT_RATIO;
  if (current.length <= threshold) {
    return { restructured: false, reason: 'under-threshold' };
  }

  log.info('Cone memory over threshold — restructuring', {
    size: current.length,
    budget,
    threshold,
    sessionCount,
  });

  try {
    const next = await restructureConeMemory({
      currentContent: current,
      budget,
      model: opts.model,
      apiKey: opts.apiKey,
      headers: opts.headers,
      signal: opts.signal,
    });
    await opts.vfs.writeFile(CONE_MEMORY_PATH, next);
    log.info('Cone memory restructured', { before: current.length, after: next.length });
    return { restructured: true };
  } catch (err) {
    log.warn('Cone memory restructure failed — leaving appended content in place', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { restructured: false, reason: 'error' };
  }
}
