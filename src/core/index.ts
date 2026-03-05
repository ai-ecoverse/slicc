// Re-export from pi-mono packages
export { Agent } from '@mariozechner/pi-agent-core';
export type { AgentOptions } from '@mariozechner/pi-agent-core';
export { agentLoop, agentLoopContinue } from '@mariozechner/pi-agent-core';
export type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
  AgentContext,
  AgentState,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  StreamFn,
  ThinkingLevel,
} from '@mariozechner/pi-agent-core';

export { EventStream, stream, streamSimple, getModel, getModels, getProviders } from '@mariozechner/pi-ai';
export type {
  TextContent,
  ThinkingContent,
  ImageContent,
  ToolCall,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  Message,
  StopReason,
  Usage,
  Tool,
  Context,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
  StreamOptions,
  SimpleStreamOptions,
} from '@mariozechner/pi-ai';

// Local utilities
export { SessionStore } from './session.js';
export { adaptTool, adaptTools } from './tool-adapter.js';
export { ToolRegistry } from './tool-registry.js';
export { createLogger, setLogLevel, getLogLevel, LogLevel } from './logger.js';
export type { Logger } from './logger.js';
export { compactContext, MAX_RESULT_CHARS, MAX_CONTEXT_CHARS } from './context-compaction.js';

// Local types
export type {
  AgentConfig,
  SessionData,
  ToolDefinition,
  ToolResult,
  ToolInputSchema,
} from './types.js';
