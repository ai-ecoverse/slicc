import { slugify } from '@slicc/shared-ts';
import { createLogger } from '../base/logger.js';
import type { ScoopModelResolution } from '../providers/account-store.js';
import { normalizeSudoReason } from '../sudo/reason.js';
import type { SudoDecision, SudoKind, SudoRequest } from '../sudo/types.js';
import type { ToolDefinition } from '../tools/types.js';
import { defaultChildVisibleRoots, workspaceFor } from '../work-unit/descriptor.js';
import {
  derivePolicy,
  isRootUnit,
  ownershipChainOf,
  rootOwnerOf,
  subtreeOf,
} from '../work-unit/policy.js';
import { leadingRootOf, uniqueFolder } from '../work-unit/record.js';
import { type ImplementedWorkspaceMode, parseWorkspaceMode } from '../work-unit/workspace-mode.js';
import {
  CURRENT_SCOOP_CONFIG_VERSION,
  isThinkingLevel,
  type RegisteredScoop,
  THINKING_LEVELS,
  type ThinkingLevel,
} from './types.js';

const log = createLogger('scoop-management-tools');

export interface ScoopManagementToolsConfig {
  scoop: RegisteredScoop;
  onSendMessage: (text: string, sender?: string) => void;

  onFeedScoop?: (scoopJid: string, prompt: string) => Promise<void>;
  getScoops: () => RegisteredScoop[];

  getScoopTabState?: (jid: string) => import('./types.js').ScoopTabState | undefined;
  onScoopScoop?: (scoop: Omit<RegisteredScoop, 'jid'>) => Promise<RegisteredScoop>;

  resolveModelSelection?: (modelId: string) => ScoopModelResolution;
  onDropScoop?: (scoopJid: string) => Promise<void>;
  onSetGlobalMemory?: (content: string) => Promise<void>;
  getGlobalMemory?: () => Promise<string>;

  onMuteScoops?: (jids: readonly string[]) => void;

  onUnmuteScoops?: (
    jids: readonly string[]
  ) => Promise<
    Array<{ jid: string; summary: string; timestamp: string; notificationPath: string | null }>
  >;

  onScheduleScoopWait?: (
    jids: readonly string[],
    timeoutMs?: number
  ) => { scheduled: string[]; unknown: string[] };

  onSudoRequest?: (request: SudoRequest) => Promise<SudoDecision>;

  onSudoResolve?: (
    id: string,
    decision: SudoDecision
  ) => Promise<{
    settled: boolean;
    persisted: boolean;
    persistedPattern?: string;
    persistError?: string;
    scoopFolder?: string;
    kind?: SudoKind;

    message?: string;
  }>;

  onListSudoRequests?: () => Array<{
    id: string;
    scoopJid: string;
    request: SudoRequest;
  }>;
}

export type ScoopRelation = 'own' | 'inherited' | 'foreign';

interface ManagedScoop {
  scoop: RegisteredScoop;
  relation: ScoopRelation;
}

const CROSS_CONE_PARAM = 'cross_cone';

function callerSubtree(config: ScoopManagementToolsConfig): RegisteredScoop[] {
  return subtreeOf(config.getScoops(), config.scoop.jid);
}

function ownJids(config: ScoopManagementToolsConfig): Set<string> {
  const own = new Set<string>();
  for (const s of callerSubtree(config)) {
    if (s.jid !== config.scoop.jid && s.parentJid !== null) own.add(s.jid);
  }
  return own;
}

function callerLeads(config: ScoopManagementToolsConfig): boolean {
  const lead = leadingRootOf(config.getScoops());
  return lead !== undefined && lead.jid === config.scoop.jid;
}

function manageableScoops(config: ScoopManagementToolsConfig): ManagedScoop[] {
  const units = config.getScoops();
  const own = ownJids(config);
  const leads = callerLeads(config);
  const out: ManagedScoop[] = [];
  for (const scoop of units) {
    if (scoop.parentJid === null) continue;
    if (own.has(scoop.jid)) {
      out.push({ scoop, relation: 'own' });
      continue;
    }
    if (!leads) continue;
    const chain = ownershipChainOf(units, scoop);

    if (chain.kind === 'cycle') continue;
    out.push({ scoop, relation: chain.kind === 'root' ? 'foreign' : 'inherited' });
  }
  return out;
}

function byName(name: string) {
  return (s: RegisteredScoop): boolean => s.folder === name || s.name === name;
}

function findManageable(
  name: string,
  config: ScoopManagementToolsConfig
): ManagedScoop | undefined {
  const all = manageableScoops(config);
  return (
    all.find((m) => m.scoop.folder === name) ??
    all.find((m) => m.relation === 'own' && m.scoop.name === name) ??
    all.find((m) => m.scoop.name === name)
  );
}

function resolveScoopNames(
  names: readonly string[],
  config: ScoopManagementToolsConfig
): { resolved: ManagedScoop[]; unknown: string[] } {
  const resolved: ManagedScoop[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    const m = findManageable(name, config);
    if (m) resolved.push(m);
    else unknown.push(name);
  }
  return { resolved, unknown };
}

function ownerFolderOf(config: ScoopManagementToolsConfig, m: ManagedScoop): string {
  return rootOwnerOf(config.getScoops(), m.scoop)?.folder ?? 'unknown';
}

function describeRelation(config: ScoopManagementToolsConfig, m: ManagedScoop): string {
  if (m.relation === 'inherited') return 'inherited (its owning cone is gone)';
  return `owned by cone "${ownerFolderOf(config, m)}"`;
}

function crossConeGate(
  targets: readonly ManagedScoop[],
  crossCone: unknown,
  verb: string,
  config: ScoopManagementToolsConfig
): ToolResult | null {
  const outside = targets.filter((m) => m.relation !== 'own');
  if (outside.length === 0 || crossCone === true) return null;
  const detail = outside
    .map((m) => `"${m.scoop.folder}" is ${describeRelation(config, m)}`)
    .join('; ');
  return {
    content: `Refusing to ${verb}: ${detail}. Pass ${CROSS_CONE_PARAM}: true to act on it anyway.`,
    isError: true,
  };
}

function crossConeSchema(verb: string) {
  return {
    type: 'boolean' as const,
    description: `Set true to ${verb} a scoop you do not own — inherited (its cone is gone) or another cone's. Default false; omitting it on such a scoop is an error, so the choice stays deliberate.`,
  };
}

const SUDO_KINDS: readonly SudoKind[] = ['command', 'read', 'write', 'secret'];

function folderFromDisplayName(name: string): string {
  return `${slugify(name, { maxLen: 50 })}-scoop`;
}

function parseThinkingLevel(
  thinking: string | undefined
): { ok: true; level?: ThinkingLevel } | { ok: false; content: string; isError: true } {
  if (thinking === undefined) return { ok: true };
  if (!isThinkingLevel(thinking)) {
    return {
      ok: false,
      content: `Invalid thinking level "${thinking}". Must be one of: ${THINKING_LEVELS.join(', ')}.`,
      isError: true,
    };
  }
  return { ok: true, level: thinking };
}

function parseBackgroundAfter(
  value: number | undefined
): { ok: true; seconds?: number } | { ok: false; content: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return {
      ok: false,
      content: `Invalid background_after "${String(value)}". Must be a number of seconds >= 0.`,
    };
  }
  return { ok: true, seconds: value };
}

function parseModelId(
  model: string | undefined,
  resolveModelSelection: ScoopManagementToolsConfig['resolveModelSelection']
):
  | { ok: true; modelId?: string; providerId?: string }
  | { ok: false; content: string; isError: true } {
  if (model === undefined || !resolveModelSelection) return { ok: true, modelId: model };
  const resolved = resolveModelSelection(model);
  if (!resolved.ok) {
    return {
      ok: false,
      content: `Unknown model "${model}": ${resolved.error}. Run the "models" shell command to list available model IDs.`,
      isError: true,
    };
  }
  return {
    ok: true,
    modelId: resolved.selection.modelId,
    providerId: resolved.selection.providerId,
  };
}

function notFoundError(names: readonly string[], config: ScoopManagementToolsConfig) {
  const available =
    manageableScoops(config)
      .map((m) => m.scoop.folder)
      .join(', ') || '(none)';
  return {
    content: `Not found in the scoops you can manage (${config.scoop.folder}): ${names.join(', ')}. Available: ${available}`,
    isError: true as const,
  };
}

function formatScoopLine(
  s: RegisteredScoop,
  getScoopTabState: ScoopManagementToolsConfig['getScoopTabState'],
  relationTag = ''
): string {
  const tab = getScoopTabState?.(s.jid);
  const status = tab?.status ?? 'unknown';
  const activity = tab?.lastActivity
    ? new Date(tab.lastActivity).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      })
    : '';
  const statusSuffix = activity ? ` — ${status} (since ${activity})` : ` — ${status}`;
  if (s.parentJid === null) return `- ${s.assistantLabel} (${s.folder}) [CONE]${statusSuffix}`;
  return `- ${s.name} (${s.folder})${relationTag}${statusSuffix}`;
}

type ToolResult = { content: string; isError?: boolean };

async function executeSendMessage(
  input: unknown,
  config: ScoopManagementToolsConfig
): Promise<ToolResult> {
  const { text, sender } = input as { text: string; sender?: string };
  config.onSendMessage(text, sender);
  log.info('Message sent', { scoopFolder: config.scoop.folder, textLength: text.length });
  return { content: 'Message sent.' };
}

function validateSudoRequestInput(
  input: unknown
): { ok: true; request: SudoRequest } | { ok: false; result: ToolResult } {
  const {
    kind,
    detail,
    suggested_pattern: suggestedPattern,
    reason,
  } = input as { kind: string; detail: string; suggested_pattern?: string; reason?: string };
  if (!SUDO_KINDS.includes(kind as SudoKind)) {
    return {
      ok: false,
      result: {
        content: `Invalid sudo kind "${kind}". Must be one of: ${SUDO_KINDS.join(', ')}.`,
        isError: true,
      },
    };
  }
  if (typeof detail !== 'string' || detail.trim().length === 0) {
    return { ok: false, result: { content: 'detail must be a non-empty string.', isError: true } };
  }

  const safeReason = typeof reason === 'string' ? normalizeSudoReason(reason) : '';
  const request: SudoRequest = {
    kind: kind as SudoKind,
    detail,
    ...(suggestedPattern ? { suggestedPattern } : {}),
    ...(safeReason ? { reason: safeReason } : {}),
  };
  return { ok: true, request };
}

function formatSudoDecision(decision: SudoDecision): string {
  const lines = [`Cone decision: ${decision.decision}.`];
  if (decision.decision === 'always' && decision.pattern) {
    lines.push(`Persisted pattern: ${decision.pattern}`);
  }
  if (decision.note) lines.push(`Approver's reason: ${decision.note}`);
  if (decision.decision === 'deny') {
    lines.push(
      decision.note
        ? 'Not approved. Address the reason above before asking again; do not retry as-is and do not route around it.'
        : 'Not approved, and no reason was given. Do not retry as-is; ask the cone what would make it acceptable, or move on.'
    );
  }
  return lines.join('\n');
}

async function executeSudoRequest(
  input: unknown,
  config: ScoopManagementToolsConfig
): Promise<ToolResult> {
  const validated = validateSudoRequestInput(input);
  if (!validated.ok) return validated.result;
  try {
    const decision = await config.onSudoRequest!(validated.request);
    log.info('Sudo request resolved', {
      scoopFolder: config.scoop.folder,
      kind: validated.request.kind,
      decision: decision.decision,
    });
    return { content: formatSudoDecision(decision) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `sudo_request failed: ${msg}`, isError: true };
  }
}

async function executeFeedScoop(
  input: unknown,
  config: ScoopManagementToolsConfig
): Promise<ToolResult> {
  const { scoop_name, prompt, cross_cone } = input as {
    scoop_name: string;
    prompt: string;
    cross_cone?: boolean;
  };

  if (byName(scoop_name)(config.scoop)) {
    return { content: 'Cannot feed yourself.', isError: true };
  }
  const target = findManageable(scoop_name, config);
  if (!target) return notFoundError([scoop_name], config);
  const gate = crossConeGate([target], cross_cone, `feed "${scoop_name}"`, config);
  if (gate) return gate;
  try {
    await config.onFeedScoop!(target.scoop.jid, prompt);
    log.info('Fed scoop', {
      target: target.scoop.folder,
      relation: target.relation,
      promptLength: prompt.length,
    });

    const notice =
      target.relation === 'own'
        ? 'You will be notified when it completes.'
        : `Its completion notice goes to its owner; use scoop_wait (${CROSS_CONE_PARAM}: true) for the result.`;
    return { content: `Task sent to ${target.scoop.folder}. ${notice}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Failed to feed scoop: ${msg}`, isError: true };
  }
}

function relationTagFor(config: ScoopManagementToolsConfig, m: ManagedScoop): string {
  if (m.relation === 'own') return '';
  if (m.relation === 'inherited') return ' [INHERITED]';
  return ` [FOREIGN: ${ownerFolderOf(config, m)}]`;
}

async function executeListScoops(config: ScoopManagementToolsConfig): Promise<ToolResult> {
  const manageable = new Map(manageableScoops(config).map((m) => [m.scoop.jid, m]));
  const rows = config
    .getScoops()
    .filter((s) => s.jid === config.scoop.jid || manageable.has(s.jid));
  if (rows.length === 0) return { content: 'No scoops registered.' };
  const formatted = rows
    .map((s) => {
      const m = manageable.get(s.jid);
      return formatScoopLine(s, config.getScoopTabState, m ? relationTagFor(config, m) : '');
    })
    .join('\n');
  return { content: `Registered scoops:\n${formatted}` };
}

interface ScoopRecordInput {
  name: string;
  folder: string;
  model: string | undefined;

  modelProviderId: string | undefined;
  visiblePaths: string[] | undefined;
  writablePaths: string[] | undefined;
  workspaceMode: ImplementedWorkspaceMode;
  allowedCommands: string[] | undefined;
  thinkingLevel: ThinkingLevel | undefined;
  backgroundAfterSeconds: number | undefined;

  parentJid: string;

  defaultVisibleRoots: string[];

  canCreateChildren?: boolean;
}

function buildScoopRecord({
  name,
  folder,
  model,
  modelProviderId,
  visiblePaths,
  writablePaths,
  workspaceMode,
  allowedCommands,
  thinkingLevel,
  backgroundAfterSeconds,
  parentJid,
  defaultVisibleRoots,
  canCreateChildren,
}: ScoopRecordInput): Omit<RegisteredScoop, 'jid'> {
  return {
    name,
    folder,
    trigger: `@${folder}`,
    requiresTrigger: true,
    assistantLabel: folder,
    addedAt: new Date().toISOString(),
    config: {
      ...(model ? { modelId: model } : {}),
      ...(model && modelProviderId ? { modelProviderId } : {}),
      ...childSandboxPaths(workspaceMode, folder, defaultVisibleRoots, visiblePaths, writablePaths),
      workspaceMode,
      ...(allowedCommands ? { allowedCommands } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(backgroundAfterSeconds !== undefined ? { backgroundAfterSeconds } : {}),
      ...(canCreateChildren === true ? { canCreateChildren: true } : {}),
    },
    configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,

    parentJid,
  };
}

function childSandboxPaths(
  mode: ImplementedWorkspaceMode,
  folder: string,
  defaultVisibleRoots: string[],
  visiblePaths: string[] | undefined,
  writablePaths: string[] | undefined
): { visiblePaths: string[]; writablePaths: string[] } {
  const sandbox = `/scoops/${folder}/`;
  return {
    visiblePaths: visiblePaths ?? (mode === 'private' ? [] : defaultVisibleRoots),
    writablePaths: writablePaths ?? (mode === 'private' ? [sandbox] : [sandbox, '/shared/']),
  };
}

async function autoFeedNewScoop(
  newScoop: RegisteredScoop,
  taskPrompt: string,
  name: string,
  folder: string,
  onFeedScoop: NonNullable<ScoopManagementToolsConfig['onFeedScoop']>
): Promise<ToolResult> {
  try {
    await onFeedScoop(newScoop.jid, taskPrompt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Auto-feed failed', { name, error: msg });
    return {
      content:
        `Scoop "${name}" created as "${folder}" but the initial task could not be sent: ${msg}. ` +
        `Use feed_scoop to retry.`,
      isError: true,
    };
  }
  return {
    content: `Scoop "${name}" created as "${folder}" and task sent. It is now working on it.`,
  };
}

async function executeScoopScoop(
  input: unknown,
  config: ScoopManagementToolsConfig
): Promise<ToolResult> {
  const {
    name,
    model,
    prompt: taskPrompt,
    visiblePaths,
    writablePaths,
    workspaceMode,
    allowedCommands,
    thinking,
    background_after: backgroundAfter,
    canCreateChildren,
  } = input as {
    name: string;
    model?: string;
    prompt?: string;
    visiblePaths?: string[];
    writablePaths?: string[];
    workspaceMode?: string;
    allowedCommands?: string[];
    thinking?: string;
    background_after?: number;
    canCreateChildren?: boolean;
  };

  const parsedMode = parseWorkspaceMode(workspaceMode);
  if (!parsedMode.ok) return { content: parsedMode.error, isError: true };

  const parsed = parseThinkingLevel(thinking);
  if (!parsed.ok) return { content: parsed.content, isError: parsed.isError };

  const parsedBackgroundAfter = parseBackgroundAfter(backgroundAfter);
  if (!parsedBackgroundAfter.ok) {
    return { content: parsedBackgroundAfter.content, isError: true };
  }

  const parsedModel = parseModelId(model, config.resolveModelSelection);
  if (!parsedModel.ok) return { content: parsedModel.content, isError: parsedModel.isError };

  const wantedFolder = folderFromDisplayName(name);

  const duplicate = callerSubtree(config).find(
    (s) =>
      s.jid !== config.scoop.jid &&
      s.parentJid !== null &&
      (s.name === name || s.folder === wantedFolder)
  );
  if (duplicate) {
    return {
      content:
        `A scoop named "${duplicate.name}" (${duplicate.folder}) already exists in your scoops. ` +
        `Use feed_scoop to give it another task, or drop_scoop first.`,
      isError: true,
    };
  }

  const folder = uniqueFolder(
    wantedFolder,
    config.getScoops().map((s) => s.folder)
  );
  try {
    const record = buildScoopRecord({
      name,
      folder,
      model: parsedModel.modelId,
      modelProviderId: parsedModel.providerId,
      visiblePaths,
      writablePaths,
      workspaceMode: parsedMode.mode,
      allowedCommands,
      thinkingLevel: parsed.level,
      backgroundAfterSeconds: parsedBackgroundAfter.seconds,
      parentJid: config.scoop.jid,
      defaultVisibleRoots: defaultChildVisibleRoots(workspaceFor(config.scoop)),
      canCreateChildren: canCreateChildren === true,
    });
    const newScoop = await config.onScoopScoop!(record);
    log.info('Scoop created', { name, folder });
    if (taskPrompt && config.onFeedScoop) {
      return autoFeedNewScoop(newScoop, taskPrompt, name, folder, config.onFeedScoop);
    }
    return {
      content: `Scoop "${name}" created as "${folder}". Use feed_scoop to give it a task.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Failed to create scoop: ${msg}`, isError: true };
  }
}

async function executeDropScoop(
  input: unknown,
  config: ScoopManagementToolsConfig
): Promise<ToolResult> {
  const { scoop_name, cross_cone } = input as { scoop_name: string; cross_cone?: boolean };

  if (byName(scoop_name)(config.scoop)) {
    return { content: 'Cannot drop yourself.', isError: true };
  }
  const target = findManageable(scoop_name, config);
  if (!target) return notFoundError([scoop_name], config);
  const gate = crossConeGate([target], cross_cone, `drop "${scoop_name}"`, config);
  if (gate) return gate;
  try {
    await config.onDropScoop!(target.scoop.jid);
    log.info('Scoop dropped', {
      name: target.scoop.name,
      folder: target.scoop.folder,
      relation: target.relation,
    });
    return {
      content: `Scoop "${target.scoop.name}" (${target.scoop.folder}) has been dropped.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Failed to drop scoop: ${msg}`, isError: true };
  }
}

function emptyNamesError(): ToolResult {
  return { content: 'scoop_names must be a non-empty array.', isError: true };
}

async function executeMuteScoops(
  input: unknown,
  config: ScoopManagementToolsConfig
): Promise<ToolResult> {
  const { scoop_names, cross_cone } = input as { scoop_names: string[]; cross_cone?: boolean };
  if (!Array.isArray(scoop_names) || scoop_names.length === 0) return emptyNamesError();
  const { resolved, unknown } = resolveScoopNames(scoop_names, config);
  if (resolved.length === 0) return notFoundError(unknown, config);
  const gate = crossConeGate(resolved, cross_cone, 'mute these scoops', config);
  if (gate) return gate;
  config.onMuteScoops!(resolved.map((m) => m.scoop.jid));
  log.info('Scoops muted', { names: resolved.map((m) => m.scoop.folder) });
  const muted = resolved.map((m) => m.scoop.folder).join(', ');
  const warn = unknown.length > 0 ? ` (unknown: ${unknown.join(', ')})` : '';
  return { content: `Muted: ${muted}${warn}` };
}

function formatUnmuteStashSection(
  consumed: ReadonlyArray<{
    jid: string;
    summary: string;
    timestamp: string;
    notificationPath: string | null;
  }>,
  jidToFolder: ReadonlyMap<string, string>
): string[] {
  if (consumed.length === 0) return ['No stashed completions.'];
  const lines: string[] = ['', 'Stashed completions:'];
  for (const entry of consumed) {
    const folder = jidToFolder.get(entry.jid) ?? entry.jid;
    lines.push(`--- ${folder} ---`);
    if (entry.notificationPath) {
      lines.push(`VFS path: ${entry.notificationPath}`);
    }
    lines.push(entry.summary);
  }
  return lines;
}

async function executeUnmuteScoops(
  input: unknown,
  config: ScoopManagementToolsConfig
): Promise<ToolResult> {
  const { scoop_names, cross_cone } = input as { scoop_names: string[]; cross_cone?: boolean };
  if (!Array.isArray(scoop_names) || scoop_names.length === 0) return emptyNamesError();
  const { resolved, unknown } = resolveScoopNames(scoop_names, config);
  if (resolved.length === 0) return notFoundError(unknown, config);
  const gate = crossConeGate(resolved, cross_cone, 'unmute these scoops', config);
  if (gate) return gate;
  const jids = resolved.map((m) => m.scoop.jid);
  const jidToFolder = new Map(resolved.map((m) => [m.scoop.jid, m.scoop.folder]));
  const consumed = await config.onUnmuteScoops!(jids);
  log.info('Scoops unmuted', {
    names: resolved.map((m) => m.scoop.folder),
    stashedCount: consumed.length,
  });
  const unmutedFolders = resolved.map((m) => m.scoop.folder).join(', ');
  const warn = unknown.length > 0 ? ` (unknown: ${unknown.join(', ')})` : '';
  const lines: string[] = [`Unmuted: ${unmutedFolders}${warn}`];
  lines.push(...formatUnmuteStashSection(consumed, jidToFolder));
  return { content: lines.join('\n') };
}

function validateWaitInput(scoopNames: unknown, timeoutMs: unknown): ToolResult | null {
  if (!Array.isArray(scoopNames) || scoopNames.length === 0) return emptyNamesError();
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0)
  ) {
    return {
      content: 'timeout_ms must be a non-negative finite number (or omitted).',
      isError: true,
    };
  }
  return null;
}

function formatWaitContent(
  scheduledFolders: string,
  unknownNames: readonly string[],
  droppedFolders: string,
  timeoutMs: number | undefined
): string {
  const tail = timeoutMs !== undefined ? ` (timeout: ${timeoutMs}ms)` : ' (no timeout)';
  const warnUnknown =
    unknownNames.length > 0 ? ` Unknown (skipped): ${unknownNames.join(', ')}.` : '';
  const warnDropped = droppedFolders
    ? ` Dropped before schedule (skipped): ${droppedFolders}.`
    : '';
  return (
    `scoop_wait scheduled for: ${scheduledFolders}${tail}.${warnUnknown}${warnDropped} ` +
    `Continue with other work — a 'scoop-wait' lick will be delivered when all listed scoops complete or the timeout fires.`
  );
}

async function executeScoopWait(
  input: unknown,
  config: ScoopManagementToolsConfig
): Promise<ToolResult> {
  const { scoop_names, timeout_ms, cross_cone } = input as {
    scoop_names: string[];
    timeout_ms?: number;
    cross_cone?: boolean;
  };
  const inputError = validateWaitInput(scoop_names, timeout_ms);
  if (inputError) return inputError;

  const { resolved, unknown } = resolveScoopNames(scoop_names, config);
  if (resolved.length === 0) return notFoundError(unknown, config);
  const gate = crossConeGate(resolved, cross_cone, 'wait on these scoops', config);
  if (gate) return gate;

  const jids = resolved.map((m) => m.scoop.jid);

  const ack = config.onScheduleScoopWait!(jids, timeout_ms);
  const jidToFolder = new Map(resolved.map((m) => [m.scoop.jid, m.scoop.folder]));
  const scheduledFolders = ack.scheduled.map((jid) => jidToFolder.get(jid) ?? jid).join(', ');
  const droppedFolders = ack.unknown.map((jid) => jidToFolder.get(jid) ?? jid).join(', ');
  log.info('Wait scheduled', {
    scheduled: ack.scheduled.map((jid) => jidToFolder.get(jid) ?? jid),
    droppedAtSchedule: droppedFolders ? droppedFolders.split(', ') : [],
    unknownNames: unknown,
    timeout_ms,
  });
  if (ack.scheduled.length === 0) {
    const dropped = droppedFolders || ack.unknown.join(', ');
    const unknownTail = unknown.length > 0 ? ` Unknown names: ${unknown.join(', ')}.` : '';
    return {
      content: `scoop_wait could not be scheduled — every listed scoop was unregistered before the wait could start (dropped: ${dropped}).${unknownTail}`,
      isError: true,
    };
  }
  return { content: formatWaitContent(scheduledFolders, unknown, droppedFolders, timeout_ms) };
}

type SudoOutcome = Awaited<ReturnType<NonNullable<ScoopManagementToolsConfig['onSudoResolve']>>>;

function formatAllowOutcome(outcome: SudoOutcome, always: boolean): string {
  if (!always) {
    return 'Approved (once) — the current action proceeds; future ones will prompt again.';
  }
  if (outcome.persisted) {
    return `Approved (always) — persisted NOPASSWD rule for ${outcome.kind ?? 'unknown'} pattern "${outcome.persistedPattern}" in /etc/sudoers.d/scoop-${outcome.scoopFolder ?? '<unknown>'}.`;
  }
  if (outcome.persistError) {
    return `Approved (always) but could NOT persist a rule (${outcome.persistError}). The current action is allowed; future occurrences will prompt again.`;
  }
  return 'Approved (always) — no persistable rule applied for this request.';
}

async function executeLickConfirm(
  input: unknown,
  config: ScoopManagementToolsConfig
): Promise<ToolResult> {
  const { lick_id, always, pattern, reason } = input as {
    lick_id: string;
    always?: boolean;
    pattern?: string;
    reason?: string;
  };
  if (typeof lick_id !== 'string' || lick_id.length === 0) {
    return { content: 'lick_id must be a non-empty string.', isError: true };
  }
  const note = typeof reason === 'string' ? normalizeSudoReason(reason) : '';
  const decision: SudoDecision = {
    ...(always
      ? { decision: 'always' as const, ...(pattern ? { pattern } : {}) }
      : { decision: 'allow' as const }),
    ...(note ? { note } : {}),
  };
  try {
    const outcome = await config.onSudoResolve!(lick_id, decision);
    if (!outcome.settled) {
      return {
        content: `Lick "${lick_id}" is unknown, already resolved, or timed out.`,
        isError: true,
      };
    }
    log.info('Lick confirmed', {
      id: lick_id,
      always: !!always,
      persisted: outcome.persisted,
    });
    if (outcome.message) return { content: outcome.message };
    return { content: formatAllowOutcome(outcome, !!always) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `lick_confirm failed: ${msg}`, isError: true };
  }
}

async function executeLickDismiss(
  input: unknown,
  config: ScoopManagementToolsConfig
): Promise<ToolResult> {
  const { lick_id, reason } = input as { lick_id: string; reason?: string };
  if (typeof lick_id !== 'string' || lick_id.length === 0) {
    return { content: 'lick_id must be a non-empty string.', isError: true };
  }
  const note = typeof reason === 'string' ? normalizeSudoReason(reason) : '';
  try {
    const outcome = await config.onSudoResolve!(lick_id, {
      decision: 'deny',
      ...(note ? { note } : {}),
    });
    if (!outcome.settled) {
      return {
        content: `Lick "${lick_id}" is unknown, already resolved, or timed out.`,
        isError: true,
      };
    }
    log.info('Lick dismissed', { id: lick_id, hasReason: !!note });
    if (outcome.message) return { content: outcome.message };
    return {
      content: note
        ? `Denied, and the scoop was told why: "${note}"`
        : 'Denied with NO reason, so the scoop cannot tell refusal from misunderstanding. Pass `reason` next time.',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `lick_dismiss failed: ${msg}`, isError: true };
  }
}

async function executeListSudoRequests(config: ScoopManagementToolsConfig): Promise<ToolResult> {
  const pending = config.onListSudoRequests!();
  if (pending.length === 0) return { content: 'No pending sudo requests.' };
  const lines = pending.map((p) => {
    const s = config.getScoops().find((x) => x.jid === p.scoopJid);
    const folder = s?.folder ?? p.scoopJid;
    const suggested = p.request.suggestedPattern
      ? ` (suggested: ${p.request.suggestedPattern})`
      : '';
    const why = p.request.reason ? `\n    reason: ${p.request.reason}` : '';
    return `- ${p.id} — ${folder} — ${p.request.kind}: ${p.request.detail}${suggested}${why}`;
  });
  return { content: `Pending sudo requests:\n${lines.join('\n')}` };
}

async function executeUpdateGlobalMemory(
  input: unknown,
  config: ScoopManagementToolsConfig
): Promise<ToolResult> {
  const { content } = input as { content: string };
  try {
    await config.onSetGlobalMemory!(content);
    log.info('Global memory updated');
    return { content: 'Global memory updated successfully.' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Failed to update global memory: ${msg}`, isError: true };
  }
}

function sendMessageTool(config: ScoopManagementToolsConfig): ToolDefinition {
  return {
    name: 'send_message',
    description: `Send a progress message while still working. Your final output is also sent.`,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The message text to send' },
        sender: {
          type: 'string',
          description:
            'Optional sender name/role (e.g., "Researcher"). Defaults to assistant name.',
        },
      },
      required: ['text'],
    },
    execute: (input) => executeSendMessage(input, config),
  };
}

function sudoRequestTool(config: ScoopManagementToolsConfig): ToolDefinition {
  return {
    name: 'sudo_request',
    description:
      "Ask the cone for an explicit sudo escalation before running a sensitive action. Use this when you know up-front that a command, read, or write will be gated and you want a clean approval round-trip instead of letting the gate fire mid-action. Resolves with the cone's decision (allow / always / deny). If your sudoers already grants the subject with NOPASSWD, this resolves allow immediately without prompting the cone. 'always' durably widens your sandbox by appending a NOPASSWD rule to the cone-owned /etc/sudoers.d/scoop-<folder> drop-in (you cannot write it yourself). 'deny' (or a timeout / dropped cone) resolves fail-closed. Always pass 'reason': the approver sees only what you ask for, never why.",
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: [...SUDO_KINDS],
          description:
            'The kind of sensitive action being requested. command = a shell command; read/write = a VFS path; secret = a credential read. Only command/read/write can be persisted with "always" (no sudoers Secret directive).',
        },
        detail: {
          type: 'string',
          description:
            'The concrete subject of the request (e.g., the command line "git push origin main" or the VFS path "/workspace/.git/config"). The cone sees this verbatim.',
        },
        suggested_pattern: {
          type: 'string',
          description:
            'Optional pre-filled glob pattern for an "always" grant (e.g., "git push*" for a command or "/workspace/.git/**" for a path). The cone may override this.',
        },
        reason: {
          type: 'string',
          description:
            'Why you need this, in one sentence. Name the goal it unblocks, not the action restated: "the build writes its output there", not "I need to write there". Truncated at 300 characters.',
        },
      },
      required: ['kind', 'detail'],
    },
    execute: (input) => executeSudoRequest(input, config),
  };
}

function feedScoopTool(config: ScoopManagementToolsConfig): ToolDefinition {
  return {
    name: 'feed_scoop',
    description: `Give a scoop a task. Provide a complete, self-contained prompt — the scoop has no access to your conversation. You'll be notified when it finishes.`,
    inputSchema: {
      type: 'object',
      properties: {
        scoop_name: {
          type: 'string',
          description:
            'The scoop folder name (e.g., "test-scoop") — any name list_scoops shows you.',
        },
        prompt: {
          type: 'string',
          description:
            'Complete, self-contained instructions for the scoop. Include ALL context — the scoop cannot see your conversation.',
        },
        [CROSS_CONE_PARAM]: crossConeSchema('feed'),
      },
      required: ['scoop_name', 'prompt'],
    },
    execute: (input) => executeFeedScoop(input, config),
  };
}

function listScoopsTool(config: ScoopManagementToolsConfig): ToolDefinition {
  return {
    name: 'list_scoops',
    description:
      'List the scoops you can manage: your own subtree, plus — leading cone only — ones tagged [INHERITED] (owning cone gone) or [FOREIGN: <cone>] (another cone owns it). These names are the only ones feed_scoop / drop_scoop / scoop_mute / scoop_unmute / scoop_wait resolve; a tagged one also needs cross_cone: true.',
    inputSchema: { type: 'object', properties: {} },
    execute: () => executeListScoops(config),
  };
}

function scoopScoopTool(config: ScoopManagementToolsConfig): ToolDefinition {
  return {
    name: 'scoop_scoop',
    description:
      'Create a new scoop. Optionally specify a model, a prompt, a workspace isolation mode (private | shared-readonly), and per-scoop sandbox shape (visible/writable paths + command allow-list). If prompt is provided, the scoop starts working immediately after creation (no separate feed_scoop needed).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name for the scoop (e.g., "hero-block")' },
        model: {
          type: 'string',
          description:
            'Model ID for this scoop (e.g., "claude-sonnet-4-6"). If omitted, uses the same model as the cone.',
        },
        prompt: {
          type: 'string',
          description:
            'Task prompt for the scoop. If provided, the scoop starts working immediately after creation.',
        },
        visiblePaths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'VFS paths the scoop can READ (not write). Pure replace — what you set is what you get. Omit to use the default for workspaceMode: shared-readonly (the default) is YOUR OWN workspace plus the shared skills tree — ["/workspace/"] for the primary cone, ["/cones/<folder>/workspace/", "/workspace/skills/"] for any other; private is []. Prefer omitting it over naming "/workspace/" explicitly, which would point the scoop at a different cone\'s files. Pass [] for no extra read-only paths. Note: the scoop\'s writablePaths are always readable too, so a true read-nothing sandbox also requires writablePaths: []. Mounts remain readable in shared-readonly; private does not auto-include them. Trailing slash recommended (e.g. "/shared/data/").',
        },
        writablePaths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'VFS paths the scoop can READ AND WRITE. Pure replace. Omit to use the default ["/scoops/<folder>/", "/shared/"] which gives the scoop its own sandbox plus shared space. Pass [] to block all writes — note that /tmp stays readable and writable regardless, as shared scratch space every scoop gets (so nothing secret belongs there). Trailing slash recommended.',
        },
        workspaceMode: {
          type: 'string',
          enum: ['private', 'shared-readonly', 'snapshot', 'shared-live'],
          description:
            'Workspace isolation mode. Default "shared-readonly" is today\'s scoop: parent workspace + skills are visible, own sandbox + /shared/ are writable, mounts stay readable. "private" is an isolated sandbox (own /scoops/<folder>/ only — no parent workspace, no implicit /shared/, mounts are NOT auto-visible). "snapshot" and "shared-live" are not implemented and are rejected. Explicit visiblePaths / writablePaths still replace the mode\'s path defaults.',
        },
        allowedCommands: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Shell command allow-list. Omit for unrestricted access to every built-in, custom, and .jsh command (the default). Pass a list of command names to restrict the scoop\'s shell — e.g. ["echo","cat","grep"] for a read-only text-processing scoop. Pass ["*"] for explicit unrestricted. Applies to pipelines, substitutions, and network commands too.',
        },
        thinking: {
          type: 'string',
          enum: [...THINKING_LEVELS],
          description:
            'Reasoning / thinking-level for this scoop (pi-ai effort). One of: off, minimal, low, medium, high, xhigh. Omit to inherit the global default ("off"). Non-reasoning models always clamp to "off"; "xhigh" clamps to "high" on models that do not support the max tier.',
        },
        background_after: {
          type: 'number',
          description:
            "Seconds this scoop's bash tool waits for a command before detaching it to the background and continuing (default 600). Lower it for a scoop that must never stall on a slow command — nobody can cancel a scoop's turn, and its detached commands report back via a Background Command lick. Use 0 to detach every command immediately.",
        },
        canCreateChildren: {
          type: 'boolean',
          description:
            'Explicit nested-delegation grant. When true, the new scoop may create and manage its own children (grandchildren of you). Omit or false (the default) keeps it a leaf. The grant is refused when you do not hold canCreateChildren yourself.',
        },
      },
      required: ['name'],
    },
    execute: (input) => executeScoopScoop(input, config),
  };
}

function dropScoopTool(config: ScoopManagementToolsConfig): ToolDefinition {
  return {
    name: 'drop_scoop',
    description:
      'Remove a scoop and stop its work. The scoop will be unregistered and its context destroyed.',
    inputSchema: {
      type: 'object',
      properties: {
        scoop_name: {
          type: 'string',
          description:
            'The scoop folder name (e.g., "test-scoop") — any name list_scoops shows you.',
        },
        [CROSS_CONE_PARAM]: crossConeSchema('drop'),
      },
      required: ['scoop_name'],
    },
    execute: (input) => executeDropScoop(input, config),
  };
}

function scoopMuteTool(config: ScoopManagementToolsConfig): ToolDefinition {
  return {
    name: 'scoop_mute',
    description:
      "Suspend scoop→cone notifications for the given scoops. While muted, a scoop's completion is stashed and will be delivered to the cone when you call scoop_unmute (or scoop_wait which consumes it). Use this when coordinating parallel work so each scoop's completion does not trigger its own cone turn.",
    inputSchema: {
      type: 'object',
      properties: {
        scoop_names: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Folder or display names of scoops to mute (e.g., ["writer-scoop", "reviewer-scoop"]).',
        },
        [CROSS_CONE_PARAM]: crossConeSchema('mute'),
      },
      required: ['scoop_names'],
    },
    execute: (input) => executeMuteScoops(input, config),
  };
}

function scoopUnmuteTool(config: ScoopManagementToolsConfig): ToolDefinition {
  return {
    name: 'scoop_unmute',
    description:
      'Resume scoop→cone notifications for the given scoops. Any completion that landed while a scoop was muted is returned in this tool result (NOT dispatched as a new cone turn), so you can read all stashed summaries in the current turn. Scoops with no stashed completion are simply unmuted.',
    inputSchema: {
      type: 'object',
      properties: {
        scoop_names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Folder or display names of scoops to unmute (e.g., ["writer-scoop"]).',
        },
        [CROSS_CONE_PARAM]: crossConeSchema('unmute'),
      },
      required: ['scoop_names'],
    },
    execute: (input) => executeUnmuteScoops(input, config),
  };
}

function scoopWaitTool(config: ScoopManagementToolsConfig): ToolDefinition {
  return {
    name: 'scoop_wait',
    description:
      "Schedule a non-blocking wait for the given scoops. Returns immediately — the cone keeps its turn — and a `scoop-wait` lick is delivered when every listed scoop completes or the optional timeout fires. Use this to coordinate parallel work without freezing the cone: feed several scoops, call scoop_wait, then continue with other work; you'll be woken by the lick with all per-scoop summaries in one shot. Already-completed scoops (including those whose completion arrived while you were processing your previous turn) are folded into the same lick.",
    inputSchema: {
      type: 'object',
      properties: {
        scoop_names: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Folder or display names of scoops list_scoops shows you (e.g., ["writer-scoop", "reviewer-scoop"]).',
        },
        timeout_ms: {
          type: 'number',
          description:
            'Optional timeout in milliseconds. If any listed scoop has not completed by the deadline, it is reported as timed-out in the eventual `scoop-wait` lick. Omit for no timeout.',
        },
        [CROSS_CONE_PARAM]: crossConeSchema('wait on'),
      },
      required: ['scoop_names'],
    },
    execute: (input) => executeScoopWait(input, config),
  };
}

function lickConfirmTool(config: ScoopManagementToolsConfig): ToolDefinition {
  return {
    name: 'lick_confirm',
    description:
      "Confirm (approve) a pending actionable lick by its lick_id — currently a scoop sudo escalation raised via sudo_request. With always=true, the orchestrator additionally appends a NOPASSWD <directive> <pattern> rule to the requesting scoop's /etc/sudoers.d/scoop-<folder> drop-in so the same action won't prompt again. always=false (the default) is allow-once.",
    inputSchema: {
      type: 'object',
      properties: {
        lick_id: {
          type: 'string',
          description:
            'The id of the pending actionable lick (as delivered in the [sudo-request] notification, e.g. "lick-…"). Use list_sudo_requests to see outstanding ids.',
        },
        always: {
          type: 'boolean',
          description:
            "If true, persist a NOPASSWD rule into the requesting scoop's per-scoop sudoers so the action won't prompt again. Defaults to false (allow-once).",
        },
        pattern: {
          type: 'string',
          description:
            'Optional glob pattern to persist when always=true (e.g., "git push*" or "/workspace/.git/**"). Defaults to the request\'s suggestedPattern, then to the exact detail. Ignored when always=false.',
        },
        reason: {
          type: 'string',
          description:
            'Optional note for the requester — a caveat on the approval. Only reaches a scoop that asked via sudo_request; an implicit filesystem gate has no channel to report it on success. Truncated at 300 characters.',
        },
      },
      required: ['lick_id'],
    },
    execute: (input) => executeLickConfirm(input, config),
  };
}

function lickDismissTool(config: ScoopManagementToolsConfig): ToolDefinition {
  return {
    name: 'lick_dismiss',
    description:
      'Dismiss a pending actionable lick by its lick_id. For scoop sudo escalation this denies the sensitive action — pass a reason, or the scoop just retries. For llms.txt discovery this silently appends the advertising host to /etc/llmstxtignore.',
    inputSchema: {
      type: 'object',
      properties: {
        lick_id: {
          type: 'string',
          description:
            'The id of the pending actionable lick (as delivered in a sudo-request or llms.txt discovery notification).',
        },
        reason: {
          type: 'string',
          description:
            'Why you are refusing, in one sentence; the scoop sees it verbatim. Always give one for a sudo denial — without it the scoop cannot tell refusal from misunderstanding, and retries or works around it. Truncated at 300 characters.',
        },
      },
      required: ['lick_id'],
    },
    execute: (input) => executeLickDismiss(input, config),
  };
}

function listSudoRequestsTool(config: ScoopManagementToolsConfig): ToolDefinition {
  return {
    name: 'list_sudo_requests',
    description:
      'List all pending cone-mediated sudo requests (lick id, requesting scoop, kind, detail). Use to find a lick_id for lick_confirm / lick_dismiss.',
    inputSchema: { type: 'object', properties: {} },
    execute: () => executeListSudoRequests(config),
  };
}

function updateGlobalMemoryTool(config: ScoopManagementToolsConfig): ToolDefinition {
  return {
    name: 'update_global_memory',
    description:
      'Update the global CLAUDE.md memory file that is shared across all scoops. Use this instead of write_file for /shared/CLAUDE.md.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The new content for the global memory file' },
      },
      required: ['content'],
    },
    execute: (input) => executeUpdateGlobalMemory(input, config),
  };
}

export function createScoopManagementTools(config: ScoopManagementToolsConfig): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const policy = derivePolicy(config.scoop);
  const isRoot = isRootUnit(config.scoop);

  if (!isRoot) {
    tools.push(sendMessageTool(config));
    if (config.onSudoRequest) tools.push(sudoRequestTool(config));
  }

  if (policy.canCreateChildren && config.onScoopScoop) {
    tools.push(scoopScoopTool(config));
  }
  if (policy.canManageChildren) {
    if (config.onFeedScoop) tools.push(feedScoopTool(config));
    tools.push(listScoopsTool(config));
    if (config.onDropScoop) tools.push(dropScoopTool(config));
    if (config.onMuteScoops) tools.push(scoopMuteTool(config));
    if (config.onUnmuteScoops) tools.push(scoopUnmuteTool(config));
    if (config.onScheduleScoopWait) tools.push(scoopWaitTool(config));
    if (config.onSudoResolve) {
      tools.push(lickConfirmTool(config));
      tools.push(lickDismissTool(config));
    }
    if (config.onListSudoRequests) tools.push(listSudoRequestsTool(config));
    if (config.onSetGlobalMemory && config.getGlobalMemory) {
      tools.push(updateGlobalMemoryTool(config));
    }
  }

  return tools;
}
