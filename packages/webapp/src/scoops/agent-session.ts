/**
 * Pure decisions for resumable `agent` sessions.
 *
 * A session is one scoop kept alive across calls so the system prompt and
 * earlier turns stay a cache prefix. Idle sessions expire; `--resume` then
 * fails, while `--session` starts a new one under the same id.
 */

/** How long an unused session stays resumable. Longer than the 5-minute cache TTL. */
export const AGENT_SESSION_IDLE_MS = 30 * 60 * 1000;

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** Error text for a session id the CLI and the realm both reject. `null` when it is fine. */
export function sessionIdError(id: string): string | null {
  if (SESSION_ID.test(id)) return null;
  return `agent: invalid session id '${id}'`;
}

/** Fields that are part of the cached prefix. The prompt and images are not. */
export interface SessionFingerprintInput {
  cwd: string;
  allowedCommands: readonly string[];
  modelId?: string;
  modelProviderId?: string;
  thinkingLevel?: string;
  visiblePaths?: readonly string[];
  invokingCwd?: string;
  workspaceMode?: string;
  structuredOutputSchema?: unknown;
  escalate?: boolean;
  systemPrompt?: string;
  minimalSystemPrompt?: boolean;
  toolSurface?: string;
  backgroundAfterSeconds?: number;
  parentJid?: string;
  cacheStablePrompt?: boolean;
}

/**
 * Stable JSON of the cached prefix. `escalate: undefined` and `true` match
 * (the default is to escalate); only an explicit `false` differs.
 */
export function sessionFingerprint(input: SessionFingerprintInput): string {
  return JSON.stringify({
    cwd: input.cwd,
    allowedCommands: input.allowedCommands.map((command) => command.trim()).sort(),
    modelId: input.modelId ?? null,
    modelProviderId: input.modelProviderId ?? null,
    thinkingLevel: input.thinkingLevel ?? null,
    visiblePaths: input.visiblePaths ? [...input.visiblePaths] : null,
    invokingCwd: input.invokingCwd ?? null,
    workspaceMode: input.workspaceMode ?? null,
    structuredOutputSchema: input.structuredOutputSchema ?? null,
    escalate: input.escalate !== false,
    systemPrompt: input.systemPrompt ?? null,
    minimalSystemPrompt: input.minimalSystemPrompt === true,
    toolSurface: input.toolSurface ?? null,
    backgroundAfterSeconds: input.backgroundAfterSeconds ?? null,
    parentJid: input.parentJid ?? null,
    cacheStablePrompt: input.cacheStablePrompt === true,
  });
}

export function sessionExpired(lastUsed: number, now: number): boolean {
  return now - lastUsed > AGENT_SESSION_IDLE_MS;
}

export interface SessionSnapshot {
  fingerprint: string;
  lastUsed: number;
  busy: boolean;
}

/**
 * What `spawn` should do with a named session.
 *
 * `drop` means the stored scoop is idle-expired and must be unregistered
 * before the caller continues. `create` after a drop is `--session` starting
 * over; `--resume` (`resumeOnly`) reports the expiry instead.
 */
export type SessionAction =
  | { action: 'create'; drop: boolean }
  | { action: 'resume' }
  | { action: 'error'; exitCode: number; finalText: string };

export function classifySession(
  existing: SessionSnapshot | undefined,
  fingerprint: string,
  now: number,
  resumeOnly: boolean,
  id: string
): SessionAction {
  if (!existing) {
    if (resumeOnly) {
      return { action: 'error', exitCode: 2, finalText: `agent: session not found: ${id}` };
    }
    return { action: 'create', drop: false };
  }
  if (sessionExpired(existing.lastUsed, now)) {
    if (resumeOnly) {
      return { action: 'error', exitCode: 2, finalText: `agent: session expired: ${id}` };
    }
    return { action: 'create', drop: true };
  }
  if (existing.busy) {
    return {
      action: 'error',
      exitCode: 1,
      finalText: `agent: session ${id} is already running`,
    };
  }
  if (existing.fingerprint !== fingerprint) {
    return {
      action: 'error',
      exitCode: 1,
      finalText: `agent: session ${id} does not match this call`,
    };
  }
  return { action: 'resume' };
}

/**
 * User-message preamble for a cache-stable spawn. The scratch folder is
 * unique per scoop, so it stays out of the system prompt: that prompt and
 * the tool list are the prefix later calls read back.
 */
export function cacheStableUserPrompt(prompt: string, cwd: string, scratchFolder: string): string {
  return `Working directory: ${cwd}\nPrivate scratch directory: ${scratchFolder}\n\n${prompt}`;
}

export interface AgentCallUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

interface UsageMessage {
  role: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost?: { total: number };
  };
}

/** Sum assistant-turn usage added at or after `start` (a message index). */
export function sumAssistantUsage(
  messages: readonly UsageMessage[],
  start: number
): AgentCallUsage {
  const usage: AgentCallUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const message of messages.slice(start)) {
    if (message.role !== 'assistant' || !message.usage) continue;
    usage.input += message.usage.input;
    usage.output += message.usage.output;
    usage.cacheRead += message.usage.cacheRead;
    usage.cacheWrite += message.usage.cacheWrite;
    usage.cost += message.usage.cost?.total ?? 0;
  }
  return usage;
}
