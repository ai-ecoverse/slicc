export type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentOptions,
  AgentState,
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
  StreamFn,
  ThinkingLevel,
} from '@earendil-works/pi-agent-core';
export { Agent, agentLoop, agentLoopContinue } from '@earendil-works/pi-agent-core';
export type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  Message,
  Model,
  SimpleStreamOptions,
  StopReason,
  StreamOptions,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from '@earendil-works/pi-ai';
export {
  EventStream,
  registerApiProvider,
  stream,
  streamSimple,
} from '@earendil-works/pi-ai/compat';
export type { Logger } from '../base/logger.js';
export { createLogger, getLogLevel, LogLevel, setLogLevel } from '../base/logger.js';

export type { ToolDefinition, ToolInputSchema, ToolResult } from '../tools/types.js';
export type { MessageAttachment, MessageAttachmentKind } from './attachments.js';
export {
  formatAttachmentForPrompt,
  formatAttachmentSize,
  formatAttachmentSummary,
  formatPromptWithAttachments,
  imageContentFromAttachments,
  stripLocalPathsForRemote,
} from './attachments.js';
export type { CompactionConfig } from './context-compaction.js';
export { compactContext, createCompactContext } from './context-compaction.js';
export { getMimeType } from './mime-types.js';

export { getModel, getModels, getProviders } from './model-catalog.js';
export {
  getIdentityToolResultScrubber,
  getToolResultScrubber,
  type ToolResultScrubber,
} from './secret-scrub.js';

export { SessionStore } from './session.js';
export type { ToolAdapterGateConfig, ToolCallGate } from './tool-adapter.js';
export {
  adaptTool,
  adaptTools,
  extractToolArg,
  type ToolAdapterProcessConfig,
  type ToolAdapterSecretsConfig,
} from './tool-adapter.js';

export type { AgentConfig, SessionData } from './types.js';
