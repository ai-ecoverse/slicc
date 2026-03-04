/**
 * Groups module - NanoClaw-style multi-group management for SLICC.
 */

export type {
  RegisteredGroup,
  ChannelMessage,
  ScheduledTask,
  GroupTabState,
  GroupConfig,
  OrchestratorToGroupMessage,
  GroupToOrchestratorMessage,
} from './types.js';
export { DEFAULT_ASSISTANT_CONFIG } from './types.js';
export * from './db.js';
export { Orchestrator, type OrchestratorCallbacks, type AssistantConfig } from './orchestrator.js';
export { GroupContext, type GroupContextCallbacks } from './group-context.js';
