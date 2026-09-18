export type MessageAttachmentKind = 'image' | 'text' | 'file';

export interface MessageAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: MessageAttachmentKind;

  data?: string;

  text?: string;

  path?: string;

  error?: string;
}

export interface ChatMessageUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface ToolProgressEvent {
  id: string;

  label: string;

  fraction?: number;

  etaMs?: number;

  done?: number;
  total?: number;
  unit?: 'bytes' | 'iterations' | 'ms';
  phase: 'start' | 'update' | 'end';
}

export type AgentEvent =
  | { type: 'message_start'; messageId: string }
  | { type: 'content_delta'; messageId: string; text: string }
  | {
      type: 'content_done';
      messageId: string;
      model?: string;
      usage?: ChatMessageUsage;
    }
  | {
      type: 'tool_use_start';
      messageId: string;
      toolName: string;
      toolInput: unknown;

      toolCallId?: string;
    }
  | {
      type: 'tool_result';
      messageId: string;
      toolName: string;
      result: string;
      isError?: boolean;

      toolCallId?: string;
    }
  | { type: 'tool_ui'; messageId: string; toolName: string; requestId: string; html: string }
  | { type: 'tool_ui_done'; messageId: string; requestId: string }
  | {
      type: 'tool_progress';
      messageId: string;
      toolName: string;
      progress: ToolProgressEvent;

      toolCallId?: string;
    }
  | { type: 'turn_end'; messageId: string }
  | { type: 'compaction_notice'; messageId: string; marker: ChatCompactionMarker }
  | { type: 'error'; error: string; endTurn?: boolean }
  | { type: 'screenshot'; base64: string; url?: string }
  | { type: 'terminal_output'; text: string };

export type MessageRole = 'user' | 'assistant';

export type LickState = 'pending' | 'confirmed' | 'dismissed';

export type CompactionMarkerTrigger = 'threshold' | 'overflow' | 'idle';

export type CompactionMarkerState = 'summarizing' | 'summarized' | 'fallback' | 'discarded';

export interface ChatCompactionMarker {
  trigger: CompactionMarkerTrigger;
  state: CompactionMarkerState;

  transcriptPath?: string;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  attachments?: MessageAttachment[];
  toolCalls?: ToolCall[];
  isStreaming?: boolean;

  model?: string;

  usage?: ChatMessageUsage;

  source?: 'cone' | 'lick' | string;

  channel?: string;

  lickCount?: number;

  lickParts?: string[];

  lickId?: string;

  lickState?: LickState;

  queued?: boolean;

  compaction?: ChatCompactionMarker;

  error?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;

  _screenshotDataUrl?: string;

  _toolUIRequestId?: string;
}

export type DiscoveryKind = 'ai-catalog' | 'llms-txt';

export interface LickEvent {
  type:
    | 'webhook'
    | 'cron'
    | 'sprinkle'
    | 'fswatch'
    | 'session-reload'
    | 'navigate'
    | 'upgrade'
    | 'cherry'
    | 'workflow'
    | 'bash'
    | 'jshd'
    | 'sudo-request'
    | 'preview'
    | 'discovery';
  webhookId?: string;
  webhookName?: string;
  cronId?: string;
  cronName?: string;
  sprinkleName?: string;

  fswatchId?: string;
  fswatchName?: string;
  changes?: Array<{ type: string; path: string }>;

  navigateUrl?: string;

  upgradeFromVersion?: string;
  upgradeToVersion?: string;

  cherryName?: string;
  cherryRuntimeId?: string;
  cherryOrigin?: string;

  previewConnId?: string;
  previewOrigin?: string;
  previewToken?: string;
  previewUserAgent?: string;
  previewConnectedAt?: string;
  previewLifecycle?: 'connected' | 'disconnected';

  discoveryOrigin?: string;
  discoveryKind?: DiscoveryKind;
  discoveryUrl?: string;

  discoverySource?: 'live-navigation';

  lickId?: string;
  sudoKind?: string;
  sudoDetail?: string;
  sudoScoopName?: string;
  sudoSuggestedPattern?: string;

  sudoReason?: string;
  targetScoop?: string;

  originFollowerId?: string;
  originLabel?: string;

  workflowRunId?: string;
  workflowName?: string;

  bashJobId?: string;
  bashCommand?: string;
  bashExitCode?: number;

  bashJobPid?: number;

  jshdName?: string;
  jshdRestarts?: number;

  resultPath?: string;
  preview?: string;
  timestamp: string;
  headers?: Record<string, string>;
  body: unknown;
}
