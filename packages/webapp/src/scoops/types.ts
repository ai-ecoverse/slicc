/**
 * Types for cone/scoops multi-agent management in SLICC.
 *
 * The "cone" is the main orchestrator context. Each "scoop" is an
 * isolated conversation context with its own agent instance, tools,
 * and restricted filesystem access.
 */

/**
 * Current `ScoopConfig` schema generation. Bumped whenever a new field is
 * introduced that demands a compat backfill for records saved before it
 * existed. Scoops created today are stamped with this value; the orchestrator
 * runs one-shot migrations for any record whose version is strictly lower
 * and never touches records already at the current version.
 *
 * - `1`: `visiblePaths` is authoritative (may be an explicit empty list).
 */
export const CURRENT_SCOOP_CONFIG_VERSION = 1;

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
   * VFS paths this scoop can READ (but not write). Pure replace — when
   * `undefined` the scoop gets no read-only paths at all. The `scoop_scoop`
   * tool injects the standard `['/workspace/']` default when creating scoops
   * so existing agent-facing behavior is preserved. Cone scoops ignore this
   * field — they always use an unrestricted filesystem.
   */
  visiblePaths?: readonly string[];
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
