/**
 * Types for cone/scoops multi-agent management in SLICC.
 *
 * The "cone" is the main orchestrator context. Each "scoop" is an
 * isolated conversation context with its own agent instance, tools,
 * and restricted filesystem access.
 */

import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { MessageAttachment } from '../core/attachments.js';
// Legal down-edge (`scoops/` → `tools/`): the JSON Schema shape a scoop's
// structured-output contract is expressed in is owned by the tool layer.
import type { JsonSchemaObject } from '../tools/types.js';

// The runtime enumeration and guard live in the foundational `base/` layer so
// lower layers (shell/'s `agent` command) can validate a `--thinking` value
// without a back-edge into `scoops/`. Re-exported here for existing importers.
export { isThinkingLevel, THINKING_LEVELS } from '../base/thinking-level.js';
export type { ThinkingLevel };

/**
 * Click-cycle order for the chat panel's brain icon. The full
 * {@link ThinkingLevel} enum (`off | minimal | low | medium | high | xhigh`)
 * remains valid for programmatic / shell-flag callers; the UI only steps
 * through this 4-bucket subset for clarity. `xhigh` is silently skipped to
 * `off` when the active model doesn't support it (see
 * `getSupportedThinkingLevels()` in `@earendil-works/pi-ai`).
 */
export const THINKING_LEVEL_CYCLE: readonly ThinkingLevel[] = [
  'off',
  'low',
  'high',
  'xhigh',
] as const;

/**
 * Current `ScoopConfig` schema generation. Bumped whenever a new field is
 * introduced that demands a compat backfill for records saved before it
 * existed. Scoops created today are stamped with this value; the orchestrator
 * runs one-shot migrations for any record whose version is strictly lower
 * and never touches records already at the current version.
 *
 * - `1`: `visiblePaths` is authoritative (may be an explicit empty list).
 * - `2`: `writablePaths` is authoritative (may be an explicit empty list).
 * - `3`: `visiblePaths` is relative to the OWNING cone's workspace, not to a
 *   float-wide `/workspace` (#2271).
 */
export const CURRENT_SCOOP_CONFIG_VERSION = 3;

/**
 * The model a work unit runs on (#2310). Lives on the RECORD, next to
 * {@link RegisteredScoop.parentJid} / `folder` / {@link WorkUnitThinking} —
 * not in page localStorage — so every cone keeps its own model across
 * reloads, rides the tray wire to followers, and can be changed for one
 * cone without touching any other unit.
 *
 * `provider` is always explicit: without it a bare id is resolved against
 * whatever provider happens to be selected at init time, which is how a
 * cheap cross-provider unit ends up billing as Opus (#2195).
 */
export interface WorkUnitModel {
  /** Provider account id the model runs on (e.g. `anthropic`, `openrouter`). */
  provider: string;
  /** Bare model id within that provider (e.g. `claude-opus-4-6`). */
  id: string;
}

/**
 * Reasoning configuration of a work unit (#2310). Stored on the record next
 * to {@link RegisteredScoop.model} rather than as a side channel, so a level
 * set by the user (or a follower) survives a reload and travels with the
 * unit it belongs to.
 */
export interface WorkUnitThinking {
  /**
   * Requested reasoning level — the user's *intent*, stored unclamped.
   * `xhigh` is resolved down to `high` at runtime on a model that does not
   * advertise it, and re-resolved (not lost) on the next model change.
   */
  level?: ThinkingLevel;
  /**
   * Raw API effort string that bypasses pi-ai's ThinkingLevel mapping.
   * `'max'` when the user picks the highest tier (Sprofondato) — pi-ai has
   * no `max` level, so {@link WorkUnitThinking.level} carries `'xhigh'`
   * while this field carries the true intent to the stream layer.
   */
  effortOverride?: string;
}

/** Registered scoop metadata */
export interface RegisteredScoop {
  /** Unique identifier */
  jid: string;
  /** Human-readable name */
  name: string;
  /** Storage folder name (sanitized, e.g. "andy-scoop") */
  folder: string;
  /** Trigger pattern (e.g., "@andy-scoop") */
  trigger?: string;
  /** Whether trigger is required */
  requiresTrigger: boolean;
  /** Assistant label for display (e.g., "sliccy" for cone, "andy-scoop" for scoops) */
  assistantLabel: string;
  /** ISO timestamp when added */
  addedAt: string;
  /** Scoop-specific config */
  config?: ScoopConfig;
  /**
   * Generation of `ScoopConfig` that produced this record. `undefined` means
   * "truly legacy" — a record saved before any of the path-config fields
   * existed. The orchestrator migrates up to {@link CURRENT_SCOOP_CONFIG_VERSION}
   * on restore; records already at the current version are left alone so
   * explicit `undefined`/empty values stay authoritative.
   */
  configSchemaVersion?: number;
  /**
   * Ownership edge of the work-unit tree (#1666). `null` marks a root unit
   * (a cone); a child unit (a scoop) carries the JID of the unit that owns
   * it — the cone or scoop that created it. Always explicit: creation paths
   * set it and {@link Orchestrator.init} backfills legacy records on
   * restore, so `parentJid === null` is THE root test (`isRootUnit`).
   * Also read by the transcript export to reconstruct delegation chains.
   */
  parentJid: string | null;
  /**
   * Model this unit runs on (#2310). Optional only for compatibility with
   * records written before the field existed — {@link Orchestrator.init}
   * backfills them (from a legacy `config.modelId` pin, else the owning
   * cone's model, else the global `selected-model` seed), so live records
   * always carry one. Read it through `modelFor()` (`work-unit/record.ts`),
   * never off `config`.
   */
  model?: WorkUnitModel;
  /**
   * Reasoning configuration of this unit (#2310), next to
   * {@link RegisteredScoop.model}. Migrated from the legacy
   * `config.thinkingLevel` / `config.effortOverride` pair on restore; read
   * it through `thinkingFor()` (`work-unit/record.ts`).
   */
  thinking?: WorkUnitThinking;
  /**
   * Tool-call ID from the parent conversation that triggered scoop creation.
   * Only set where an actual tool-call ID is available — never inferred
   * from timestamps or names.
   */
  originToolCallId?: string;
  /**
   * When `false`, suppresses the orchestrator's cone-notify side effect
   * that fires when this scoop reaches the terminal `ready` status after
   * processing a prompt. Default (`undefined` / `true`) preserves the
   * default behavior: the cone receives a `scoop-notify` message with a
   * VFS path to the scoop's full output, a 1000-character preview, and
   * the total line count, triggering a cone turn.
   *
   * Set to `false` for ephemeral, self-contained invocations (e.g. scoops
   * spawned through the `agent` shell command) where the caller already
   * drains the scoop's output via an `observeScoop` subscription and does
   * NOT want the completion to bill an extra cone turn. Not persisted —
   * ephemeral scoops are unregistered at the end of their run.
   */
  notifyOnComplete?: boolean;
}

/** Per-scoop configuration */
export interface ScoopConfig {
  /** Custom system prompt addition */
  systemPromptAppend?: string;
  /** @deprecated Never enforced. Use {@link ScoopConfig.maxWallClockMs}. */
  timeout?: number;
  /**
   * Hard per-prompt-run turn ceiling (#1972). The run is stopped at the
   * bound and surfaced as a bounded failure through `onError`, so a
   * spawned agent cannot keep taking (and billing) turns after its
   * caller gave up — turn count is the cost. Unset → unbounded.
   */
  maxTurns?: number;
  /** Hard per-prompt-run wall-clock ceiling in ms — same semantics. */
  maxWallClockMs?: number;
  /**
   * Seconds the scoop's `bash` tool waits for a command before detaching it to
   * the background and continuing the turn (the tool's `background_after`
   * default; a per-call argument still wins). Unset → the tool's own
   * `DEFAULT_BASH_BACKGROUND_AFTER_SECONDS` (600). This matters most for an
   * unattended scoop: nobody is there to cancel a wedged turn, so a scoop given
   * a tight budget fails soft (a lick arrives later) instead of hanging its
   * caller.
   */
  backgroundAfterSeconds?: number;
  /** Assistant name override for this scoop */
  assistantName?: string;
  /**
   * @deprecated Legacy CREATION INPUT for the model pin. Spawn paths
   * (`scoop_scoop`, the `agent` command, hosted config) may still set it;
   * `normalizeScoopRecord` lifts it onto {@link RegisteredScoop.model} and
   * clears it, which is the only field runtime code reads (#2310).
   */
  modelId?: string;
  /**
   * Provider {@link ScoopConfig.modelId} must run on (e.g. `openrouter`).
   * Set by every spawn path that resolves a model id, including for the
   * selected provider. Without it `ScoopContext.init()` resolves `modelId`
   * against whatever provider is selected AT INIT TIME and silently degrades
   * to the cone's own model when that provider doesn't offer it — how a
   * cheap cross-provider scoop ends up billing as Opus (#2195). When set, a
   * mismatch is a hard init error instead.
   *
   * @deprecated Same as {@link ScoopConfig.modelId}: creation input, lifted
   * onto {@link RegisteredScoop.model} by `normalizeScoopRecord` (#2310).
   */
  modelProviderId?: string;
  /**
   * Reasoning / thinking level forwarded to `pi-agent-core`'s
   * {@link import('@earendil-works/pi-agent-core').AgentState.thinkingLevel}.
   * One of `off | minimal | low | medium | high | xhigh`. When unset, the
   * scoop inherits its parent's level (or `off` for non-reasoning models).
   *
   * `xhigh` is silently clamped to `high` when the active model doesn't
   * advertise xhigh support — see `getSupportedThinkingLevels()` from
   * `@earendil-works/pi-ai`.
   * For non-reasoning models the value is ignored entirely.
   *
   * @deprecated Creation input only — lifted onto
   * {@link RegisteredScoop.thinking} by `normalizeScoopRecord` (#2310).
   */
  thinkingLevel?: ThinkingLevel;
  /**
   * Raw API effort string that bypasses pi-ai's ThinkingLevel mapping.
   * Set to `'max'` when the user picks the highest effort tier (Sprofondato)
   * — pi-ai's ThinkingLevel has no `max` value, so `thinkingLevel` is set
   * to `'xhigh'` while this field carries the true intent to the stream
   * layer, which injects it as `output_config.effort`.
   *
   * @deprecated Creation input only — lifted onto
   * {@link RegisteredScoop.thinking} by `normalizeScoopRecord` (#2310).
   */
  effortOverride?: string;
  /**
   * VFS paths this scoop can READ (but not write). Pure replace — when
   * `undefined` the scoop gets no read-only paths at all. The `scoop_scoop`
   * tool injects the standard `['/workspace/']` default when creating scoops
   * so existing agent-facing behavior is preserved. Cone scoops ignore this
   * field — they always use an unrestricted filesystem.
   */
  visiblePaths?: readonly string[];
  /**
   * VFS paths this scoop can READ AND WRITE. Pure replace — when
   * `undefined` the scoop gets no writable paths at all. Read access is
   * the union of `writablePaths` and `visiblePaths` (RestrictedFS
   * surfaces both as readable); write access is limited to
   * `writablePaths`. The `scoop_scoop` tool injects the standard
   * `['/scoops/<folder>/', '/shared/']` default so existing agent-facing
   * behavior is preserved. Cone scoops ignore this field — they always
   * use an unrestricted filesystem.
   */
  writablePaths?: readonly string[];
  /**
   * Shell command allow-list. When omitted (or when it contains `'*'`), every
   * built-in, custom, and `.jsh` command is available — the default. Otherwise
   * only commands whose names appear in the list can execute inside this
   * scoop's shell, including through pipelines and substitution.
   */
  allowedCommands?: readonly string[];
  /**
   * JSON Schema to enforce on the scoop's final output. When set,
   * a `StructuredOutput` tool is injected so the agent must return
   * its result in the specified schema shape.
   */
  structuredOutputSchema?: JsonSchemaObject;
}

/** Message from any channel */
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
  /**
   * For actionable licks (sudo-request): the orchestrator-minted lick id, so a
   * later resolve can find this stored message and flip its rendered card.
   */
  lickId?: string;
  /** Result state for an actionable lick: pending / confirmed / dismissed. */
  lickState?: 'pending' | 'confirmed' | 'dismissed';
  /**
   * Steering send (Ctrl/Cmd+Enter in the composer): when this message lands
   * mid-turn, interrupt the running turn with it instead of queueing it behind
   * the turn. Carried through the router batch down to `ScoopContext.prompt`.
   */
  steer?: boolean;
}

/** Scheduled task */
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

/** Scoop tab state */
export interface ScoopTabState {
  jid: string;
  contextId: string;
  status: 'initializing' | 'ready' | 'processing' | 'error';
  lastActivity: string;
  error?: string;
}

/** IPC messages between orchestrator and scoops */
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

/** Configuration for the assistant */
export interface AssistantConfig {
  name: string;
  triggerPattern: RegExp;
}

export const DEFAULT_ASSISTANT_CONFIG: AssistantConfig = {
  name: 'sliccy',
  triggerPattern: /^@sliccy\b/i,
};
