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
  'sed',
  'sort',
  'stat',
  'tail',
  'touch',
  'tr',
  'uniq',

  'upskill',
  'wc',
  'xxd',
];
const MEMORY_FRONTMATTER = {
  arrayKeys: new Set(['writablePaths', 'visiblePaths', 'allowedCommands']),
  scalarKeys: new Set(['model', 'timeoutSeconds', 'thinkingLevel']),
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
  promptTemplate: string;
}

export interface CuratorVfs {
  readFile: LocalVfsClient['readFile'];
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
}

export interface MemoryPassInstructions {
  path: string;

  fallback: string;

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
  path: MEMORY_INSTRUCTIONS_PATH,
  fallback: DEFAULT_MEMORY_MD,
  nameFor: curatorAgentName,
  rivalsFor: (folder) => [dreamerAgentName(folder)],
};

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
    const config = await loadMemoryConfig(opts.vfs, workspace, instructions);
    const draftPath = curationDraftPath(opts.sessionArchivePath);
    try {
      await seedCurationSnapshot(opts.vfs, workspace.memoryPath, opts.sessionArchivePath);
    } catch (error) {
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

    const outcome = await waitForSpawn(
      spawnPromise,
      config.timeoutSeconds * 1000 + BOUND_GRACE_MS,
      opts.signal
    );
    if (outcome.type === 'timeout') {
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

    maxWallClockMs: config.timeoutSeconds * 1000,
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
