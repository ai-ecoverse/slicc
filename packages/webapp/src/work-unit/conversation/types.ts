import type { LickChannel } from '../../base/lick-channels.js';
import type { MessageAttachment } from '../../core/attachments.js';
import type { AgentMessage } from '../../core/index.js';
import type { ChatCompactionMarker, ChatMessage } from '../../scoops/chat-types.js';

export const CONVERSATION_RECORD_VERSION = 2;

export function recordSchemaVersion(
  record: Pick<WorkUnitConversationRecord, 'markers' | 'projectionPrefix'>
): number {
  const hasErrorMarker = record.markers?.some((m) => m.kind === 'error') ?? false;
  const hasPrefix = (record.projectionPrefix?.length ?? 0) > 0;
  return hasErrorMarker || hasPrefix ? 2 : 1;
}

export type ConversationEntryKind =
  | 'user'
  | 'assistant'
  | 'tool-call'
  | 'tool-result'
  | 'external-event'
  | 'child-result';

interface ConversationEntryBase {
  id: string;

  seq: number;
  kind: ConversationEntryKind;

  timestamp: number;
}

interface MessageEntryBase extends ConversationEntryBase {
  message?: AgentMessage;
  chat?: ChatMessage;

  text: string;
}

export interface UserConversationEntry extends MessageEntryBase {
  kind: 'user';
}

export interface ExternalEventConversationEntry extends MessageEntryBase {
  kind: 'external-event';
  channel: LickChannel;
}

export interface ChildResultConversationEntry extends MessageEntryBase {
  kind: 'child-result';
  channel: LickChannel;
}

export interface AssistantConversationEntry extends MessageEntryBase {
  kind: 'assistant';
  model?: string;
}

export interface ToolCallConversationEntry extends ConversationEntryBase {
  kind: 'tool-call';
  toolCallId: string;
  name: string;
  assistantEntryId: string;
}

export interface ToolResultConversationEntry extends MessageEntryBase {
  kind: 'tool-result';
  toolCallId: string;
  isError?: boolean;
}

export interface CompactionConversationMarker {
  id: string;
  kind: 'compaction';

  timestamp: number;
  compaction: ChatCompactionMarker;
}

export interface ErrorConversationMarker {
  id: string;
  kind: 'error';
  timestamp: number;

  text: string;
}

export type ConversationMarker = CompactionConversationMarker | ErrorConversationMarker;

export interface ConversationAttachmentOverlay {
  id: string;

  timestamp: number;

  body: string;
  attachments: MessageAttachment[];
}

export type ConversationEntry =
  | UserConversationEntry
  | ExternalEventConversationEntry
  | ChildResultConversationEntry
  | AssistantConversationEntry
  | ToolCallConversationEntry
  | ToolResultConversationEntry;

export type ConversationOrigin = 'agent-history' | 'ui-projection';

export interface LegacyConversationKeys {
  agentSessionId: string;

  chatSessionId: string;
}

export interface WorkUnitConversationRecord {
  key: string;
  version: number;

  workUnitId: string;

  workspaceId: string;

  folder: string;
  origin: ConversationOrigin;
  entries: ConversationEntry[];

  markers?: ConversationMarker[];

  projectionPrefix?: ChatMessage[];

  attachments?: ConversationAttachmentOverlay[];
  createdAt: number;
  updatedAt: number;

  migratedFrom?: 'agent-sessions' | 'browser-coding-agent';

  rewrites?: number;
  legacyKeys: LegacyConversationKeys;
}

export function isReadableRecord(record: WorkUnitConversationRecord | null): boolean {
  return record !== null && record.version <= CONVERSATION_RECORD_VERSION;
}
