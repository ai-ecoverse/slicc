export interface TextContent {
  type: 'text';
  text: string;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
}

export interface ImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface ToolCall {
  type: 'toolCall';
  id: string;
  name: string;

  // biome-ignore lint/plugin: per-tool argument bag, shape declared by the tool's schema.
  arguments: Record<string, unknown>;
}

export type StopReason =
  | 'stop'
  | 'length'
  | 'toolUse'
  | 'error'
  | 'aborted'
  | 'pending'
  | 'deferred';

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface UserMessage {
  role: 'user';
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: 'assistant';
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: string;
  provider: string;
  model: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: unknown;
  isError: boolean;
  timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

import type { AgentMessage } from '@earendil-works/pi-agent-core';

export type { AgentMessage };

import type { ToolInputSchema } from '../tools/types.js';

export interface Tool {
  name: string;
  description: string;
  parameters: ToolInputSchema;
}

export interface AgentToolResult<T = unknown> {
  content: (TextContent | ImageContent)[];
  details: T;
}

export type AgentToolUpdateCallback<T = unknown> = (partialResult: AgentToolResult<T>) => void;

export interface AgentTool<TDetails = unknown> extends Tool {
  label: string;
  execute: (
    toolCallId: string,

    // biome-ignore lint/plugin: per-tool argument bag, shape declared by the tool's schema.
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>
  ) => Promise<AgentToolResult<TDetails>>;
}

export interface AgentContext {
  systemPrompt: string;
  messages: AgentMessage[];
  tools?: AgentTool[];
}

export interface LlmContext {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}

export interface AgentState {
  systemPrompt: string;
  model: string;
  tools: AgentTool[];
  messages: AgentMessage[];
  isStreaming: boolean;
  streamingMessage: AgentMessage | null;
  pendingToolCalls: ReadonlySet<string>;
  errorMessage?: string;
}

export type AssistantMessageEvent =
  | { type: 'start'; partial: AssistantMessage }
  | { type: 'text_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'text_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'text_end'; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: 'thinking_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'thinking_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'thinking_end'; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: 'toolcall_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'toolcall_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'toolcall_end'; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: 'done'; reason: 'stop' | 'length' | 'toolUse' | 'deferred'; message: AssistantMessage }
  | { type: 'error'; reason: 'aborted' | 'error'; error: AssistantMessage };

export type AgentEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: AgentMessage[] }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: 'message_start'; message: AgentMessage }
  | { type: 'message_update'; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: 'message_end'; message: AgentMessage }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | {
      type: 'tool_execution_update';
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: unknown;
    }
  | {
      type: 'tool_execution_end';
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    };

export type AgentEventListener = (event: AgentEvent) => void;

export type StreamFn = (context: LlmContext, options: StreamOptions) => AssistantMessageEventStream;

export interface StreamOptions {
  apiKey?: string;
  signal?: AbortSignal;
  model: string;

  azureResource?: string;
}

export interface AssistantMessageEventStream extends AsyncIterable<AssistantMessageEvent> {
  result(): Promise<AssistantMessage>;
}

export interface AgentLoopConfig {
  model: string;
  streamFn: StreamFn;
  apiKey?: string;
  azureResource?: string;

  convertToLlm: (messages: AgentMessage[]) => Message[];

  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

  getApiKey?: () => Promise<string | undefined> | string | undefined;

  getSteeringMessages?: () => Promise<AgentMessage[]>;

  getFollowUpMessages?: () => Promise<AgentMessage[]>;
}

export interface AgentConfig {
  apiKey: string;

  model?: string;

  maxTokens?: number;

  systemPrompt?: string;

  temperature?: number;

  azureResource?: string;
}

export interface SessionData {
  id: string;
  messages: AgentMessage[];
  config: Omit<AgentConfig, 'apiKey'>;
  createdAt: number;
  updatedAt: number;
}
