/**
 * Types for cone/scoops multi-agent management in SLICC.
 *
 * The "cone" is the main orchestrator context. Each "scoop" is an
 * isolated conversation context with its own agent instance, tools,
 * and restricted filesystem access.
 */

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
   * Bash command allow-list. When set, the scoop's bash tool is wrapped with
   * {@link ../tools/bash-tool-allowlist.ts `wrapBashToolWithAllowlist`} so
   * that each bash invocation is rejected unless its head (and the head of
   * every pipeline/conjunction/sequence segment) is on this list. A list
   * containing `'*'` disables the wrapper (passthrough). Only set by the
   * `agent` supplemental command via {@link ../scoops/agent-bridge.ts `AgentBridge`}.
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
