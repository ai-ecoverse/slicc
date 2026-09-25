import DEFAULT_MEMORY_MD from '../../../vfs-root/etc/MEMORY.md?raw';
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
import {
  LEGACY_MEMORY_INSTRUCTION_PATHS,
  MEMORY_INSTRUCTIONS_PATH,
} from '../base/memory-budget.js';
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

export { LEGACY_MEMORY_INSTRUCTION_PATHS, MEMORY_INSTRUCTIONS_PATH };
export const DEFAULT_MEMORY_TIMEOUT_SECONDS = 600;
export const MAX_MEMORY_TIMEOUT_SECONDS = 1200;

export const DEFAULT_DREAM_TIMEOUT_SECONDS = 3600;
export const MAX_DREAM_TIMEOUT_SECONDS = 7200;

const defaultWritablePaths = (workspace: WorkUnitWorkspace): string[] => [workspace.memoryPath];

const defaultVisiblePaths = (workspace: WorkUnitWorkspace): string[] => [
  '/sessions/',
  '/shared/',
  ...defaultChildVisibleRoots(workspace),
];

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

  'jq',
  'ls',
  'mkdir',

  'mount',
  'mv',
  'nl',

  'od',
  'printf',
  'readlink',

  'rg',
  'sed',
  'sort',
  'stat',
  'tail',
  'touch',
  'tr',
  'uniq',

  'uname',

  'upskill',
  'wc',
  'xxd',
];
const MEMORY_FRONTMATTER = {
  arrayKeys: new Set(['writablePaths', 'visiblePaths', 'allowedCommands']),
  scalarKeys: new Set(['model', 'timeoutSeconds', 'dreamTimeoutSeconds', 'thinkingLevel']),
};

const DEFAULT_MEMORY_THINKING_LEVEL: ThinkingLevel = 'medium';

const BOUND_GRACE_MS = 30_000;

interface MemoryConfig {
  writablePaths: string[];
  visiblePaths: string[];
  allowedCommands: string[];
  model?: string;
  thinkingLevel: ThinkingLevel;

  timeoutSeconds: number;

  dreamTimeoutSeconds: number;
  promptTemplate: string;
}

export interface CuratorVfs {
  readFile: LocalVfsClient['readFile'];
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
}

export interface MemoryPassInstructions {
  kind: 'curate' | 'dream';

  nameFor(folder: string): string;

  rivalsFor?(folder: string): string[];
}

export interface RunAgenticMemoryPassOptions {
  spawn: AgentBridge['spawn'];
  vfs: CuratorVfs;
  sessionArchivePath: string;
  sessionCount: number;

  cone?: CuratorConeRef;

  today?: string;

  instructions?: MemoryPassInstructions;
  signal?: AbortSignal;
}

export type AgenticMemoryPassResult =
  | { ok: true; report: string }
  | { ok: false; reason: string; legacyFallbackSafe: boolean };

export interface CuratorConeRef {
  folder: string;

  jid?: string;
}

export function curatorAgentName(folder: string): string {
  return folder === PRIMARY_CONE_FOLDER ? 'memory-curator' : `memory-curator-${folder}`;
}

export const CURATOR_INSTRUCTIONS: MemoryPassInstructions = {
  kind: 'curate',
  nameFor: curatorAgentName,
  rivalsFor: (folder) => [dreamerAgentName(folder)],
};

const TASK_PLACEHOLDER = '{{TASK}}';

const NO_ARCHIVE = '(no session archive this pass)';

function passTask(
  instructions: MemoryPassInstructions,
  sessionArchivePath: string,
  timeoutMinutes: number
): string {
  if (instructions.kind === 'dream') {
    return (
      '**Consolidation pass** (the nightly dreaming): there is NO new session to mine — skip ' +
      '"Mining the session archive" entirely. Your whole job is to make the existing memory ' +
      'better: consolidated, current, and inside its budget. If the file is missing or empty, ' +
      'reply with one line saying so and stop; never invent memories. The run is hard-stopped ' +
      `after ${timeoutMinutes} minutes; a run stopped at that bound lands whatever the memory ` +
      'file holds at that moment (every memory_write leaves a whole, budget-checked file), so ' +
      'consolidate section by section, writing as you go, and finish cleanly when you can.'
    );
  }
  return (
    `**Curation pass**: mine the archived session at ${sessionArchivePath} for what is worth ` +
    'carrying into future sessions, fold it into the memory, and consolidate the whole file in ' +
    'the same pass. Work fast: a pass should finish in well under 10 minutes and is hard-stopped ' +
    `after ${timeoutMinutes} minutes — mine the three signals, write, and stop, rather than ` +
    'exploring the archive exhaustively.'
  );
}

export async function seedMemoryInstructions(fs: {
  stat(path: string): Promise<unknown>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
}): Promise<void> {
  try {
    await fs.stat(MEMORY_INSTRUCTIONS_PATH);
    return;
  } catch {}
  try {
    await fs.mkdir('/etc', { recursive: true });
    await fs.writeFile(MEMORY_INSTRUCTIONS_PATH, DEFAULT_MEMORY_MD);
    log.info(`Seeded default ${MEMORY_INSTRUCTIONS_PATH}`);
  } catch (error) {
    log.warn(`Failed to seed ${MEMORY_INSTRUCTIONS_PATH}`, { error: errorText(error) });
  }
}

export function dreamerAgentName(folder: string): string {
  return folder === PRIMARY_CONE_FOLDER ? 'memory-dreamer' : `memory-dreamer-${folder}`;
}

function safeAgentName(instructions: MemoryPassInstructions, folder: string): string {
  const name = instructions.nameFor(folder);
  return SPAWNABLE_NAME.test(name) ? name : instructions.nameFor(PRIMARY_CONE_FOLDER);
}

function safeRivalNames(instructions: MemoryPassInstructions, folder: string): string[] {
  const safeFolder = SPAWNABLE_NAME.test(instructions.nameFor(folder))
    ? folder
    : PRIMARY_CONE_FOLDER;
  return instructions.rivalsFor?.(safeFolder) ?? [];
}

const SPAWNABLE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function scratchDirFor(instructions: MemoryPassInstructions, folder: string): string {
  return `/scoops/agent-${safeAgentName(instructions, folder)}`;
}

export function curatorScratchDir(folder: string): string {
  return scratchDirFor(CURATOR_INSTRUCTIONS, folder);
}

const PRIMARY_CURATOR_SCRATCH = curatorScratchDir(PRIMARY_CONE_FOLDER);

function curatorWorkspaceFor(cone: CuratorConeRef | undefined): WorkUnitWorkspace {
  return workspaceFor({ parentJid: null, folder: cone?.folder ?? PRIMARY_CONE_FOLDER });
}

function rebaseOntoCone(path: string, workspace: WorkUnitWorkspace): string {
  if (workspace.root === PRIMARY_WORKSPACE.root) return path;
  if (path === PRIMARY_WORKSPACE.memoryPath) return workspace.memoryPath;
  if (path === SKILLS_LIBRARY_DIR || path.startsWith(`${SKILLS_LIBRARY_DIR}/`)) return path;
  const primaryRoot = `${PRIMARY_WORKSPACE.root}/`;
  if (path === PRIMARY_WORKSPACE.root) return workspace.root;
  if (path.startsWith(primaryRoot)) return `${workspace.root}/${path.slice(primaryRoot.length)}`;
  return path;
}

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
    const config = await loadMemoryConfig(opts.vfs, workspace);
    const timeoutSeconds =
      instructions.kind === 'dream' ? config.dreamTimeoutSeconds : config.timeoutSeconds;
    const draftPath = curationDraftPath(opts.sessionArchivePath);
    try {
      await seedCurationSnapshot(opts.vfs, workspace.memoryPath, opts.sessionArchivePath);
    } catch (error) {
      return { ok: false, reason: `snapshot: ${errorText(error)}`, legacyFallbackSafe: true };
    }

    const archiveForPrompt = instructions.kind === 'dream' ? NO_ARCHIVE : opts.sessionArchivePath;
    const timeoutMinutes = Math.max(1, Math.round(timeoutSeconds / 60));
    const task = passTask(instructions, archiveForPrompt, timeoutMinutes);

    const template = config.promptTemplate.includes(TASK_PLACEHOLDER)
      ? config.promptTemplate
      : `${config.promptTemplate.trimEnd()}\n\n${TASK_PLACEHOLDER}`;
    const prompt = rebaseScratchMentions(
      substitutePlaceholders(template, {
        MEMORY_PATH: draftPath,
        SESSION_ARCHIVE_PATH: archiveForPrompt,
        SESSION_COUNT: String(opts.sessionCount),
        BUDGET_CHARS: String(computeBudget(opts.sessionCount)),
        SCRATCH_DIR: scratchDir,

        VISIBLE_PATHS: config.visiblePaths.join(', '),
        TODAY: opts.today ?? new Date().toISOString().slice(0, 10),
        TIMEOUT_MINUTES: String(timeoutMinutes),
        TASK: task,
      }),
      scratchDir
    );
    const spawnOptions = buildSpawnOptions(
      config,
      timeoutSeconds,
      prompt,
      opts.sessionArchivePath,
      workspace,
      opts.cone,
      instructions
    );
    if (opts.signal) spawnOptions.signal = opts.signal;
    const spawnPromise = Promise.resolve().then(() => opts.spawn(spawnOptions));

    const outcome = await waitForSpawn(
      spawnPromise,
      timeoutSeconds * 1000 + BOUND_GRACE_MS,
      opts.signal
    );
    if (outcome.type === 'timeout') {
      log.warn('Agentic memory wait timed out past the in-run bound + grace', {
        timeoutSeconds,
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
    log.warn(`Could not load valid ${MEMORY_INSTRUCTIONS_PATH}; using built-in default`, {
      error: errorText(error),
    });
    return parseMemoryDocument(DEFAULT_MEMORY_MD, workspace);
  }
}

function parseMemoryDocument(
  content: string,
  workspace: WorkUnitWorkspace = PRIMARY_WORKSPACE
): MemoryConfig {
  const document = splitInstructionDocument(content, 'MEMORY.md');
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
  const dreamTimeoutSeconds = readBoundedTimeout(
    values.dreamTimeoutSeconds,
    DEFAULT_DREAM_TIMEOUT_SECONDS,
    MAX_DREAM_TIMEOUT_SECONDS,
    'dreamTimeoutSeconds'
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
    dreamTimeoutSeconds,
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

export function curatorReceiptPath(sessionArchivePath: string): string {
  const base = sessionArchivePath.slice(sessionArchivePath.lastIndexOf('/') + 1);
  return `/sessions/.curated/${base}`;
}

export function curationDirPath(sessionArchivePath: string): string {
  const base = sessionArchivePath.slice(sessionArchivePath.lastIndexOf('/') + 1);
  return `/sessions/.curation/${base}`;
}

export function curationBasePath(sessionArchivePath: string): string {
  return `${curationDirPath(sessionArchivePath)}/base.md`;
}

export function curationDraftPath(sessionArchivePath: string): string {
  return `${curationDirPath(sessionArchivePath)}/draft.md`;
}

export function curationStatusPath(sessionArchivePath: string): string {
  return `${curationDirPath(sessionArchivePath)}/status.json`;
}

async function seedCurationSnapshot(
  vfs: CuratorVfs,
  memoryPath: string,
  sessionArchivePath: string
): Promise<void> {
  let live = '';
  try {
    const raw = await vfs.readFile(memoryPath, { encoding: 'utf-8' });
    live = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  } catch {}
  await vfs.mkdir(curationDirPath(sessionArchivePath), { recursive: true });
  await vfs.writeFile(curationBasePath(sessionArchivePath), live);
  await vfs.writeFile(curationDraftPath(sessionArchivePath), live);
}

function redirectWritesToDraft(paths: string[], memoryPath: string, draftPath: string): string[] {
  const redirected = paths.map((path) => (path === memoryPath ? draftPath : path));
  return redirected.includes(draftPath) ? redirected : [...redirected, draftPath];
}

function buildSpawnOptions(
  config: MemoryConfig,
  timeoutSeconds: number,
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
    cwd: workspace.root,
    writablePaths: redirectWritesToDraft(config.writablePaths, workspace.memoryPath, draftPath),

    visiblePaths: [...config.visiblePaths, `${curationDirPath(sessionArchivePath)}/`],
    allowedCommands: config.allowedCommands,
    prompt,
    thinkingLevel: config.thinkingLevel,

    persistSession: true,
    name: safeAgentName(instructions, cone?.folder ?? PRIMARY_CONE_FOLDER),

    exclusiveWith: safeRivalNames(instructions, cone?.folder ?? PRIMARY_CONE_FOLDER),

    ...(cone?.jid ? { parentJid: cone.jid } : {}),

    notifyOnComplete: true,
    successReceiptPath: curatorReceiptPath(sessionArchivePath),

    mergeOnSuccess: {
      targetPath: workspace.memoryPath,
      basePath,
      draftPath,
    },

    outcomeReceiptPath: curationStatusPath(sessionArchivePath),

    maxWallClockMs: timeoutSeconds * 1000,
    ...(!inheritedModel && config.model ? { modelId: config.model } : {}),
  };
}

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
