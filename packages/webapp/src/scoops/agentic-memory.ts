import DEFAULT_MEMORY_MD from '../../../vfs-root/shared/MEMORY.md?raw';
import { createLogger } from '../core/logger.js';
import type { LocalVfsClient } from '../kernel/local-vfs-client.js';
import type { AgentBridge, AgentSpawnOptions, AgentSpawnResult } from './agent-bridge.js';
import { CONE_MEMORY_PATH, computeBudget } from './cone-memory-budget.js';
import { isThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from './types.js';

export { DEFAULT_MEMORY_MD };

const log = createLogger('agentic-memory');

export const MEMORY_INSTRUCTIONS_PATH = '/shared/MEMORY.md';
export const DEFAULT_MEMORY_TIMEOUT_SECONDS = 120;
export const MAX_MEMORY_TIMEOUT_SECONDS = 600;

/**
 * Exactly the memory file, not `/workspace/`. The curator is given `upskill` so
 * it can look up skills, and `upskill <owner>/<repo> --all` installs into
 * `/workspace/skills/`, which a `/workspace/` root would have permitted. A
 * single-file root grants the one write the curator actually needs and turns
 * any other write — an install, a stray backup — into a cone escalation.
 */
const DEFAULT_WRITABLE_PATHS = [CONE_MEMORY_PATH];
/** `/workspace/` is readable so the curator can still orient; only writes narrow. */
const DEFAULT_VISIBLE_PATHS = ['/sessions/', '/shared/', '/workspace/'];
/** Directory the curator starts in; `writablePaths` may be a bare file. */
const CURATOR_CWD = '/workspace';
/**
 * Commands the curator may run without escalating. Non-cone scoops run under
 * `defaultDisposition: 'require-approval'`, so a command missing here does not
 * fail — it raises a sudo request against the cone mid-conversation. The
 * curator runs unattended and its scoop folder (and any "always" grant the
 * cone persists into it) is destroyed when the run ends, so every gap becomes
 * a recurring interruption that can never be granted away. Keep this list
 * ahead of what the prompt in `vfs-root/shared/MEMORY.md` asks for.
 */
const DEFAULT_ALLOWED_COMMANDS = [
  'awk',
  'cat',
  'cp',
  'cut',
  'date',
  'diff',
  'du',
  'echo',
  'file',
  'find',
  'grep',
  'head',
  // Structured reads of JSON stores the curator mines (e.g.
  // /shared/loose-ends.json) — without it every jq read escalates.
  'jq',
  'ls',
  'mkdir',
  // Bare `mount` lists mount state, which the curator records (dropped
  // mounts are a recurring session fact). Mutating calls stay contained by
  // the FS grant, not by this list: mounting needs a user picker gesture
  // (local) or credentials the curator cannot read (remote), and `mount
  // unmount <path>` hits `RestrictedFS.checkWrite` on the mount path —
  // EACCES under the curator's single-file `writablePaths`. If that
  // checkWrite ever moves out of `RestrictedFS.unmount`, revisit this entry.
  'mount',
  'mv',
  'nl',
  // Byte-level inspection (od/xxd) of corrupted stores — e.g. verifying the
  // OPFS write-race residue pitfall — is read-only and recurred as a sudo
  // interruption in real curator runs (2026-08-07).
  'od',
  'printf',
  'readlink',
  'sed',
  'sort',
  'stat',
  'tail',
  'touch',
  'tr',
  'uniq',
  // Read-only skill discovery for the pitfalls it finds. Installing is not
  // reachable: `writablePaths` grants the memory file alone, so a write into
  // `/workspace/skills/` matches no grant and escalates instead of landing.
  'upskill',
  'wc',
  'xxd',
];
const ARRAY_KEYS = new Set(['writablePaths', 'visiblePaths', 'allowedCommands']);
const SCALAR_KEYS = new Set(['model', 'timeoutSeconds', 'thinkingLevel']);

/**
 * Spawned agents resolve an absent thinking level to `'off'`. That is wrong for
 * curation: without reasoning the curator converges on the budget by trial and
 * error, and because every turn re-reads the whole context as a cache read, turn
 * count is what the pass actually costs. Paying for reasoning once is cheaper
 * than paying for the turns it removes.
 */
const DEFAULT_MEMORY_THINKING_LEVEL: ThinkingLevel = 'medium';

/**
 * Headroom the outer safety wait grants beyond the run's own wall-clock
 * bound (#1972), so the bounded in-run failure — which stops the agent
 * and is safe to legacy-fallback from — always arrives before the wait
 * gives up (whose timeout must assume the run may still be billing).
 */
const BOUND_GRACE_MS = 30_000;

interface MemoryConfig {
  writablePaths: string[];
  visiblePaths: string[];
  allowedCommands: string[];
  model?: string;
  thinkingLevel: ThinkingLevel;
  timeoutSeconds: number;
  promptTemplate: string;
}

export interface RunAgenticMemoryPassOptions {
  spawn: AgentBridge['spawn'];
  vfs: Pick<LocalVfsClient, 'readFile'>;
  sessionArchivePath: string;
  sessionCount: number;
  /** UTC date override for deterministic tests; defaults to today's date. */
  today?: string;
  signal?: AbortSignal;
}

export type AgenticMemoryPassResult =
  /**
   * `report` is the curator's closing message — what it curated and any skill
   * it found worth suggesting. The cone receives it directly over
   * `scoop-notify`; it is surfaced here too so callers can log it.
   */
  { ok: true; report: string } | { ok: false; reason: string; legacyFallbackSafe: boolean };

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
    if (opts.signal?.aborted) {
      return { ok: false, reason: 'aborted', legacyFallbackSafe: false };
    }
    const config = await loadMemoryConfig(opts.vfs);
    const prompt = substitutePlaceholders(config.promptTemplate, {
      MEMORY_PATH: CONE_MEMORY_PATH,
      SESSION_ARCHIVE_PATH: opts.sessionArchivePath,
      SESSION_COUNT: String(opts.sessionCount),
      BUDGET_CHARS: String(computeBudget(opts.sessionCount)),
      TODAY: opts.today ?? new Date().toISOString().slice(0, 10),
    });
    const spawnOptions = buildSpawnOptions(config, prompt, opts.sessionArchivePath);
    if (opts.signal) spawnOptions.signal = opts.signal;
    const spawnPromise = Promise.resolve().then(() => opts.spawn(spawnOptions));
    // The run carries a REAL wall-clock bound now (#1972) — the bounded
    // failure arrives through the normal exitCode path with
    // `legacyFallbackSafe: true` (the run is genuinely stopped). This wait
    // is only a safety net for a bound that never fires; give it grace so
    // the in-run bound always wins the race.
    const outcome = await waitForSpawn(
      spawnPromise,
      config.timeoutSeconds * 1000 + BOUND_GRACE_MS,
      opts.signal
    );
    if (outcome.type === 'timeout') {
      return { ok: false, reason: 'timeout', legacyFallbackSafe: false };
    }
    if (outcome.type === 'aborted') {
      return { ok: false, reason: 'aborted', legacyFallbackSafe: false };
    }
    if (outcome.type === 'error') {
      return { ok: false, reason: errorText(outcome.error), legacyFallbackSafe: true };
    }
    if (outcome.result.exitCode !== 0) {
      return {
        ok: false,
        reason: outcome.result.finalText || `exit-${outcome.result.exitCode}`,
        legacyFallbackSafe: true,
      };
    }
    return { ok: true, report: outcome.result.finalText };
  } catch (error) {
    log.warn('Agentic memory pass failed', { error: errorText(error) });
    return { ok: false, reason: errorText(error), legacyFallbackSafe: false };
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
    allowedCommands: [
      ...new Set([...DEFAULT_ALLOWED_COMMANDS, ...readArray(values, 'allowedCommands', [])]),
    ],
    ...(model ? { model } : {}),
    thinkingLevel: readThinkingLevel(values.thinkingLevel),
    timeoutSeconds,
    promptTemplate: match[2].trim(),
  };
}

function readThinkingLevel(value: FrontmatterValue | undefined): ThinkingLevel {
  if (value === undefined) return DEFAULT_MEMORY_THINKING_LEVEL;
  if (typeof value !== 'string' || !isThinkingLevel(value)) {
    throw new Error(`thinkingLevel must be one of ${THINKING_LEVELS.join(', ')}`);
  }
  return value;
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
      value: inner ? splitInlineArray(inner) : [],
      lastIndex: keyIndex,
    };
  }
  const value: string[] = [];
  let lastIndex = keyIndex;
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    const item = lines[index].match(/^\s+-\s+(.+)$/);
    if (!item) break;
    value.push(parseScalar(stripBlockArrayComment(item[1])));
    lastIndex = index;
  }
  return { value, lastIndex };
}

function splitInlineArray(inner: string): string[] {
  const items: string[] = [];
  let start = 0;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char === '"' || char === "'") {
      quote = quote === char ? undefined : (quote ?? char);
    } else if (char === ',' && !quote) {
      items.push(parseScalar(inner.slice(start, index)));
      start = index + 1;
    }
  }
  if (quote) throw new Error('Unclosed quoted value');
  items.push(parseScalar(inner.slice(start)));
  return items;
}

function stripBlockArrayComment(raw: string): string {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '"' || char === "'") {
      quote = quote === char ? undefined : (quote ?? char);
    } else if (char === '#' && !quote && (index === 0 || /\s/.test(raw[index - 1]))) {
      return raw.slice(0, index).trimEnd();
    }
  }
  return raw;
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
  if (
    paths.some(
      (path) =>
        !path.startsWith('/') || path.includes('\0') || (key === 'writablePaths' && path === '/')
    )
  ) {
    throw new Error(`${key} must contain absolute VFS paths`);
  }
}

/**
 * Per-archive completion receipt the agent bridge writes (worker realm)
 * when the curator spawn exits 0 — durable proof that THIS archive's
 * curation finished even if the page died before `clearPendingMarkers`
 * landed. The boot catch-up checks it before trusting a surviving
 * `memoryPending` marker (#1989); a shared-file mtime cannot attribute a
 * memory rewrite to a specific archive, this can.
 */
export function curatorReceiptPath(sessionArchivePath: string): string {
  const base = sessionArchivePath.slice(sessionArchivePath.lastIndexOf('/') + 1);
  return `/sessions/.curated/${base}`;
}

function buildSpawnOptions(
  config: MemoryConfig,
  prompt: string,
  sessionArchivePath: string
): AgentSpawnOptions {
  const inheritedModel = config.model === 'parent' || config.model === 'cone';
  return {
    cwd: CURATOR_CWD,
    writablePaths: config.writablePaths,
    visiblePaths: config.visiblePaths,
    allowedCommands: config.allowedCommands,
    prompt,
    thinkingLevel: config.thinkingLevel,
    // The pass is detached, so the caller's return value goes nowhere. Without
    // this the curator's report — including any skill it found — is discarded
    // and the cone never learns the pass happened at all.
    notifyOnComplete: true,
    successReceiptPath: curatorReceiptPath(sessionArchivePath),
    // What `timeoutSeconds` always claimed to mean: the RUN stops at the
    // bound (#1972), instead of only the caller's wait resolving while
    // the agent kept taking turns.
    maxWallClockMs: config.timeoutSeconds * 1000,
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

/**
 * Stops *waiting* on the spawn; it cannot stop the agent. `AgentSpawnOptions`
 * carries no turn bound, deadline or signal, so a timed-out pass keeps taking
 * turns and billing — one measured run overran its 120s timeout by 14.9x and
 * cost $53.81. Tracked in ai-ecoverse/slicc#1972; until that lands, treat a
 * `timeout` outcome as "still running", never as "stopped".
 */
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
