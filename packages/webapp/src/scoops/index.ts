/**
 * Scoops module - cone/scoops multi-agent management for SLICC.
 */

export * from './db.js';
export { Heartbeat, type HeartbeatCallbacks, type HeartbeatStatus } from './heartbeat.js';
export { type AssistantConfig, Orchestrator, type OrchestratorCallbacks } from './orchestrator.js';
export { type SchedulerCallbacks, TaskScheduler } from './scheduler.js';
export { ScoopContext, type ScoopContextCallbacks } from './scoop-context.js';
export {
  createScoopManagementTools,
  type ScoopManagementToolsConfig,
} from './scoop-management-tools.js';
export {
  createDefaultSkills,
  formatSkillsForPrompt,
  loadSkills,
  type Skill,
  type SkillMetadata,
} from './skills.js';
export {
  attachTrayFollower,
  type FollowerAttachOptions,
  type FollowerAttachPlan,
  type FollowerBootstrapOptions,
  type FollowerBootstrapPlan,
  normalizeFollowerAttachResponse,
  normalizeFollowerBootstrapResponse,
  pollTrayFollowerBootstrap,
  retryTrayFollowerBootstrap,
  sendTrayFollowerAnswer,
  sendTrayFollowerIceCandidate,
} from './tray-follower.js';
export type {
  ChannelMessage,
  OrchestratorToScoopMessage,
  RegisteredScoop,
  ScheduledTask,
  ScoopConfig,
  ScoopTabState,
  ScoopToOrchestratorMessage,
} from './types.js';
export { DEFAULT_ASSISTANT_CONFIG } from './types.js';
