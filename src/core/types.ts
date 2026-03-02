/**
 * Core types for the agent system — pi-mono compatible.
 *
 * These types mirror @mariozechner/pi-ai and @mariozechner/agent
 * but are self-contained for browser use without those packages.
 */

// ─── Content Types ──────────────────────────────────────────────────────────

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
  data: string; // base64
  mimeType: string;
}

export interface ToolCall {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, any>;
}

// ─── Message Types ──────────────────────────────────────────────────────────

export type StopReason = 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';

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

/**
 * AgentMessage: extensible union of LLM messages.
 * For now, same as Message. Apps can extend with custom types.
 */
export type AgentMessage = Message;

// ─── Tool Types ─────────────────────────────────────────────────────────────

/** JSON Schema for tool input parameters. */
export interface ToolInputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
}

/** Base tool definition (schema only, no execute). */
export interface Tool {
  name: string;
  description: string;
  parameters: ToolInputSchema;
}

/** Result from an AgentTool execution. */
export interface AgentToolResult<T = unknown> {
  content: (TextContent | ImageContent)[];
  details: T;
}

/** Callback for streaming tool execution updates. */
export type AgentToolUpdateCallback<T = unknown> = (partialResult: AgentToolResult<T>) => void;

/**
 * AgentTool — pi-compatible tool with execute function.
 *
 * This is the tool interface used by the agent loop.
 * Tools receive toolCallId, validated params, abort signal, and update callback.
 */
export interface AgentTool<TDetails = unknown> extends Tool {
  label: string;
  execute: (
    toolCallId: string,
    params: Record<string, any>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
}

// ─── Context ────────────────────────────────────────────────────────────────

/** Agent context passed to the loop. */
export interface AgentContext {
  systemPrompt: string;
  messages: AgentMessage[];
  tools?: AgentTool[];
}

/** LLM context (messages converted for the provider). */
export interface LlmContext {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}

// ─── Agent State ────────────────────────────────────────────────────────────

export interface AgentState {
  systemPrompt: string;
  model: string;
  tools: AgentTool[];
  messages: AgentMessage[];
  isStreaming: boolean;
  streamMessage: AgentMessage | null;
  pendingToolCalls: Set<string>;
  error?: string;
}

// ─── Agent Events ───────────────────────────────────────────────────────────

/** Streaming events from the LLM provider. */
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
  | { type: 'done'; reason: 'stop' | 'length' | 'toolUse'; message: AssistantMessage }
  | { type: 'error'; reason: 'aborted' | 'error'; error: AssistantMessage };

/** Events emitted by the agent loop. */
export type AgentEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: AgentMessage[] }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: 'message_start'; message: AgentMessage }
  | { type: 'message_update'; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: 'message_end'; message: AgentMessage }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_update'; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: unknown; isError: boolean };

/** Callback for agent events. */
export type AgentEventListener = (event: AgentEvent) => void;

// ─── Agent Loop Config ──────────────────────────────────────────────────────

/** Stream function type — called to get LLM streaming response. */
export type StreamFn = (
  context: LlmContext,
  options: StreamOptions,
) => AssistantMessageEventStream;

/** Options passed to the stream function. */
export interface StreamOptions {
  apiKey?: string;
  signal?: AbortSignal;
  model: string;
}

/** Async iterable stream of AssistantMessageEvents with result promise. */
export interface AssistantMessageEventStream extends AsyncIterable<AssistantMessageEvent> {
  result(): Promise<AssistantMessage>;
}

/** Configuration for the agent loop. */
export interface AgentLoopConfig {
  model: string;
  streamFn: StreamFn;
  apiKey?: string;

  /** Convert AgentMessage[] to LLM-compatible Message[]. */
  convertToLlm: (messages: AgentMessage[]) => Message[];

  /** Optional context transform before convertToLlm. */
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

  /** Resolve API key dynamically. */
  getApiKey?: () => Promise<string | undefined> | string | undefined;

  /** Return steering messages (mid-run interruptions). */
  getSteeringMessages?: () => Promise<AgentMessage[]>;

  /** Return follow-up messages (post-completion). */
  getFollowUpMessages?: () => Promise<AgentMessage[]>;
}

// ─── Agent Config (public API) ──────────────────────────────────────────────

/** Agent configuration. */
export interface AgentConfig {
  /** Anthropic API key. */
  apiKey: string;
  /** Model ID. Default: claude-opus-4-6 */
  model?: string;
  /** Maximum tokens per response. Default: 8192 */
  maxTokens?: number;
  /** System prompt. */
  systemPrompt?: string;
  /** Temperature. Default: 0 */
  temperature?: number;
}

// ─── Session Persistence ────────────────────────────────────────────────────

/** Serializable session data for IndexedDB persistence. */
export interface SessionData {
  id: string;
  messages: AgentMessage[];
  config: Omit<AgentConfig, 'apiKey'>;
  createdAt: number;
  updatedAt: number;
}

// ─── Legacy compat re-exports ───────────────────────────────────────────────
// (tools still import ToolDefinition and ToolResult — keep them working)

/**
 * Legacy tool definition for backwards compatibility with existing tools.
 * Used by src/tools/ factories. The tool adapter converts these to AgentTool.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  execute(input: Record<string, unknown>): Promise<ToolResult>;
}

/** Legacy tool result. */
export interface ToolResult {
  content: string;
  isError?: boolean;
}
