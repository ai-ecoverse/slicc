/**
 * Types for NanoClaw-style group management in SLICC.
 * 
 * Each "group" is an isolated conversation context with its own:
 * - Browser iframe (sandboxed execution)
 * - IndexedDB storage (filesystem, sessions)
 * - Agent instance (tools, memory)
 */

/** Registered group metadata */
export interface RegisteredGroup {
  /** Unique identifier */
  jid: string;
  /** Human-readable name */
  name: string;
  /** Storage folder name (sanitized) */
  folder: string;
  /** Trigger pattern (e.g., "@Andy") */
  trigger?: string;
  /** Whether trigger is required */
  requiresTrigger: boolean;
  /** Whether this is the main/admin group */
  isMain: boolean;
  /** ISO timestamp when added */
  addedAt: string;
  /** Group-specific config */
  config?: GroupConfig;
}

/** Per-group configuration */
export interface GroupConfig {
  /** Custom system prompt addition */
  systemPromptAppend?: string;
  /** Agent timeout (ms) */
  timeout?: number;
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

/** Group tab/iframe state */
export interface GroupTabState {
  jid: string;
  iframeId: string;
  status: 'initializing' | 'ready' | 'processing' | 'error';
  lastActivity: string;
  error?: string;
}

/** IPC messages between orchestrator and group iframes */
export type OrchestratorToGroupMessage =
  | { type: 'init'; groupJid: string; group: RegisteredGroup }
  | { type: 'prompt'; text: string; senderId: string; senderName: string }
  | { type: 'shutdown' };

export type GroupToOrchestratorMessage =
  | { type: 'ready'; groupJid: string }
  | { type: 'response'; text: string; isPartial: boolean }
  | { type: 'response_done' }
  | { type: 'error'; message: string }
  | { type: 'status'; status: GroupTabState['status'] }
  | { type: 'send_message'; targetJid: string; text: string }
  | { type: 'task_create'; task: Omit<ScheduledTask, 'id' | 'createdAt'> };

/** Configuration for the assistant */
export interface AssistantConfig {
  name: string;
  triggerPattern: RegExp;
}

export const DEFAULT_ASSISTANT_CONFIG: AssistantConfig = {
  name: 'Andy',
  triggerPattern: /^@Andy\b/i,
};
