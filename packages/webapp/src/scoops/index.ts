/**
 * Scoops module - cone/scoops multi-agent management for SLICC.
 */

export type {
  RegisteredScoop,
  ChannelMessage,
  ScheduledTask,
  ScoopTabState,
  ScoopConfig,
  OrchestratorToScoopMessage,
  ScoopToOrchestratorMessage,
} from './types.js';
export { DEFAULT_ASSISTANT_CONFIG } from './types.js';
export * from './db.js';
export { Orchestrator, type OrchestratorCallbacks, type AssistantConfig } from './orchestrator.js';
export { ScoopContext, type ScoopContextCallbacks } from './scoop-context.js';
export { TaskScheduler, type SchedulerCallbacks } from './scheduler.js';
export {
  loadSkills,
  formatSkillsForPrompt,
  createDefaultSkills,
  type Skill,
  type SkillMetadata,
} from './skills.js';
export {
  createScoopManagementTools,
  type ScoopManagementToolsConfig,
} from './scoop-management-tools.js';
export {
  createAgentBridge,
  publishAgentBridge,
  publishAgentBridgeProxy,
  AGENT_BRIDGE_GLOBAL_KEY,
  AGENT_SPAWN_REQUEST_TYPE,
  type AgentBridge,
  type AgentSpawnOptions,
  type AgentSpawnResult,
  type AgentBridgeContext,
  type AgentBridgeContextArgs,
  type AgentBridgeDeps,
} from './agent-bridge.js';
export { Heartbeat, type HeartbeatStatus, type HeartbeatCallbacks } from './heartbeat.js';
export {
  attachTrayFollower,
  normalizeFollowerAttachResponse,
  normalizeFollowerBootstrapResponse,
  pollTrayFollowerBootstrap,
  retryTrayFollowerBootstrap,
  sendTrayFollowerAnswer,
  sendTrayFollowerIceCandidate,
  type FollowerAttachOptions,
  type FollowerAttachPlan,
  type FollowerBootstrapOptions,
  type FollowerBootstrapPlan,
} from './tray-follower.js';
