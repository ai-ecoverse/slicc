/**
 * Scoop management tools - MCP-style tools for messaging and scoop management.
 *
 * These provide the same functionality as NanoClaw's IPC-based MCP server,
 * but implemented as direct agent tools.
 */

import { createLogger } from '../core/logger.js';
import type { ToolDefinition } from '../core/types.js';
import type { SudoDecision, SudoKind, SudoRequest } from '../sudo/types.js';
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
  /** Feed a prompt to a specific scoop (cone only). */
  onFeedScoop?: (scoopJid: string, prompt: string) => Promise<void>;
  getScoops: () => RegisteredScoop[];
  /** Get tab state for a scoop by JID (status, lastActivity). */
  getScoopTabState?: (jid: string) => import('./types.js').ScoopTabState | undefined;
  onScoopScoop?: (scoop: Omit<RegisteredScoop, 'jid'>) => Promise<RegisteredScoop>;
  onDropScoop?: (scoopJid: string) => Promise<void>;
  onSetGlobalMemory?: (content: string) => Promise<void>;
  getGlobalMemory?: () => Promise<string>;
  /** Mute a list of scoops so their completions are suppressed (cone only). */
  onMuteScoops?: (jids: readonly string[]) => void;
  /** Unmute scoops and return any stashed completions so the tool can
   *  fold them into its result instead of re-firing them as new lick
   *  events (cone only). */
  onUnmuteScoops?: (
    jids: readonly string[]
  ) => Promise<
    Array<{ jid: string; summary: string; timestamp: string; notificationPath: string | null }>
  >;
  /** Schedule a non-blocking wait for a list of scoops to complete.
   *  Returns synchronously; when the wait resolves (every listed scoop
   *  completes or the timeout fires) the orchestrator delivers a
   *  `scoop-wait` channel lick to the cone with the per-scoop summary.
   *  Cone only. */
  onScheduleScoopWait?: (
    jids: readonly string[],
    timeoutMs?: number
  ) => { scheduled: string[]; unknown: string[] };
  /** Scoop-only: ask the cone for an explicit sudo escalation. */
  onSudoRequest?: (request: SudoRequest) => Promise<SudoDecision>;
  /** Cone-only: resolve a pending sudo request by id. On `'always'` the
   *  orchestrator persists a NOPASSWD rule into the requesting scoop's
   *  `/scoops/<folder>/etc/sudoers` via the trusted manager sink. */
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
    /**
     * Verbatim result text for a non-sudo actionable lick (e.g. the
     * navigate·upskill resolver's `upskill` output). When present the
     * lick_confirm / lick_dismiss tool surfaces it instead of the
     * sudo-shaped summary.
     */
    message?: string;
  }>;
  /** Cone-only: snapshot all pending cone-mediated sudo requests. */
  onListSudoRequests?: () => Array<{
    id: string;
    scoopJid: string;
    request: SudoRequest;
  }>;
}

/** Resolve a list of user-supplied scoop names (folder or display name) to
 *  registered scoop records. Returns the resolved scoops plus any unknown
 *  names so the tool can surface a helpful error without bailing out on the
 *  first miss. Cones are rejected — they can't be muted / waited on. */
function resolveScoopNames(
  names: readonly string[],
  getScoops: () => RegisteredScoop[]
): { resolved: RegisteredScoop[]; unknown: string[] } {
  const all = getScoops();
  const resolved: RegisteredScoop[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    const s = all.find((x) => !x.isCone && (x.folder === name || x.name === name));
    if (s) resolved.push(s);
    else unknown.push(name);
  }
  return { resolved, unknown };
}

const SUDO_KINDS: readonly SudoKind[] = ['command', 'read', 'write', 'secret'];

/** Build a folder slug from a display name. Matches the legacy inline impl. */
function folderFromDisplayName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) + '-scoop'
  );
}

/** Validate a thinking level input or return an error result. */
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

/** Render a "scoop not found" error including the available list. */
function notFoundError(name: string, getScoops: () => RegisteredScoop[]) {
  const available = getScoops()
    .filter((s) => !s.isCone)
    .map((s) => s.folder)
    .join(', ');
  return { content: `Scoop "${name}" not found. Available: ${available}`, isError: true as const };
}

/** Format a single line in the list_scoops output. */
function formatScoopLine(
  s: RegisteredScoop,
  getScoopTabState: ScoopManagementToolsConfig['getScoopTabState']
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
  if (s.isCone) return `- ${s.assistantLabel} (${s.folder}) [CONE]${statusSuffix}`;
  return `- ${s.name} (${s.folder})${statusSuffix}`;
}

type ToolResult = { content: string; isError?: boolean };

// ---------- execute handlers (extracted from inline tool defs) ----------

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
  } = input as { kind: string; detail: string; suggested_pattern?: string };
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
  const request: SudoRequest = {
    kind: kind as SudoKind,
    detail,
    ...(suggestedPattern ? { suggestedPattern } : {}),
  };
  return { ok: true, request };
}

function formatSudoDecision(decision: SudoDecision): string {
  const lines = [`Cone decision: ${decision.decision}.`];
  if (decision.decision === 'always' && decision.pattern) {
    lines.push(`Persisted pattern: ${decision.pattern}`);
  }
  if (decision.decision === 'deny') {
    lines.push(
      'The sensitive action was not approved. Do not retry without addressing the reason for refusal.'
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
  const { scoop_name, prompt } = input as { scoop_name: string; prompt: string };
  const target = config.getScoops().find((s) => s.folder === scoop_name || s.name === scoop_name);
  if (!target) return notFoundError(scoop_name, config.getScoops);
  if (target.isCone) return { content: 'Cannot feed the cone (yourself).', isError: true };
  try {
    await config.onFeedScoop!(target.jid, prompt);
    log.info('Fed scoop', { target: target.folder, promptLength: prompt.length });
    return {
      content: `Task sent to ${target.folder}. You will be notified when it completes.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Failed to feed scoop: ${msg}`, isError: true };
  }
}

async function executeListScoops(config: ScoopManagementToolsConfig): Promise<ToolResult> {
  const scoops = config.getScoops();
  if (scoops.length === 0) return { content: 'No scoops registered.' };
  const formatted = scoops.map((s) => formatScoopLine(s, config.getScoopTabState)).join('\n');
  return { content: `Registered scoops:\n${formatted}` };
}

/** Build the partial `RegisteredScoop` record passed to onScoopScoop. */
function buildScoopRecord(
  name: string,
  folder: string,
  model: string | undefined,
  visiblePaths: string[] | undefined,
  writablePaths: string[] | undefined,
  allowedCommands: string[] | undefined,
  thinkingLevel: ThinkingLevel | undefined,
  /** JID of the scoop (cone) that invoked scoop_scoop; recorded for delegation-chain reconstruction. */
  parentJid: string
): Omit<RegisteredScoop, 'jid'> {
  return {
    name,
    folder,
    trigger: `@${folder}`,
    isCone: false,
    type: 'scoop',
    requiresTrigger: true,
    assistantLabel: folder,
    addedAt: new Date().toISOString(),
    config: {
      ...(model ? { modelId: model } : {}),
      visiblePaths: visiblePaths ?? ['/workspace/'],
      writablePaths: writablePaths ?? [`/scoops/${folder}/`, '/shared/'],
      ...(allowedCommands ? { allowedCommands } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    },
    configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
    // Record the creating scoop's JID. originToolCallId is intentionally absent:
    // ToolDefinition.execute does not receive the tool-call ID.
    parentJid,
  };
}

/** Try the auto-feed step after a scoop has been created. */
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
    allowedCommands,
    thinking,
  } = input as {
    name: string;
    model?: string;
    prompt?: string;
    visiblePaths?: string[];
    writablePaths?: string[];
    allowedCommands?: string[];
    thinking?: string;
  };

  const parsed = parseThinkingLevel(thinking);
  if (!parsed.ok) return { content: parsed.content, isError: parsed.isError };

  const folder = folderFromDisplayName(name);
  try {
    const record = buildScoopRecord(
      name,
      folder,
      model,
      visiblePaths,
      writablePaths,
      allowedCommands,
      parsed.level,
      config.scoop.jid
    );
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
  const { scoop_name } = input as { scoop_name: string };
  const target = config.getScoops().find((s) => s.folder === scoop_name || s.name === scoop_name);
  if (!target) return notFoundError(scoop_name, config.getScoops);
  if (target.isCone) return { content: 'Cannot drop the cone (yourself).', isError: true };
  try {
    await config.onDropScoop!(target.jid);
    log.info('Scoop dropped', { name: target.name, folder: target.folder });
    return { content: `Scoop "${target.name}" (${target.folder}) has been dropped.` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Failed to drop scoop: ${msg}`, isError: true };
  }
}

function emptyNamesError(): ToolResult {
  return { content: 'scoop_names must be a non-empty array.', isError: true };
}

function noMatchingScoopsError(unknownNames: readonly string[]): ToolResult {
  return {
    content: `No matching scoops found. Unknown: ${unknownNames.join(', ')}`,
    isError: true,
  };
}

async function executeMuteScoops(
  input: unknown,
  config: ScoopManagementToolsConfig
): Promise<ToolResult> {
  const { scoop_names } = input as { scoop_names: string[] };
  if (!Array.isArray(scoop_names) || scoop_names.length === 0) return emptyNamesError();
  const { resolved, unknown } = resolveScoopNames(scoop_names, config.getScoops);
  if (resolved.length === 0) return noMatchingScoopsError(unknown);
  config.onMuteScoops!(resolved.map((s) => s.jid));
  log.info('Scoops muted', { names: resolved.map((s) => s.folder) });
  const muted = resolved.map((s) => s.folder).join(', ');
  const warn = unknown.length > 0 ? ` (unknown: ${unknown.join(', ')})` : '';
  return { content: `Muted: ${muted}${warn}` };
}

/** Render the stashed-completion section for scoop_unmute output. */
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
  const { scoop_names } = input as { scoop_names: string[] };
  if (!Array.isArray(scoop_names) || scoop_names.length === 0) return emptyNamesError();
  const { resolved, unknown } = resolveScoopNames(scoop_names, config.getScoops);
  if (resolved.length === 0) return noMatchingScoopsError(unknown);
  const jids = resolved.map((s) => s.jid);
  const jidToFolder = new Map(resolved.map((s) => [s.jid, s.folder]));
  const consumed = await config.onUnmuteScoops!(jids);
  log.info('Scoops unmuted', {
    names: resolved.map((s) => s.folder),
    stashedCount: consumed.length,
  });
  const unmutedFolders = resolved.map((s) => s.folder).join(', ');
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

/** Format the success message for scoop_wait. */
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
  const { scoop_names, timeout_ms } = input as { scoop_names: string[]; timeout_ms?: number };
  const inputError = validateWaitInput(scoop_names, timeout_ms);
  if (inputError) return inputError;

  const { resolved, unknown } = resolveScoopNames(scoop_names, config.getScoops);
  if (resolved.length === 0) return noMatchingScoopsError(unknown);

  const jids = resolved.map((s) => s.jid);
  // Use the orchestrator's return value to build the acknowledgement: a
  // scoop can be dropped between name resolution and the schedule call.
  const ack = config.onScheduleScoopWait!(jids, timeout_ms);
  const jidToFolder = new Map(resolved.map((s) => [s.jid, s.folder]));
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

/** Format the result of lick_confirm once the orchestrator settles the request. */
function formatAllowOutcome(outcome: SudoOutcome, always: boolean): string {
  if (!always) {
    return 'Approved (once) — the current action proceeds; future ones will prompt again.';
  }
  if (outcome.persisted) {
    return `Approved (always) — persisted NOPASSWD rule for ${outcome.kind ?? 'unknown'} pattern "${outcome.persistedPattern}" in /scoops/${outcome.scoopFolder ?? '<unknown>'}/etc/sudoers.`;
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
  const { lick_id, always, pattern } = input as {
    lick_id: string;
    always?: boolean;
    pattern?: string;
  };
  if (typeof lick_id !== 'string' || lick_id.length === 0) {
    return { content: 'lick_id must be a non-empty string.', isError: true };
  }
  const decision: SudoDecision = always
    ? { decision: 'always', ...(pattern ? { pattern } : {}) }
    : { decision: 'allow' };
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
  const { lick_id } = input as { lick_id: string };
  if (typeof lick_id !== 'string' || lick_id.length === 0) {
    return { content: 'lick_id must be a non-empty string.', isError: true };
  }
  try {
    const outcome = await config.onSudoResolve!(lick_id, { decision: 'deny' });
    if (!outcome.settled) {
      return {
        content: `Lick "${lick_id}" is unknown, already resolved, or timed out.`,
        isError: true,
      };
    }
    log.info('Lick dismissed', { id: lick_id });
    if (outcome.message) return { content: outcome.message };
    return { content: 'Denied — the scoop will not run this action.' };
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
    return `- ${p.id} — ${folder} — ${p.request.kind}: ${p.request.detail}${suggested}`;
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

// ---------- tool definitions (object literals only) ----------

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
      "Ask the cone for an explicit sudo escalation before running a sensitive action. Use this when you know up-front that a command, read, or write will be gated and you want a clean approval round-trip instead of letting the gate fire mid-action. Resolves with the cone's decision (allow / always / deny). 'always' durably widens your sandbox by appending a NOPASSWD rule to /scoops/<folder>/etc/sudoers. 'deny' (or a timeout / dropped cone) resolves fail-closed.",
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
            'The scoop folder name (e.g., "test-scoop"). Use list_scoops to see available scoops.',
        },
        prompt: {
          type: 'string',
          description:
            'Complete, self-contained instructions for the scoop. Include ALL context — the scoop cannot see your conversation.',
        },
      },
      required: ['scoop_name', 'prompt'],
    },
    execute: (input) => executeFeedScoop(input, config),
  };
}

function listScoopsTool(config: ScoopManagementToolsConfig): ToolDefinition {
  return {
    name: 'list_scoops',
    description: 'List all registered scoops.',
    inputSchema: { type: 'object', properties: {} },
    execute: () => executeListScoops(config),
  };
}

function scoopScoopTool(config: ScoopManagementToolsConfig): ToolDefinition {
  return {
    name: 'scoop_scoop',
    description:
      'Create a new scoop. Optionally specify a model, a prompt, and per-scoop sandbox shape (visible/writable paths + command allow-list). If prompt is provided, the scoop starts working immediately after creation (no separate feed_scoop needed).',
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
            'VFS paths the scoop can READ (not write). Pure replace — what you set is what you get. Omit to use the default ["/workspace/"] which exposes the shared skills tree. Pass [] for no extra read-only paths. Note: the scoop\'s writablePaths are always readable too, so a true read-nothing sandbox also requires writablePaths: []. Mounts remain readable regardless. Trailing slash recommended (e.g. "/shared/data/").',
        },
        writablePaths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'VFS paths the scoop can READ AND WRITE. Pure replace. Omit to use the default ["/scoops/<folder>/", "/shared/"] which gives the scoop its own sandbox plus shared space. Pass [] to block all writes. Trailing slash recommended.',
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
            'The scoop folder name (e.g., "test-scoop"). Use list_scoops to see available scoops.',
        },
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
            'Folder or display names of scoops to wait for (e.g., ["writer-scoop", "reviewer-scoop"]).',
        },
        timeout_ms: {
          type: 'number',
          description:
            'Optional timeout in milliseconds. If any listed scoop has not completed by the deadline, it is reported as timed-out in the eventual `scoop-wait` lick. Omit for no timeout.',
        },
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
      "Confirm (approve) a pending actionable lick by its lick_id — currently a scoop sudo escalation raised via sudo_request. With always=true, the orchestrator additionally appends a NOPASSWD <directive> <pattern> rule to the requesting scoop's /scoops/<folder>/etc/sudoers so the same action won't prompt again. always=false (the default) is allow-once.",
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
      'Dismiss (refuse) a pending actionable lick by its lick_id — currently a scoop sudo escalation raised via sudo_request. The scoop receives a deny decision and the sensitive action does NOT run.',
    inputSchema: {
      type: 'object',
      properties: {
        lick_id: {
          type: 'string',
          description:
            'The id of the pending actionable lick (as delivered in the [sudo-request] notification). Use list_sudo_requests to see outstanding ids.',
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

/**
 * Create scoop-management tools for a scoop context.
 *
 * The set of tools surfaced depends on whether the context is a cone or a
 * sub-scoop and on which optional callbacks the caller wired. Each tool is
 * built by a small named factory above; the heavy `execute` logic lives in
 * top-level handler functions so this factory stays a flat list of
 * conditional pushes.
 */
export function createScoopManagementTools(config: ScoopManagementToolsConfig): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const isCone = config.scoop.isCone;

  // Scoop-only surface.
  if (!isCone) {
    tools.push(sendMessageTool(config));
    if (config.onSudoRequest) tools.push(sudoRequestTool(config));
  }

  // Cone-only surface.
  if (isCone) {
    if (config.onFeedScoop) tools.push(feedScoopTool(config));
    tools.push(listScoopsTool(config));
    if (config.onScoopScoop) tools.push(scoopScoopTool(config));
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
