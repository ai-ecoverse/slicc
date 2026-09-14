import { createLogger } from '../base/logger.js';
import type { SessionStore } from '../core/session.js';
import type { VirtualFS } from '../fs/index.js';
import { normalizePath } from '../fs/path-utils.js';

import { threeWayMerge } from '../git/merge-file-core.js';
import {
  resolveModelSelectionForScoop,
  type ScoopModelResolution,
} from '../providers/account-store.js';

import type { JsonSchemaObject } from '../tools/types.js';
import { defaultChildVisibleRoots, PRIMARY_WORKSPACE } from '../work-unit/descriptor.js';
import { rootsOf } from '../work-unit/policy.js';
import { modelIdFor, modelProviderFor, thinkingFor } from '../work-unit/record.js';
import type { WorkspaceIsolationMode } from '../work-unit/types.js';
import {
  DEFAULT_CHILD_WORKSPACE_MODE,
  type ImplementedWorkspaceMode,
  parseWorkspaceMode,
} from '../work-unit/workspace-mode.js';
import { AGENT_ADJECTIVES, AGENT_FLAVORS } from './agent-names.js';
import { serializeAgentSessionArchive } from './agent-session-archive.js';
import type { Orchestrator } from './orchestrator.js';
import {
  CURRENT_SCOOP_CONFIG_VERSION,
  isThinkingLevel,
  type RegisteredScoop,
  THINKING_LEVELS,
  type ThinkingLevel,
} from './types.js';

const log = createLogger('agent-bridge');

export interface AgentMergeOnSuccess {
  targetPath: string;

  basePath: string;

  draftPath: string;
}

export interface AgentSpawnOptions {
  cwd: string;

  writablePaths?: string[];

  allowedCommands: string[];

  prompt: string;

  modelId?: string;

  modelProviderId?: string;

  parentJid?: string;

  visiblePaths?: string[];

  workspaceMode?: WorkspaceIsolationMode;

  invokingCwd?: string;

  thinkingLevel?: ThinkingLevel;

  structuredOutputSchema?: JsonSchemaObject;

  notifyOnComplete?: boolean;

  successReceiptPath?: string;

  mergeOnSuccess?: AgentMergeOnSuccess;

  outcomeReceiptPath?: string;

  persistSession?: boolean;

  name?: string;

  exclusiveWith?: string[];

  maxTurns?: number;

  maxWallClockMs?: number;

  backgroundAfterSeconds?: number;

  signal?: AbortSignal;
}

export interface AgentSpawnResult {
  finalText: string;

  exitCode: number;
}

export interface AgentBridge {
  spawn(options: AgentSpawnOptions): Promise<AgentSpawnResult>;
}

export interface AgentBridgeDeps {
  generateName?: () => string;

  generateUid?: () => string;

  resolveModel?: (modelId: string) => ScoopModelResolution;
}

export const AGENT_BRIDGE_GLOBAL_KEY = '__slicc_agent';

type AgentBridgeGlobal = typeof globalThis & {
  [AGENT_BRIDGE_GLOBAL_KEY]?: AgentBridge;
};

interface BridgeContext {
  orchestrator: Orchestrator;
  sharedFs: VirtualFS;
  sessionStore: SessionStore | null | undefined;
  generateName: () => string;
  generateUid: () => string;
  resolveModel: (modelId: string) => ScoopModelResolution;
}

function pickFreshNameToken(ctx: BridgeContext): string {
  const MAX_TRIES = 8;
  for (let i = 0; i < MAX_TRIES; i++) {
    const candidate = ctx.generateName();
    const candidateJid = `agent_${tokenToJid(candidate)}`;
    if (!ctx.orchestrator.getScoops().some((s) => s.jid === candidateJid)) {
      return candidate;
    }
  }
  return ctx.generateUid();
}

function resolveParentModelSelection(
  orchestrator: Orchestrator,
  parentJid: string | undefined
): { modelId: string; providerId?: string } | null {
  if (parentJid === undefined) return null;
  const parent = orchestrator.getScoops().find((s) => s.jid === parentJid);
  if (!parent) return null;
  const modelId = modelIdFor(parent);
  if (!modelId || modelId.length === 0) return null;
  const providerId = modelProviderFor(parent);
  return providerId ? { modelId, providerId } : { modelId };
}

function resolveOwnerVisibleRoots(orchestrator: Orchestrator, parentJid: string | null): string[] {
  const units = orchestrator.getWorkUnits();
  const owner = (parentJid === null ? null : units.rootOf(parentJid)) ?? units.resolveDefaultRoot();
  return defaultChildVisibleRoots(owner?.descriptor.workspace ?? PRIMARY_WORKSPACE);
}

function resolveParentThinkingLevel(
  orchestrator: Orchestrator,
  parentJid: string | undefined
): ThinkingLevel | null {
  if (parentJid === undefined) return null;
  const parent = orchestrator.getScoops().find((s) => s.jid === parentJid);
  if (!parent) return null;
  const level = thinkingFor(parent).level;
  return level && isThinkingLevel(level) ? level : null;
}

function validateSpawnOptions(
  options: AgentSpawnOptions,
  resolveModel: (modelId: string) => ScoopModelResolution
):
  | { error: AgentSpawnResult }
  | { resolvedModelId: string | undefined; resolvedProviderId: string | undefined } {
  const requestedModelId = options.modelId;
  let resolvedModelId: string | undefined;
  let resolvedProviderId: string | undefined;
  if (requestedModelId !== undefined) {
    const qualified =
      options.modelProviderId !== undefined && requestedModelId !== ''
        ? `${options.modelProviderId}:${requestedModelId}`
        : requestedModelId;
    const resolved: ScoopModelResolution =
      qualified === ''
        ? { ok: false, error: `unknown model: ${requestedModelId}` }
        : resolveModel(qualified);
    if (!resolved.ok) {
      return {
        error: {
          finalText: `agent: ${resolved.error}`,
          exitCode: 1,
        },
      };
    }
    resolvedModelId = resolved.selection.modelId;
    resolvedProviderId = resolved.selection.providerId;
  }

  const requestedLevel = options.thinkingLevel;
  if (requestedLevel !== undefined && !isThinkingLevel(requestedLevel)) {
    return {
      error: {
        finalText: `agent: invalid thinking level: ${String(requestedLevel)} (one of: ${THINKING_LEVELS.join(', ')})`,
        exitCode: 1,
      },
    };
  }

  const parsedMode = parseWorkspaceMode(options.workspaceMode);
  if (!parsedMode.ok) {
    return {
      error: {
        finalText: `agent: ${parsedMode.error}`,
        exitCode: 1,
      },
    };
  }

  const backgroundAfter = options.backgroundAfterSeconds;
  if (
    backgroundAfter !== undefined &&
    (typeof backgroundAfter !== 'number' ||
      !Number.isFinite(backgroundAfter) ||
      backgroundAfter < 0)
  ) {
    return {
      error: {
        finalText: `agent: invalid backgroundAfterSeconds: ${String(backgroundAfter)} (seconds >= 0)`,
        exitCode: 1,
      },
    };
  }

  const pathError = validateBookkeepingPaths(options);
  if (pathError) return pathError;

  const requestedName = options.name;
  if (requestedName !== undefined && !isValidAgentName(requestedName)) {
    return {
      error: {
        finalText: `agent: invalid name: ${requestedName} (lowercase tokens joined by single dashes)`,
        exitCode: 1,
      },
    };
  }

  for (const [name, value] of [
    ['maxTurns', options.maxTurns],
    ['maxWallClockMs', options.maxWallClockMs],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      return {
        error: {
          finalText: `agent: ${name} must be a positive integer: ${String(value)}`,
          exitCode: 1,
        },
      };
    }
  }

  return { resolvedModelId, resolvedProviderId };
}

function validateBookkeepingPaths(
  options: AgentSpawnOptions
): { error: { finalText: string; exitCode: number } } | null {
  const merge = options.mergeOnSuccess;
  const entries: Array<[string, string | undefined]> = [
    ['successReceiptPath', options.successReceiptPath],
    ['outcomeReceiptPath', options.outcomeReceiptPath],
    ['mergeOnSuccess.targetPath', merge?.targetPath],
    ['mergeOnSuccess.basePath', merge?.basePath],
    ['mergeOnSuccess.draftPath', merge?.draftPath],
  ];

  const requiredWhenMerge = merge === undefined ? undefined : '';
  for (const [field, value] of entries) {
    const effective = value ?? (field.startsWith('mergeOnSuccess') ? requiredWhenMerge : undefined);
    if (effective !== undefined && !effective.startsWith('/')) {
      return {
        error: {
          finalText: `agent: ${field} must be absolute: ${String(value)}`,
          exitCode: 1,
        },
      };
    }
  }
  return null;
}

interface MergeOutcome {
  applied: boolean;

  conflicts: number;

  error?: string;
}

async function applyMergeOnSuccess(
  sharedFs: VirtualFS,
  spec: AgentMergeOnSuccess
): Promise<MergeOutcome> {
  const read = async (path: string): Promise<string> => {
    try {
      const raw = await sharedFs.readFile(path, { encoding: 'utf-8' });
      return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    } catch (err) {
      if (isFsErrorCode(err, 'ENOENT')) return '';
      throw err;
    }
  };
  const cleanup = async (): Promise<void> => {
    for (const path of [spec.basePath, spec.draftPath]) {
      try {
        await sharedFs.rm(path);
      } catch {}
    }
  };
  const readOrNull = async (path: string): Promise<string | null> => {
    try {
      const raw = await sharedFs.readFile(path, { encoding: 'utf-8' });
      return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    } catch (err) {
      if (isFsErrorCode(err, 'ENOENT')) return null;
      throw err;
    }
  };
  try {
    const draft = await readOrNull(spec.draftPath);
    if (draft === null) {
      await cleanup();
      return { applied: false, conflicts: 0 };
    }

    const current = await read(spec.targetPath);
    if (draft === current) {
      await cleanup();
      return { applied: false, conflicts: 0 };
    }

    const base = await readOrNull(spec.basePath);
    if (base === null) {
      return { applied: false, conflicts: 0, error: 'base snapshot missing; target left as-is' };
    }
    if (draft === base) {
      await cleanup();
      return { applied: false, conflicts: 0 };
    }
    if (current === base) {
      await sharedFs.writeFile(spec.targetPath, draft);
      await cleanup();
      return { applied: true, conflicts: 0 };
    }

    const merged = threeWayMerge(current, base, draft, { favor: 'theirs' });
    await sharedFs.writeFile(spec.targetPath, merged.content);
    await cleanup();
    return { applied: true, conflicts: merged.conflicts };
  } catch (err) {
    const error = errText(err);
    log.warn('mergeOnSuccess failed; target left as-is, staging kept', {
      target: spec.targetPath,
      error,
    });
    return { applied: false, conflicts: 0, error };
  }
}

async function writeOutcomeReceipt(
  sharedFs: VirtualFS,
  path: string,
  result: AgentSpawnResult,
  merge?: MergeOutcome
): Promise<void> {
  try {
    const dir = path.slice(0, path.lastIndexOf('/'));
    if (dir) await sharedFs.mkdir(dir, { recursive: true });
    await sharedFs.writeFile(
      path,
      JSON.stringify(
        {
          status: result.exitCode === 0 ? 'ok' : 'failed',
          exitCode: result.exitCode,
          finishedAt: new Date().toISOString(),

          ...(result.exitCode === 0 ? {} : { reason: result.finalText.slice(0, 500) }),
          ...(merge ? { merge } : {}),
        },
        null,
        2
      )
    );
  } catch (err) {
    log.warn('outcome receipt write failed', { path, error: errText(err) });
  }
}

async function writeSuccessReceipt(sharedFs: VirtualFS, path: string): Promise<void> {
  try {
    const dir = path.slice(0, path.lastIndexOf('/'));
    if (dir) await sharedFs.mkdir(dir, { recursive: true });
    await sharedFs.writeFile(path, new Date().toISOString());
  } catch (err) {
    log.warn('success receipt write failed', { path, error: errText(err) });
  }
}

const AGENT_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
function isValidAgentName(name: string): boolean {
  return AGENT_NAME_PATTERN.test(name);
}

export const AGENT_NAME_IN_USE_PREFIX = 'agent: name already in use';

async function writeAgentSessionArchive(
  ctx: BridgeContext,
  options: AgentSpawnOptions,
  jid: string,
  nameToken: string,
  outcome: AgentSpawnResult
): Promise<void> {
  if (options.persistSession === false) return;
  const dir = options.persistSession === true ? '/sessions' : '/tmp';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = `${dir}/agent-${nameToken}-${timestamp}.md`;
  try {
    const scoopCtx = ctx.orchestrator.getScoopContext(jid);
    const messages =
      typeof scoopCtx?.getAgentMessages === 'function' ? scoopCtx.getAgentMessages() : [];
    const markdown = serializeAgentSessionArchive({
      name: nameToken,
      jid,
      prompt: options.prompt,
      exitCode: outcome.exitCode,
      messages,
      timestamp,
    });
    await ctx.sharedFs.mkdir(dir, { recursive: true });
    await ctx.sharedFs.writeFile(path, markdown);
  } catch (err) {
    log.warn('agent session archive write failed', { path, error: errText(err) });
  }
}

function buildScoopConfig(
  options: AgentSpawnOptions,
  effectiveModelId: string,
  effectiveModelProviderId: string | undefined,
  effectiveThinkingLevel: ThinkingLevel | undefined,
  scratchFolder: string,
  defaultVisibleRoots: string[]
): NonNullable<RegisteredScoop['config']> {
  const cwdPrefix = normalizeRwPrefix(options.cwd);
  const mode = resolvedWorkspaceMode(options.workspaceMode);
  const visiblePaths = resolveVisiblePaths(options, defaultVisibleRoots, mode);
  const configuredWritable = resolveWritablePaths(options.writablePaths, cwdPrefix, mode);
  const writablePaths = dedupePrefixes([...configuredWritable, `${scratchFolder}/`, '/tmp/']);

  const scoopConfig: NonNullable<RegisteredScoop['config']> = {
    visiblePaths,
    writablePaths,
    workspaceMode: mode,
    allowedCommands: options.allowedCommands,
  };
  if (options.maxTurns !== undefined) {
    scoopConfig.maxTurns = options.maxTurns;
  }
  if (options.maxWallClockMs !== undefined) {
    scoopConfig.maxWallClockMs = options.maxWallClockMs;
  }
  if (options.backgroundAfterSeconds !== undefined) {
    scoopConfig.backgroundAfterSeconds = options.backgroundAfterSeconds;
  }
  if (effectiveModelId) {
    scoopConfig.modelId = effectiveModelId;
    if (effectiveModelProviderId !== undefined) {
      scoopConfig.modelProviderId = effectiveModelProviderId;
    }
  }
  if (effectiveThinkingLevel !== undefined) {
    scoopConfig.thinkingLevel = effectiveThinkingLevel;
  }
  if (options.structuredOutputSchema !== undefined) {
    scoopConfig.structuredOutputSchema = options.structuredOutputSchema;
  }

  return scoopConfig;
}

function registerScoopObserver(orchestrator: Orchestrator, jid: string) {
  const state = {
    sendMessages: [] as string[],
    responseBuffer: '',
    scoopError: null as string | null,
    unsubscribe: null as (() => void) | null,
  };

  state.unsubscribe = orchestrator.observeScoop(jid, {
    onSendMessage: (text) => {
      state.sendMessages.push(text);
    },
    onResponse: (text, isPartial) => {
      if (isPartial) {
        state.responseBuffer += text;
      } else {
        state.responseBuffer = text;
      }
    },
    onError: (errMsg) => {
      if (state.scoopError === null) {
        state.scoopError = errMsg;
      }
    },
  });

  return state;
}

async function runScoopAndCaptureOutput(
  orchestrator: Orchestrator,
  jid: string,
  prompt: string,
  structuredOutputSchema: JsonSchemaObject | undefined,
  observerState: ReturnType<typeof registerScoopObserver>
): Promise<AgentSpawnResult | null> {
  await orchestrator.sendPrompt(jid, prompt, 'agent', 'agent');

  if (observerState.scoopError !== null) {
    return { finalText: observerState.scoopError, exitCode: 1 };
  }

  if (structuredOutputSchema) {
    const ctxRef = orchestrator.getScoopContext(jid);
    let so = ctxRef?.getStructuredOutput?.();
    for (let nudge = 0; nudge < 2 && !so?.captured; nudge++) {
      await orchestrator.sendPrompt(
        jid,
        'You did not call StructuredOutput. Call it now with your result, matching the schema.',
        'agent',
        'agent'
      );

      if (observerState.scoopError !== null) {
        return { finalText: observerState.scoopError, exitCode: 1 };
      }
      so = ctxRef?.getStructuredOutput?.();
    }
    if (so?.captured) {
      return { finalText: JSON.stringify(so.value), exitCode: 0 };
    }
    return { finalText: 'agent: scoop did not produce StructuredOutput', exitCode: 1 };
  }

  const finalText =
    observerState.sendMessages.length > 0
      ? observerState.sendMessages[observerState.sendMessages.length - 1]
      : observerState.responseBuffer;
  return { finalText, exitCode: 0 };
}

async function cleanupScoop(
  ctx: BridgeContext,
  jid: string,
  folder: string,
  scratchFolder: string
): Promise<void> {
  try {
    await ctx.orchestrator.unregisterScoop(jid);
  } catch (err) {
    log.warn('unregisterScoop failed', { jid, error: errText(err) });
  }
  try {
    await ctx.sharedFs.rm(scratchFolder, { recursive: true });
  } catch (err) {
    if (!isFsErrorCode(err, 'ENOENT')) {
      log.warn('scratch folder cleanup failed', { folder, error: errText(err) });
    }
  }
  if (ctx.sessionStore) {
    try {
      await ctx.sessionStore.delete(jid);
    } catch (err) {
      log.warn('sessionStore.delete failed', { jid, error: errText(err) });
    }
  }
}

async function runScoopToOutcome(
  ctx: BridgeContext,
  options: AgentSpawnOptions,
  scoop: RegisteredScoop,
  jid: string,
  observerHandle: ReturnType<typeof registerScoopObserver>
): Promise<AgentSpawnResult> {
  let outcome = await runScoopToOutcomeInner(ctx, options, scoop, jid, observerHandle);

  let merge: MergeOutcome | undefined;
  if (outcome.exitCode === 0 && options.mergeOnSuccess) {
    merge = await applyMergeOnSuccess(ctx.sharedFs, options.mergeOnSuccess);
    if (merge.error !== undefined) {
      outcome = {
        finalText: `agent: mergeOnSuccess failed: ${merge.error}`,
        exitCode: 1,
      };
    }
  }
  if (outcome.exitCode === 0 && options.successReceiptPath) {
    await writeSuccessReceipt(ctx.sharedFs, options.successReceiptPath);
  }
  if (options.outcomeReceiptPath) {
    await writeOutcomeReceipt(ctx.sharedFs, options.outcomeReceiptPath, outcome, merge);
  }
  return outcome;
}

async function runScoopToOutcomeInner(
  ctx: BridgeContext,
  options: AgentSpawnOptions,
  scoop: RegisteredScoop,
  jid: string,
  observerHandle: ReturnType<typeof registerScoopObserver>
): Promise<AgentSpawnResult> {
  try {
    await ctx.orchestrator.registerScoop(scoop);
  } catch (err) {
    return { finalText: observerHandle.scoopError ?? errText(err), exitCode: 1 };
  }

  try {
    const result = await runScoopAndCaptureOutput(
      ctx.orchestrator,
      jid,
      options.prompt,
      options.structuredOutputSchema,
      observerHandle
    );
    if (options.signal?.aborted) {
      return { finalText: 'agent: aborted', exitCode: 1 };
    }
    if (result) {
      return result;
    }
    return { finalText: observerHandle.scoopError ?? '', exitCode: 1 };
  } catch (err) {
    return { finalText: observerHandle.scoopError ?? errText(err), exitCode: 1 };
  }
}

export function createAgentBridge(
  orchestrator: Orchestrator,
  sharedFs: VirtualFS,
  sessionStore: SessionStore | null | undefined = null,
  deps: AgentBridgeDeps = {}
): AgentBridge {
  const ctx: BridgeContext = {
    orchestrator,
    sharedFs,
    sessionStore,
    generateName: deps.generateName ?? defaultGenerateName,
    generateUid: deps.generateUid ?? defaultGenerateUid,
    resolveModel: deps.resolveModel ?? defaultResolveModel,
  };

  async function spawn(options: AgentSpawnOptions): Promise<AgentSpawnResult> {
    const validation = validateSpawnOptions(options, ctx.resolveModel);
    if ('error' in validation) return validation.error;

    const parentModel = resolveParentModelSelection(ctx.orchestrator, options.parentJid);
    const effectiveModelId = validation.resolvedModelId ?? parentModel?.modelId ?? '';
    const effectiveModelProviderId =
      validation.resolvedModelId !== undefined
        ? validation.resolvedProviderId
        : parentModel?.providerId;

    const requestedLevel = options.thinkingLevel;
    const effectiveThinkingLevel =
      requestedLevel ??
      resolveParentThinkingLevel(ctx.orchestrator, options.parentJid) ??
      undefined;

    const nameToken = options.name !== undefined ? options.name : pickFreshNameToken(ctx);
    const folder = `agent-${nameToken}`;
    const jid = `agent_${tokenToJid(nameToken)}`;

    const liveJids = new Set(ctx.orchestrator.getScoops().map((s) => s.jid));
    if (options.name !== undefined && liveJids.has(jid)) {
      return { finalText: `${AGENT_NAME_IN_USE_PREFIX}: ${nameToken}`, exitCode: 1 };
    }

    const rival = (options.exclusiveWith ?? []).find((n) => liveJids.has(`agent_${tokenToJid(n)}`));
    if (rival !== undefined) {
      return { finalText: `${AGENT_NAME_IN_USE_PREFIX}: ${rival}`, exitCode: 1 };
    }
    const scratchFolder = `/scoops/${folder}`;

    const parentJid = options.parentJid ?? rootsOf(ctx.orchestrator.getScoops())[0]?.jid ?? null;
    const scoopConfig = buildScoopConfig(
      options,
      effectiveModelId,
      effectiveModelProviderId,
      effectiveThinkingLevel,
      scratchFolder,
      resolveOwnerVisibleRoots(ctx.orchestrator, parentJid)
    );

    const scoop: RegisteredScoop = {
      jid,
      name: folder,
      folder,
      requiresTrigger: false,
      assistantLabel: folder,
      addedAt: new Date().toISOString(),
      config: scoopConfig,
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
      notifyOnComplete: options.notifyOnComplete === true,
      parentJid,
    };

    const observerHandle = registerScoopObserver(ctx.orchestrator, jid);

    const onAbort = (): void => {
      try {
        ctx.orchestrator.stopScoop(jid);
      } catch (err) {
        log.warn('stopScoop on abort failed', { jid, error: errText(err) });
      }
    };

    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      options.signal.removeEventListener('abort', onAbort);
      observerHandle.unsubscribe?.();
      return { finalText: 'agent: aborted before start', exitCode: 1 };
    }

    let outcome: AgentSpawnResult = { finalText: '', exitCode: 1 };
    try {
      outcome = await runScoopToOutcome(ctx, options, scoop, jid, observerHandle);
      return outcome;
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      observerHandle.unsubscribe?.();

      await writeAgentSessionArchive(ctx, options, jid, nameToken, outcome);
      await cleanupScoop(ctx, jid, folder, scratchFolder);
    }
  }

  return { spawn };
}

export function publishAgentBridge(
  orchestrator: Orchestrator,
  sharedFs: VirtualFS,
  sessionStore: SessionStore | null | undefined = null,
  deps: AgentBridgeDeps = {}
): AgentBridge {
  const bridge = createAgentBridge(orchestrator, sharedFs, sessionStore, deps);
  (globalThis as AgentBridgeGlobal)[AGENT_BRIDGE_GLOBAL_KEY] = bridge;
  log.info('agent bridge published on globalThis.__slicc_agent');
  return bridge;
}

function defaultGenerateUid(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (typeof g.crypto?.randomUUID === 'function') {
    return g.crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function defaultGenerateName(): string {
  const adjective = AGENT_ADJECTIVES[Math.floor(Math.random() * AGENT_ADJECTIVES.length)];
  const flavor = AGENT_FLAVORS[Math.floor(Math.random() * AGENT_FLAVORS.length)];
  return `${adjective}-${flavor}`;
}

function tokenToJid(token: string): string {
  return token.replace(/-/g, '_');
}

export function defaultResolveModel(modelId: string): ScoopModelResolution {
  try {
    return resolveModelSelectionForScoop(modelId);
  } catch (err) {
    log.warn('defaultResolveModel: provider/account lookup threw; treating model as unknown', {
      modelId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: `unknown model: ${modelId}` };
  }
}

function normalizeRwPrefix(path: string): string {
  const normalized = normalizePath(path);
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

function resolvedWorkspaceMode(raw: WorkspaceIsolationMode | undefined): ImplementedWorkspaceMode {
  const parsed = parseWorkspaceMode(raw);
  return parsed.ok ? parsed.mode : DEFAULT_CHILD_WORKSPACE_MODE;
}

function resolveWritablePaths(
  paths: string[] | undefined,
  cwdPrefix: string,
  mode: ImplementedWorkspaceMode = DEFAULT_CHILD_WORKSPACE_MODE
): string[] {
  const defaults = mode === 'private' ? [cwdPrefix] : [cwdPrefix, '/shared/'];
  if (paths === undefined) return defaults;
  if (
    paths.some((path) => typeof path !== 'string' || !path.startsWith('/') || path.includes('\0'))
  ) {
    return defaults;
  }
  return paths.map(normalizeRwPrefix);
}

function resolveVisiblePaths(
  options: AgentSpawnOptions,
  defaultVisibleRoots: string[],
  mode: ImplementedWorkspaceMode = DEFAULT_CHILD_WORKSPACE_MODE
): string[] {
  if (options.visiblePaths !== undefined) {
    return options.visiblePaths.map(normalizeRwPrefix);
  }
  if (mode === 'private') return [];
  const base = [...defaultVisibleRoots];
  if (options.invokingCwd && options.invokingCwd.length > 0) {
    base.push(normalizeRwPrefix(options.invokingCwd));
  }
  return dedupePrefixes(base);
}

function dedupePrefixes(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of paths) {
    if (!seen.has(p)) {
      seen.add(p);
      result.push(p);
    }
  }
  return result;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isFsErrorCode(err: unknown, expected: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code === expected;
}
