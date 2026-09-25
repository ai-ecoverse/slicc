import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { MessageAttachment } from '../core/attachments.js';
import type { TurnGuestGate } from '../sudo/types.js';

import type { JsonSchemaObject } from '../tools/types.js';
import type { WorkspaceIsolationMode } from '../work-unit/types.js';

export { isThinkingLevel, THINKING_LEVELS } from '../base/thinking-level.js';
export type { ThinkingLevel };

export const THINKING_LEVEL_CYCLE: readonly ThinkingLevel[] = [
  'off',
  'low',
  'high',
  'xhigh',
] as const;

export const CURRENT_SCOOP_CONFIG_VERSION = 3;

export interface WorkUnitModel {
  provider: string;

  id: string;
}

export interface WorkUnitThinking {
  level?: ThinkingLevel;

  effortOverride?: string;
}

export interface RegisteredScoop {
  jid: string;

  name: string;

  folder: string;

  trigger?: string;

  requiresTrigger: boolean;

  assistantLabel: string;

  addedAt: string;

  config?: ScoopConfig;

  approvesGuestRequests?: boolean;

  configSchemaVersion?: number;

  parentJid: string | null;

  model?: WorkUnitModel;

  thinking?: WorkUnitThinking;

  originToolCallId?: string;

  notifyOnComplete?: boolean;

  outcomeReceiptPath?: string;

  onParentClose?: 'cascade' | 'detach';
}

export interface ScoopConfig {
  systemPromptAppend?: string;

  timeout?: number;

  maxTurns?: number;

  maxWallClockMs?: number;

  backgroundAfterSeconds?: number;

  assistantName?: string;

  modelId?: string;

  modelProviderId?: string;

  thinkingLevel?: ThinkingLevel;

  effortOverride?: string;

  visiblePaths?: readonly string[];

  writablePaths?: readonly string[];

  workspaceMode?: WorkspaceIsolationMode;

  allowedCommands?: readonly string[];

  canCreateChildren?: boolean;

  structuredOutputSchema?: JsonSchemaObject;
}

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

  lickId?: string;

  lickState?: 'pending' | 'confirmed' | 'dismissed';

  steer?: boolean;

  guestGate?: TurnGuestGate;
}

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

export interface ScoopTabState {
  jid: string;
  contextId: string;
  status: 'initializing' | 'ready' | 'processing' | 'error';
  lastActivity: string;
  error?: string;
}

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

export interface AssistantConfig {
  name: string;
  triggerPattern: RegExp;
}

export const DEFAULT_ASSISTANT_CONFIG: AssistantConfig = {
  name: 'sliccy',
  triggerPattern: /^@sliccy\b/i,
};
