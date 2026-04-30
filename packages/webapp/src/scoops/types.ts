/**
 * Types for cone/scoops multi-agent management in SLICC.
 *
 * The "cone" is the main orchestrator context. Each "scoop" is an
 * isolated conversation context with its own agent instance, tools,
 * and restricted filesystem access.
 */

import type { MessageAttachment } from '../core/attachments.js';
import type { ThinkingLevel } from '@mariozechner/pi-agent-core';

export type { ThinkingLevel };

/**
 * Click-cycle order for the chat panel's brain icon. The full
 * {@link ThinkingLevel} enum (`off | minimal | low | medium | high | xhigh`)
 * remains valid for programmatic / shell-flag callers; the UI only steps
 * through this 4-bucket subset for clarity. `xhigh` is silently skipped to
 * `off` when the active model doesn't support it (see `supportsXhigh()` in
 * `@mariozechner/pi-ai`).
 */
export const THINKING_LEVEL_CYCLE: readonly ThinkingLevel[] = [
  'off',
  'low',
  'high',
  'xhigh',
] as const;

/** Full enumeration accepted by the `agent --thinking` flag and tools. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const;

/** Type guard: is `value` a valid {@link ThinkingLevel}? */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Current `ScoopConfig` schema generation. Bumped whenever a new field is
 * introduced that demands a compat backfill for records saved before it
 * existed. Scoops created today are stamped with this value; the orchestrator
 * runs one-shot migrations for any record whose version is strictly lower
 * and never touches records already at the current version.
 *
 * - `1`: `visiblePaths` is authoritative (may be an explicit empty list).
 * - `2`: `writablePaths` is authoritative (may be an explicit empty list).
 */
export const CURRENT_SCOOP_CONFIG_VERSION = 2;

/** Registered scoop metadata */
export interface RegisteredScoop {
  /** Unique identifier */
  jid: string;
  /** Human-readable name */
  name: string;
  /** Storage folder name (sanitized, e.g. "andy-scoop") */
  folder: string;
  /** Whether this is the cone (main context) */
  isCone: boolean;
  /** Type discriminator */
  type: 'cone' | 'scoop';
  /** Trigger pattern (e.g., "@andy-scoop") */
  trigger?: string;
  /** Whether trigger is required */
  requiresTrigger: boolean;
  /** Assistant label for display (e.g., "sliccy" for cone, "andy-scoop" for scoops) */
  assistantLabel: string;
  /** ISO timestamp when added */
  addedAt: string;
  /** Scoop-specific config */
  config?: ScoopConfig;
  /**
   * Generation of `ScoopConfig` that produced this record. `undefined` means
   * "truly legacy" — a record saved before any of the path-config fields
   * existed. The orchestrator migrates up to {@link CURRENT_SCOOP_CONFIG_VERSION}
   * on restore; records already at the current version are left alone so
   * explicit `undefined`/empty values stay authoritative.
   */
  configSchemaVersion?: number;
  /**
   * When `false`, suppresses the orchestrator's cone-notify side effect
   * that fires when this scoop reaches the terminal `ready` status after
   * processing a prompt. Default (`undefined` / `true`) preserves the
   * default behavior: the cone receives a `scoop-notify` message with a
   * VFS path to the scoop's full output, a 1000-character preview, and
   * the total line count, triggering a cone turn.
   *
   * Set to `false` for ephemeral, self-contained invocations (e.g. scoops
   * spawned through the `agent` shell command) where the caller already
   * drains the scoop's output via an `observeScoop` subscription and does
   * NOT want the completion to bill an extra cone turn. Not persisted —
   * ephemeral scoops are unregistered at the end of their run.
   */
  notifyOnComplete?: boolean;
}

/** Per-scoop configuration */
export interface ScoopConfig {
  /** Custom system prompt addition */
  systemPromptAppend?: string;
  /** Agent timeout (ms) */
  timeout?: number;
  /** Assistant name override for this scoop */
  assistantName?: string;
  /** Model ID override (e.g., "claude-sonnet-4-20250514"). Uses globally selected model if not set. */
  modelId?: string;
  /**
   * Reasoning / thinking level forwarded to `pi-agent-core`'s
   * {@link import('@mariozechner/pi-agent-core').AgentState.thinkingLevel}.
   * One of `off | minimal | low | medium | high | xhigh`. When unset, the
   * scoop inherits its parent's level (or `off` for non-reasoning models).
   *
   * `xhigh` is silently clamped to `high` when the active model doesn't
   * advertise xhigh support — see `supportsXhigh()` from `@mariozechner/pi-ai`.
   * For non-reasoning models the value is ignored entirely.
   */
  thinkingLevel?: ThinkingLevel;
  /**
   * VFS paths this scoop can READ (but not write). Pure replace — when
   * `undefined` the scoop gets no read-only paths at all. The `scoop_scoop`
   * tool injects the standard `['/workspace/']` default when creating scoops
   * so existing agent-facing behavior is preserved. Cone scoops ignore this
   * field — they always use an unrestricted filesystem.
   */
  visiblePaths?: readonly string[];
  /**
   * VFS paths this scoop can READ AND WRITE. Pure replace — when
   * `undefined` the scoop gets no writable paths at all. Read access is
   * the union of `writablePaths` and `visiblePaths` (RestrictedFS
   * surfaces both as readable); write access is limited to
   * `writablePaths`. The `scoop_scoop` tool injects the standard
   * `['/scoops/<folder>/', '/shared/']` default so existing agent-facing
   * behavior is preserved. Cone scoops ignore this field — they always
   * use an unrestricted filesystem.
   */
  writablePaths?: readonly string[];
  /**
   * Shell command allow-list. When omitted (or when it contains `'*'`), every
   * built-in, custom, and `.jsh` command is available — the default. Otherwise
   * only commands whose names appear in the list can execute inside this
   * scoop's shell, including through pipelines and substitution.
   */
  allowedCommands?: readonly string[];
}

/** Message from any channel */
export interface ChannelMessage {
  id: string;
  chatJid: string;
  senderId: string;
  senderName: string;
  content: string;
  attachments?: MessageAttachment[];
  timestamp: string;
  fromAssistant: boolean;
  channel: string;
}

/** Scheduled task */
export interface ScheduledTask {
  id: string;
  groupFolder: string;
  prompt: string;
  scheduleType: 'cron' | 'interval' | 'once';
  scheduleValue: string;
  status: 'active' | 'paused' | 'completed';
  nextRun: string | null;
  lastRun: string | null;
  createdAt: string;
}

/** Scoop tab state */
export interface ScoopTabState {
  jid: string;
  contextId: string;
  status: 'initializing' | 'ready' | 'processing' | 'error';
  lastActivity: string;
  error?: string;
}

/** IPC messages between orchestrator and scoops */
export type OrchestratorToScoopMessage =
  | { type: 'init'; scoopJid: string; scoop: RegisteredScoop }
  | { type: 'prompt'; text: string; senderId: string; senderName: string }
  | { type: 'shutdown' };

export type ScoopToOrchestratorMessage =
  | { type: 'ready'; scoopJid: string }
  | { type: 'response'; text: string; isPartial: boolean }
  | { type: 'response_done' }
  | { type: 'error'; message: string }
  | { type: 'status'; status: ScoopTabState['status'] }
  | { type: 'send_message'; targetJid: string; text: string }
  | { type: 'task_create'; task: Omit<ScheduledTask, 'id' | 'createdAt'> };

/** Configuration for the assistant */
export interface AssistantConfig {
  name: string;
  triggerPattern: RegExp;
}

export const DEFAULT_ASSISTANT_CONFIG: AssistantConfig = {
  name: 'sliccy',
  triggerPattern: /^@sliccy\b/i,
};
