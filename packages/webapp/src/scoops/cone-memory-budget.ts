import type { Api, Model, UserMessage } from '@earendil-works/pi-ai';
import { completeSimple } from '@earendil-works/pi-ai/compat';
import { createLogger } from '../base/logger.js';
import { computeBudget } from '../base/memory-budget.js';
import type { LocalVfsClient } from '../kernel/local-vfs-client.js';
import type { WritableVfsClient } from '../kernel/writable-vfs-client.js';
import { PRIMARY_WORKSPACE } from '../work-unit/descriptor.js';

export { computeBudget, MEMORY_BASE_CHARS, MEMORY_PER_LOG_CHARS } from '../base/memory-budget.js';

const log = createLogger('cone-memory-budget');

export const MEMORY_OVERSHOOT_RATIO = 1.25;

export const CONE_MEMORY_PATH = PRIMARY_WORKSPACE.memoryPath;
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

export function splitConeMemory(content: string): { header: string; autoExtracted: string } {
  const match = AUTO_EXTRACTED_HEADING_RE.exec(content);
  if (!match) return { header: content, autoExtracted: '' };
  const idx = match.index;
  return { header: content.slice(0, idx), autoExtracted: content.slice(idx) };
}

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
  currentContent: string;

  budget: number;
  model: Model<Api>;
  apiKey: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export async function restructureConeMemory(opts: RestructureConeMemoryOptions): Promise<string> {
  const { header, autoExtracted } = splitConeMemory(opts.currentContent);
  if (!autoExtracted.trim()) {
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
  vfs: WritableVfsClient;

  memoryPath?: string;
  model?: Model<Api>;
  apiKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export async function applyConeMemoryBudget(
  opts: ApplyConeMemoryBudgetOptions
): Promise<{ restructured: boolean; reason?: string }> {
  if (!opts.model || !opts.apiKey) {
    return { restructured: false, reason: 'no-llm' };
  }
  const memoryPath = opts.memoryPath ?? CONE_MEMORY_PATH;
  let current = '';
  try {
    const raw = await opts.vfs.readFile(memoryPath, { encoding: 'utf-8' });
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
    await opts.vfs.writeFile(memoryPath, next);
    log.info('Cone memory restructured', { before: current.length, after: next.length });
    return { restructured: true };
  } catch (err) {
    log.warn('Cone memory restructure failed — leaving appended content in place', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { restructured: false, reason: 'error' };
  }
}
