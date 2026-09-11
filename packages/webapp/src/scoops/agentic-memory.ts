import DEFAULT_MEMORY_MD from '../../../vfs-root/shared/MEMORY.md?raw';
import {
  type FrontmatterValue,
  parseFrontmatter,
  readArray,
  readBoundedTimeout,
  readOptionalString,
  splitInstructionDocument,
  validatePaths,
} from '../base/instruction-frontmatter.js';
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
const MEMORY_FRONTMATTER = {
  arrayKeys: new Set(['writablePaths', 'visiblePaths', 'allowedCommands']),
  scalarKeys: new Set(['model', 'timeoutSeconds', 'thinkingLevel']),
};

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

/**
 * VFS surface the pass needs: reads for `MEMORY.md` and the live memory
 * file, writes to seed the per-archive base snapshot + draft the curator
 * edits instead of the live file (see {@link curationDirPath}).
 */
export interface CuratorVfs {
  readFile: LocalVfsClient['readFile'];
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
}

/**
 * The instruction document a pass runs under. The curator's MEMORY.md is the
 * default; the dreaming pass (`scoops/memory-dreaming.ts`) substitutes its
 * own document and agent name while reusing every other piece of the
 * machinery — config parsing, cone rebasing, the staged base/draft snapshot,
 * the three-way merge, receipts, and the wall-clock bound.
 */
export interface MemoryPassInstructions {
  /** VFS path of the user-editable instruction document. */
  path: string;
  /** Bundled fallback when the VFS copy is missing or invalid. */
  fallback: string;
  /**
   * Agent name for `folder` — determines the scratch dir (`/scoops/agent-
   * <name>`) and the collision domain (two passes on the SAME memory file
   * must collide; different files must not).
   */
  nameFor(folder: string): string;
}

export interface RunAgenticMemoryPassOptions {
  spawn: AgentBridge['spawn'];
  vfs: CuratorVfs;
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
  /** Instruction document override; defaults to the curator's MEMORY.md. */
  instructions?: MemoryPassInstructions;
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

/** The curator's instruction set — what a pass without an override runs under. */
export const CURATOR_INSTRUCTIONS: MemoryPassInstructions = {
  path: MEMORY_INSTRUCTIONS_PATH,
  fallback: DEFAULT_MEMORY_MD,
  nameFor: curatorAgentName,
};

/**
 * `agent` name tokens are `[a-z][a-z0-9]*` joined by single dashes, which is
 * exactly the shape `coneFolderFor` mints — but a folder that came from
 * somewhere else (a restored record, a hand-edited profile) could still be
 * unusable as a name, and the spawn would then fail with `invalid name`
 * instead of curating. Fall back to the primary name in that case:
 * `writablePaths` still points at THIS cone's memory file, so the worst case
 * is the two passes serializing on one name, never a cross-cone write.
 */
function safeAgentName(instructions: MemoryPassInstructions, folder: string): string {
  const name = instructions.nameFor(folder);
  return SPAWNABLE_NAME.test(name) ? name : instructions.nameFor(PRIMARY_CONE_FOLDER);
}

/** Mirror of the agent bridge's `AGENT_NAME_PATTERN` (a legal down-edge away). */
const SPAWNABLE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * A pass's private scratch folder. The agent bridge derives it from the
 * agent name (`/scoops/agent-<name>`), so a per-cone name moves it too — and
 * the prompt sends drafts there by path.
 */
function scratchDirFor(instructions: MemoryPassInstructions, folder: string): string {
  return `/scoops/agent-${safeAgentName(instructions, folder)}`;
}

/** The curator's scratch folder for `folder` — kept for callers and tests. */
export function curatorScratchDir(folder: string): string {
  return scratchDirFor(CURATOR_INSTRUCTIONS, folder);
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
    const instructions = opts.instructions ?? CURATOR_INSTRUCTIONS;
    const workspace = curatorWorkspaceFor(opts.cone);
    const scratchDir = scratchDirFor(instructions, opts.cone?.folder ?? PRIMARY_CONE_FOLDER);
    const config = await loadMemoryConfig(opts.vfs, workspace, instructions);
    const draftPath = curationDraftPath(opts.sessionArchivePath);
    try {
      await seedCurationSnapshot(opts.vfs, workspace.memoryPath, opts.sessionArchivePath);
    } catch (error) {
      // Nothing spawned yet, so the legacy single-call append cannot race a
      // curator — falling back is safe.
      return { ok: false, reason: `snapshot: ${errorText(error)}`, legacyFallbackSafe: true };
    }
    const prompt = rebaseScratchMentions(
      substitutePlaceholders(config.promptTemplate, {
        MEMORY_PATH: draftPath,
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
      opts.cone,
      instructions
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
  workspace: WorkUnitWorkspace = PRIMARY_WORKSPACE,
  instructions: MemoryPassInstructions = CURATOR_INSTRUCTIONS
): Promise<MemoryConfig> {
  try {
    const raw = await vfs.readFile(instructions.path, { encoding: 'utf-8' });
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    return parseMemoryDocument(text, workspace, documentLabel(instructions));
  } catch (error) {
    log.warn(`Could not load valid ${instructions.path}; using built-in default`, {
      error: errorText(error),
    });
    return parseMemoryDocument(instructions.fallback, workspace, documentLabel(instructions));
  }
}

/** Basename of the instruction document, for parse-error messages. */
function documentLabel(instructions: MemoryPassInstructions): string {
  return instructions.path.slice(instructions.path.lastIndexOf('/') + 1);
}

function parseMemoryDocument(
  content: string,
  workspace: WorkUnitWorkspace = PRIMARY_WORKSPACE,
  label = 'MEMORY.md'
): MemoryConfig {
  const document = splitInstructionDocument(content, label);
  const values = parseFrontmatter(document.frontmatter, MEMORY_FRONTMATTER);
  const writablePaths = readArray(values, 'writablePaths', defaultWritablePaths(workspace));
  if (writablePaths.length === 0) throw new Error('writablePaths must not be empty');
  validatePaths(writablePaths, 'writablePaths');
  const visiblePaths = readArray(values, 'visiblePaths', defaultVisiblePaths(workspace));
  validatePaths(visiblePaths, 'visiblePaths');
  const timeoutSeconds = readBoundedTimeout(
    values.timeoutSeconds,
    DEFAULT_MEMORY_TIMEOUT_SECONDS,
    MAX_MEMORY_TIMEOUT_SECONDS
  );
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
    promptTemplate: document.body,
  };
}

function readThinkingLevel(value: FrontmatterValue | undefined): ThinkingLevel {
  if (value === undefined) return DEFAULT_MEMORY_THINKING_LEVEL;
  if (typeof value !== 'string' || !isThinkingLevel(value)) {
    throw new Error(`thinkingLevel must be one of ${THINKING_LEVELS.join(', ')}`);
  }
  return value;
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

/**
 * Per-archive curation state folder. The curator never rewrites the live
 * memory file directly any more: the pass snapshots the live file here as
 * `base.md`, hands the curator an identical `draft.md` to rewrite, and the
 * agent bridge three-way-merges base→draft back onto the live file when the
 * run exits 0. Keyed by the archive basename — the same attribution
 * guarantee as {@link curatorReceiptPath} — so parallel curators for
 * different cones (#1666/#2271) never share state, and a run killed
 * mid-write corrupts only its own draft, never the live memory.
 */
export function curationDirPath(sessionArchivePath: string): string {
  const base = sessionArchivePath.slice(sessionArchivePath.lastIndexOf('/') + 1);
  return `/sessions/.curation/${base}`;
}

/** Snapshot of the live memory file taken when the pass spawned. */
export function curationBasePath(sessionArchivePath: string): string {
  return `${curationDirPath(sessionArchivePath)}/base.md`;
}

/** The file the curator actually edits; seeded from the live memory file. */
export function curationDraftPath(sessionArchivePath: string): string {
  return `${curationDirPath(sessionArchivePath)}/draft.md`;
}

/**
 * Durable per-archive run outcome the agent bridge writes (worker realm)
 * on BOTH exit paths — success and failure. Unlike the success-only
 * receipt this answers "which sessions caused failed curation" even when
 * the page died before the caller could record the failure.
 */
export function curationStatusPath(sessionArchivePath: string): string {
  return `${curationDirPath(sessionArchivePath)}/status.json`;
}

/**
 * Snapshot the live memory file into the per-archive curation folder: the
 * `base.md` the completion merge diffs against, and the `draft.md` the
 * curator rewrites in place of the live file. A missing live file seeds
 * both as empty — a first-ever pass merges onto whatever exists then.
 */
async function seedCurationSnapshot(
  vfs: CuratorVfs,
  memoryPath: string,
  sessionArchivePath: string
): Promise<void> {
  let live = '';
  try {
    const raw = await vfs.readFile(memoryPath, { encoding: 'utf-8' });
    live = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  } catch {
    // No live memory yet — snapshot the empty state.
  }
  await vfs.mkdir(curationDirPath(sessionArchivePath), { recursive: true });
  await vfs.writeFile(curationBasePath(sessionArchivePath), live);
  await vfs.writeFile(curationDraftPath(sessionArchivePath), live);
}

/**
 * Point the configured write policy at the draft instead of the live
 * memory file. An entry naming the memory file itself is substituted; any
 * other entry (a knowledge base, a whole-workspace grant) is kept, and the
 * draft is appended when no entry named the memory file — the prompt's
 * `{{MEMORY_PATH}}` writes must always land somewhere granted.
 */
function redirectWritesToDraft(paths: string[], memoryPath: string, draftPath: string): string[] {
  const redirected = paths.map((path) => (path === memoryPath ? draftPath : path));
  return redirected.includes(draftPath) ? redirected : [...redirected, draftPath];
}

function buildSpawnOptions(
  config: MemoryConfig,
  prompt: string,
  sessionArchivePath: string,
  workspace: WorkUnitWorkspace,
  cone: CuratorConeRef | undefined,
  instructions: MemoryPassInstructions
): AgentSpawnOptions {
  const inheritedModel = config.model === 'parent' || config.model === 'cone';
  const basePath = curationBasePath(sessionArchivePath);
  const draftPath = curationDraftPath(sessionArchivePath);
  return {
    // Directory the curator starts in; `writablePaths` may be a bare file.
    cwd: workspace.root,
    writablePaths: redirectWritesToDraft(config.writablePaths, workspace.memoryPath, draftPath),
    // A Write grant does not imply Read; the curator must re-read the draft
    // it measures with `wc -c`, so the curation folder is made visible even
    // under a custom config that dropped `/sessions/`.
    visiblePaths: [...config.visiblePaths, `${curationDirPath(sessionArchivePath)}/`],
    allowedCommands: config.allowedCommands,
    prompt,
    thinkingLevel: config.thinkingLevel,
    // Durable transcript under a stable name — /sessions/agent-memory-curator-*.md
    // survives a new chat, so a curator run stays auditable for humans.
    persistSession: true,
    name: safeAgentName(instructions, cone?.folder ?? PRIMARY_CONE_FOLDER),
    // Parent the run to the cone it curates so escalations and model
    // inheritance follow that cone, not the oldest root (#2271).
    ...(cone?.jid ? { parentJid: cone.jid } : {}),
    // The pass is detached, so the caller's return value goes nowhere. Without
    // this the curator's report — including any skill it found — is discarded
    // and the cone never learns the pass happened at all.
    notifyOnComplete: true,
    successReceiptPath: curatorReceiptPath(sessionArchivePath),
    // On exit 0 the bridge folds the curator's base→draft rewrite onto the
    // live memory file with a three-way merge (worker realm, before the
    // receipt) — concurrent live edits during the up-to-20-minute run merge
    // instead of being clobbered by a whole-file rewrite, and a run killed
    // mid-write never leaves a half-written live file.
    mergeOnSuccess: {
      targetPath: workspace.memoryPath,
      basePath,
      draftPath,
    },
    // Durable success/failure record for THIS archive, written on both exit
    // paths — the ledger of which sessions completed vs failed curation.
    outcomeReceiptPath: curationStatusPath(sessionArchivePath),
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
 *
 * Idempotent with `substitutePlaceholders`: per-cone scratch dirs start with
 * the primary spelling (`…/agent-memory-curator-cone-…`), so a naive
 * `replaceAll` would re-prefix already-expanded `{{SCRATCH_DIR}}` mentions.
 * Protect the fully-substituted path first, then rewrite only the legacy
 * primary spelling.
 */
function rebaseScratchMentions(prompt: string, scratchDir: string): string {
  if (scratchDir === PRIMARY_CURATOR_SCRATCH) return prompt;
  const sentinel = '\0SCRATCH\0';
  return prompt
    .replaceAll(scratchDir, sentinel)
    .replaceAll(PRIMARY_CURATOR_SCRATCH, scratchDir)
    .replaceAll(sentinel, scratchDir);
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
