import DEFAULT_MEMORY_MD from '../../../vfs-root/shared/MEMORY.md?raw';
import { createLogger } from '../base/logger.js';
import type { LocalVfsClient } from '../kernel/local-vfs-client.js';
import {
  defaultChildVisibleRoots,
  PRIMARY_WORKSPACE,
  SKILLS_LIBRARY_DIR,
  workspaceFor,
} from '../work-unit/descriptor.js';
import { PRIMARY_CONE_FOLDER } from '../work-unit/record.js';
import type { WorkUnitWorkspace } from '../work-unit/types.js';
import {
  AGENT_NAME_IN_USE_PREFIX,
  type AgentBridge,
  type AgentSpawnOptions,
  type AgentSpawnResult,
} from './agent-bridge.js';
import { computeBudget } from './cone-memory-budget.js';
import { isThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from './types.js';

export { DEFAULT_MEMORY_MD };

const log = createLogger('agentic-memory');

export const MEMORY_INSTRUCTIONS_PATH = '/shared/MEMORY.md';
export const DEFAULT_MEMORY_TIMEOUT_SECONDS = 600;
export const MAX_MEMORY_TIMEOUT_SECONDS = 1200;

/**
 * Exactly the memory file, not the cone's workspace root. The curator is given
 * `upskill` so it can look up skills, and `upskill <owner>/<repo> --all`
 * installs into `/workspace/skills/`, which a whole-workspace root would have
 * permitted. A single-file root grants the one write the curator actually
 * needs and turns any other write — an install, a stray backup — into a cone
 * escalation.
 */
const defaultWritablePaths = (workspace: WorkUnitWorkspace): string[] => [workspace.memoryPath];
/**
 * The cone's workspace is readable so the curator can still orient; only
 * writes narrow. For an extra cone that is `/cones/<folder>/workspace/` plus
 * the shared skills library, which lives outside it (#2271).
 */
const defaultVisiblePaths = (workspace: WorkUnitWorkspace): string[] => [
  '/sessions/',
  '/shared/',
  ...defaultChildVisibleRoots(workspace),
];
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
  /**
   * The cone whose chat was archived (#2271). The pass runs PER CONE: the
   * curator reads `session-<folder>`'s archive and rewrites that cone's own
   * `CLAUDE.md`, under that cone's workspace. Omitted means the primary cone,
   * which is what every pre-#2271 caller meant.
   */
  cone?: CuratorConeRef;
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

/** The cone a curator pass runs for — its storage folder, and its jid when known. */
export interface CuratorConeRef {
  /** Storage folder of the root unit: `cone` (primary) or `cone-<slug>`. */
  folder: string;
  /**
   * JID of that root, when the caller has it. Parents the curator scoop to the
   * cone it curates, so its sudo escalations reach that cone's approval router
   * and its model inheritance follows that cone rather than the oldest root.
   */
  jid?: string;
}

/**
 * Agent name of the curator for `folder`. Per cone (#2271): the fixed name is
 * what makes a second curator for the SAME memory file collide (see
 * `AGENT_NAME_IN_USE_PREFIX` below), and two cones curating two different
 * files must not block each other. The primary keeps the historical
 * `memory-curator`, so its `/sessions/agent-memory-curator-*.md` transcripts
 * keep their name.
 */
export function curatorAgentName(folder: string): string {
  return folder === PRIMARY_CONE_FOLDER ? 'memory-curator' : `memory-curator-${folder}`;
}

/**
 * `agent` name tokens are `[a-z][a-z0-9]*` joined by single dashes, which is
 * exactly the shape `coneFolderFor` mints — but a folder that came from
 * somewhere else (a restored record, a hand-edited profile) could still be
 * unusable as a name, and the spawn would then fail with `invalid name`
 * instead of curating. Fall back to the primary curator name in that case:
 * `writablePaths` still points at THIS cone's memory file, so the worst case
 * is the two passes serializing on one name, never a cross-cone write.
 */
function safeCuratorName(folder: string): string {
  const name = curatorAgentName(folder);
  return SPAWNABLE_NAME.test(name) ? name : curatorAgentName(PRIMARY_CONE_FOLDER);
}

/** Mirror of the agent bridge's `AGENT_NAME_PATTERN` (a legal down-edge away). */
const SPAWNABLE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * The curator's private scratch folder. The agent bridge derives it from the
 * agent name (`/scoops/agent-<name>`), so a per-cone name moves it too — and
 * the prompt in `MEMORY.md` sends drafts there by path.
 */
export function curatorScratchDir(folder: string): string {
  return `/scoops/agent-${safeCuratorName(folder)}`;
}

/** The primary cone's scratch folder — what a pre-#2271 `MEMORY.md` spells out. */
const PRIMARY_CURATOR_SCRATCH = curatorScratchDir(PRIMARY_CONE_FOLDER);

/**
 * Workspace (root + memory file) of the cone a pass curates. `workspaceFor`
 * already resolves the primary folder to `/workspace`, so there is no separate
 * primary branch to keep in sync here.
 */
function curatorWorkspaceFor(cone: CuratorConeRef | undefined): WorkUnitWorkspace {
  return workspaceFor({ parentJid: null, folder: cone?.folder ?? PRIMARY_CONE_FOLDER });
}

/**
 * Rebase a primary-relative path from `MEMORY.md` onto `workspace`.
 *
 * The frontmatter is written against the primary cone (`/workspace/CLAUDE.md`,
 * `/workspace/`) and is user-editable, so an extra cone's pass cannot simply
 * take it verbatim — it would hand the curator the PRIMARY cone's memory file
 * to rewrite. The same policy is instead applied to this cone's own files:
 * the primary memory file becomes this cone's, and anything under
 * `/workspace/` becomes the same path under this cone's root. The shared
 * skills library is deliberately NOT rebased — it is one library for every
 * cone ({@link SKILLS_LIBRARY_DIR}).
 */
function rebaseOntoCone(path: string, workspace: WorkUnitWorkspace): string {
  if (workspace.root === PRIMARY_WORKSPACE.root) return path;
  if (path === PRIMARY_WORKSPACE.memoryPath) return workspace.memoryPath;
  if (path === SKILLS_LIBRARY_DIR || path.startsWith(`${SKILLS_LIBRARY_DIR}/`)) return path;
  const primaryRoot = `${PRIMARY_WORKSPACE.root}/`;
  if (path === PRIMARY_WORKSPACE.root) return workspace.root;
  if (path.startsWith(primaryRoot)) return `${workspace.root}/${path.slice(primaryRoot.length)}`;
  return path;
}

/**
 * Rebase a configured path list, then re-add the shared skills library when
 * rebasing moved the only entry that covered it — a curator that can see
 * `/workspace/` on the primary can look skills up, and the same pass under an
 * extra cone must keep that ability (its `upskill` reads are read-only; the
 * single-file `writablePaths` still blocks installs).
 */
function rebaseVisiblePaths(paths: string[], workspace: WorkUnitWorkspace): string[] {
  const skills = `${SKILLS_LIBRARY_DIR}/`;
  const covers = (list: string[]): boolean =>
    list.some((entry) => skills.startsWith(entry.endsWith('/') ? entry : `${entry}/`));
  const rebased = paths.map((path) => rebaseOntoCone(path, workspace));
  if (covers(paths) && !covers(rebased)) rebased.push(skills);
  return rebased;
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
    if (opts.signal?.aborted) {
      return { ok: false, reason: 'aborted', legacyFallbackSafe: false };
    }
    const workspace = curatorWorkspaceFor(opts.cone);
    const scratchDir = curatorScratchDir(opts.cone?.folder ?? PRIMARY_CONE_FOLDER);
    const config = await loadMemoryConfig(opts.vfs, workspace);
    const prompt = rebaseScratchMentions(
      substitutePlaceholders(config.promptTemplate, {
        MEMORY_PATH: workspace.memoryPath,
        SESSION_ARCHIVE_PATH: opts.sessionArchivePath,
        SESSION_COUNT: String(opts.sessionCount),
        BUDGET_CHARS: String(computeBudget(opts.sessionCount)),
        SCRATCH_DIR: scratchDir,
        TODAY: opts.today ?? new Date().toISOString().slice(0, 10),
      }),
      scratchDir
    );
    const spawnOptions = buildSpawnOptions(
      config,
      prompt,
      opts.sessionArchivePath,
      workspace,
      opts.cone
    );
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
      // With the in-run wall-clock bound (#1972) firing at
      // `timeoutSeconds` and this wait carrying +grace, reaching here means
      // the in-run bound FAILED to stop the run (e.g. `armRunBounds` never
      // ran) — a real regression, not routine slowness. Log it loudly so
      // it doesn't read as "the curator sometimes times out".
      log.warn('Agentic memory wait timed out past the in-run bound + grace', {
        timeoutSeconds: config.timeoutSeconds,
        graceMs: BOUND_GRACE_MS,
      });
      return { ok: false, reason: 'timeout', legacyFallbackSafe: false };
    }
    if (outcome.type === 'aborted') {
      return { ok: false, reason: 'aborted', legacyFallbackSafe: false };
    }
    if (outcome.type === 'error') {
      return { ok: false, reason: errorText(outcome.error), legacyFallbackSafe: true };
    }
    if (outcome.result.exitCode !== 0) {
      // A name-in-use rejection means a PRIOR curator is still running and holds
      // the fixed `memory-curator` name (its window is now up to 20 min). Unlike
      // a curator that spawned and failed, no run has released — the legacy
      // append is NOT safe: the running namesake read the memory file before
      // this session's append and its whole-file rewrite would clobber it. Defer
      // to the pending/boot-catch-up path instead (memoryPending stays set).
      const collided = (outcome.result.finalText ?? '').startsWith(AGENT_NAME_IN_USE_PREFIX);
      return {
        ok: false,
        reason: outcome.result.finalText || `exit-${outcome.result.exitCode}`,
        legacyFallbackSafe: !collided,
      };
    }
    return { ok: true, report: outcome.result.finalText };
  } catch (error) {
    log.warn('Agentic memory pass failed', { error: errorText(error) });
    return { ok: false, reason: errorText(error), legacyFallbackSafe: false };
  }
}

async function loadMemoryConfig(
  vfs: Pick<LocalVfsClient, 'readFile'>,
  workspace: WorkUnitWorkspace = PRIMARY_WORKSPACE
): Promise<MemoryConfig> {
  try {
    const raw = await vfs.readFile(MEMORY_INSTRUCTIONS_PATH, { encoding: 'utf-8' });
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    return parseMemoryDocument(text, workspace);
  } catch (error) {
    log.warn('Could not load valid MEMORY.md; using built-in default', {
      error: errorText(error),
    });
    return parseMemoryDocument(DEFAULT_MEMORY_MD, workspace);
  }
}

function parseMemoryDocument(
  content: string,
  workspace: WorkUnitWorkspace = PRIMARY_WORKSPACE
): MemoryConfig {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const match = normalized.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match?.[2].trim()) throw new Error('MEMORY.md requires frontmatter and a prompt');
  const values = parseFrontmatter(match[1]);
  const writablePaths = readArray(values, 'writablePaths', defaultWritablePaths(workspace));
  if (writablePaths.length === 0) throw new Error('writablePaths must not be empty');
  validatePaths(writablePaths, 'writablePaths');
  const visiblePaths = readArray(values, 'visiblePaths', defaultVisiblePaths(workspace));
  validatePaths(visiblePaths, 'visiblePaths');
  const timeoutSeconds = readTimeout(values.timeoutSeconds);
  const model = readOptionalString(values.model, 'model');
  return {
    writablePaths: writablePaths.map((path) => rebaseOntoCone(path, workspace)),
    visiblePaths: rebaseVisiblePaths(visiblePaths, workspace),
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
  sessionArchivePath: string,
  workspace: WorkUnitWorkspace,
  cone: CuratorConeRef | undefined
): AgentSpawnOptions {
  const inheritedModel = config.model === 'parent' || config.model === 'cone';
  return {
    // Directory the curator starts in; `writablePaths` may be a bare file.
    cwd: workspace.root,
    writablePaths: config.writablePaths,
    visiblePaths: config.visiblePaths,
    allowedCommands: config.allowedCommands,
    prompt,
    thinkingLevel: config.thinkingLevel,
    // Durable transcript under a stable name — /sessions/agent-memory-curator-*.md
    // survives a new chat, so a curator run stays auditable for humans.
    persistSession: true,
    name: safeCuratorName(cone?.folder ?? PRIMARY_CONE_FOLDER),
    // Parent the run to the cone it curates so escalations and model
    // inheritance follow that cone, not the oldest root (#2271).
    ...(cone?.jid ? { parentJid: cone.jid } : {}),
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

/**
 * Compat shim for a `MEMORY.md` that predates `{{SCRATCH_DIR}}` and spells the
 * primary cone's scratch folder out (`/scoops/agent-memory-curator/`).
 * `/shared/MEMORY.md` is seeded only when absent, so an existing profile keeps
 * its literal text; under an extra cone that path is another agent's folder and
 * every draft write there would escalate. The prompt — not the FS policy —
 * is rewritten to name this run's own scratch.
 */
function rebaseScratchMentions(prompt: string, scratchDir: string): string {
  if (scratchDir === PRIMARY_CURATOR_SCRATCH) return prompt;
  return prompt.replaceAll(PRIMARY_CURATOR_SCRATCH, scratchDir);
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
