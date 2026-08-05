import DEFAULT_MEMORY_MD from '../../../vfs-root/shared/MEMORY.md?raw';
import { createLogger } from '../core/logger.js';
import type { LocalVfsClient } from '../kernel/local-vfs-client.js';
import type { AgentBridge, AgentSpawnOptions, AgentSpawnResult } from './agent-bridge.js';
import { CONE_MEMORY_PATH, computeBudget } from './cone-memory-budget.js';

export { DEFAULT_MEMORY_MD };

const log = createLogger('agentic-memory');

export const MEMORY_INSTRUCTIONS_PATH = '/shared/MEMORY.md';
export const DEFAULT_MEMORY_TIMEOUT_SECONDS = 120;
export const MAX_MEMORY_TIMEOUT_SECONDS = 600;

const DEFAULT_WRITABLE_PATHS = ['/workspace/'];
const DEFAULT_VISIBLE_PATHS = ['/sessions/', '/shared/'];
const DEFAULT_ALLOWED_COMMANDS = [
  'cat',
  'find',
  'grep',
  'head',
  'ls',
  'mkdir',
  'mv',
  'sed',
  'tail',
  'touch',
  'wc',
];
const ARRAY_KEYS = new Set(['writablePaths', 'visiblePaths', 'allowedCommands']);
const SCALAR_KEYS = new Set(['model', 'timeoutSeconds']);

interface MemoryConfig {
  writablePaths: string[];
  visiblePaths: string[];
  allowedCommands: string[];
  model?: string;
  timeoutSeconds: number;
  promptTemplate: string;
}

export interface RunAgenticMemoryPassOptions {
  spawn: AgentBridge['spawn'];
  vfs: Pick<LocalVfsClient, 'readFile'>;
  sessionArchivePath: string;
  sessionCount: number;
  signal?: AbortSignal;
}

export interface AgenticMemoryPassResult {
  ok: boolean;
  reason?: string;
}

type FrontmatterValue = string | string[];
type WaitOutcome =
  | { type: 'result'; result: AgentSpawnResult }
  | { type: 'error'; error: unknown }
  | { type: 'timeout' }
  | { type: 'aborted' };

export async function runAgenticMemoryPass(
  opts: RunAgenticMemoryPassOptions
): Promise<AgenticMemoryPassResult> {
  try {
    if (opts.signal?.aborted) return { ok: false, reason: 'aborted' };
    const config = await loadMemoryConfig(opts.vfs);
    const prompt = substitutePlaceholders(config.promptTemplate, {
      MEMORY_PATH: CONE_MEMORY_PATH,
      SESSION_ARCHIVE_PATH: opts.sessionArchivePath,
      SESSION_COUNT: String(opts.sessionCount),
      BUDGET_CHARS: String(computeBudget(opts.sessionCount)),
    });
    const spawnOptions = buildSpawnOptions(config, prompt);
    const spawnPromise = Promise.resolve().then(() => opts.spawn(spawnOptions));
    const outcome = await waitForSpawn(spawnPromise, config.timeoutSeconds * 1000, opts.signal);
    if (outcome.type === 'timeout') return { ok: false, reason: 'timeout' };
    if (outcome.type === 'aborted') return { ok: false, reason: 'aborted' };
    if (outcome.type === 'error') return { ok: false, reason: errorText(outcome.error) };
    if (outcome.result.exitCode !== 0) {
      return { ok: false, reason: outcome.result.finalText || `exit-${outcome.result.exitCode}` };
    }
    return { ok: true };
  } catch (error) {
    log.warn('Agentic memory pass failed', { error: errorText(error) });
    return { ok: false, reason: errorText(error) };
  }
}

async function loadMemoryConfig(vfs: Pick<LocalVfsClient, 'readFile'>): Promise<MemoryConfig> {
  try {
    const raw = await vfs.readFile(MEMORY_INSTRUCTIONS_PATH, { encoding: 'utf-8' });
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    return parseMemoryDocument(text);
  } catch (error) {
    log.warn('Could not load valid MEMORY.md; using built-in default', {
      error: errorText(error),
    });
    return parseMemoryDocument(DEFAULT_MEMORY_MD);
  }
}

function parseMemoryDocument(content: string): MemoryConfig {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const match = normalized.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match?.[2].trim()) throw new Error('MEMORY.md requires frontmatter and a prompt');
  const values = parseFrontmatter(match[1]);
  const writablePaths = readArray(values, 'writablePaths', DEFAULT_WRITABLE_PATHS);
  if (writablePaths.length === 0) throw new Error('writablePaths must not be empty');
  validatePaths(writablePaths, 'writablePaths');
  const visiblePaths = readArray(values, 'visiblePaths', DEFAULT_VISIBLE_PATHS);
  validatePaths(visiblePaths, 'visiblePaths');
  const timeoutSeconds = readTimeout(values.timeoutSeconds);
  const model = readOptionalString(values.model, 'model');
  return {
    writablePaths,
    visiblePaths,
    allowedCommands: readArray(values, 'allowedCommands', DEFAULT_ALLOWED_COMMANDS),
    ...(model ? { model } : {}),
    timeoutSeconds,
    promptTemplate: match[2].trim(),
  };
}

function parseFrontmatter(frontmatter: string): Record<string, FrontmatterValue> {
  const result: Record<string, FrontmatterValue> = {};
  const lines = frontmatter.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const keyMatch = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
    if (!keyMatch) throw new Error(`Invalid frontmatter line: ${line}`);
    const [, key, rest] = keyMatch;
    if (ARRAY_KEYS.has(key)) {
      const parsed = parseArrayValue(lines, index, rest);
      result[key] = parsed.value;
      index = parsed.lastIndex;
    } else if (SCALAR_KEYS.has(key) && rest.trim()) {
      result[key] = parseScalar(rest);
    } else {
      throw new Error(`Unsupported or empty frontmatter field: ${key}`);
    }
  }
  return result;
}

function parseArrayValue(
  lines: string[],
  keyIndex: number,
  inline: string
): { value: string[]; lastIndex: number } {
  if (inline.trim()) {
    const value = inline.trim();
    if (!value.startsWith('[') || !value.endsWith(']')) throw new Error('Expected an array');
    const inner = value.slice(1, -1).trim();
    return {
      value: inner ? inner.split(',').map(parseScalar) : [],
      lastIndex: keyIndex,
    };
  }
  const value: string[] = [];
  let lastIndex = keyIndex;
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    const item = lines[index].match(/^\s+-\s+(.+)$/);
    if (!item) break;
    value.push(parseScalar(item[1]));
    lastIndex = index;
  }
  return { value, lastIndex };
}

function parseScalar(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error('Empty frontmatter value');
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.at(-1) === quote) return value.slice(1, -1);
  if (quote === '"' || quote === "'") throw new Error('Unclosed quoted value');
  return value;
}

function readArray(
  values: Record<string, FrontmatterValue>,
  key: string,
  fallback: string[]
): string[] {
  const value = values[key];
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.some((item) => !item)) throw new Error(`${key} is invalid`);
  return [...value];
}

function readOptionalString(value: FrontmatterValue | undefined, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value) throw new Error(`${key} is invalid`);
  return value;
}

function readTimeout(value: FrontmatterValue | undefined): number {
  if (value === undefined) return DEFAULT_MEMORY_TIMEOUT_SECONDS;
  if (typeof value !== 'string') throw new Error('timeoutSeconds is invalid');
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('timeoutSeconds must be positive');
  return Math.min(parsed, MAX_MEMORY_TIMEOUT_SECONDS);
}

function validatePaths(paths: string[], key: string): void {
  if (paths.some((path) => !path.startsWith('/') || path.includes('\0'))) {
    throw new Error(`${key} must contain absolute VFS paths`);
  }
}

function buildSpawnOptions(config: MemoryConfig, prompt: string): AgentSpawnOptions {
  const inheritedModel = config.model === 'parent' || config.model === 'cone';
  return {
    cwd: config.writablePaths[0].replace(/\/+$/, '') || '/',
    writablePaths: config.writablePaths,
    visiblePaths: config.visiblePaths,
    allowedCommands: config.allowedCommands,
    prompt,
    ...(!inheritedModel && config.model ? { modelId: config.model } : {}),
  };
}

function substitutePlaceholders(template: string, values: Record<string, string>): string {
  let prompt = template;
  for (const [name, value] of Object.entries(values)) {
    prompt = prompt.replaceAll(`{{${name}}}`, value);
  }
  return prompt;
}

function waitForSpawn(
  spawnPromise: Promise<AgentSpawnResult>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<WaitOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: WaitOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => finish({ type: 'aborted' });
    const timer = setTimeout(() => finish({ type: 'timeout' }), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    spawnPromise.then(
      (result) => finish({ type: 'result', result }),
      (error: unknown) => finish({ type: 'error', error })
    );
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
