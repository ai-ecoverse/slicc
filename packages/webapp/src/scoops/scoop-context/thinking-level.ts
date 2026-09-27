/**
 * Reasoning-effort resolution.
 *
 * Owns: mapping a *requested* thinking level onto what a given model can
 * actually serve, and the deployment-wide effort lock read from localStorage.
 *
 * Changes when a model family gains or loses a reasoning tier, or when the
 * effort lock's storage contract moves — independent of the agent lifecycle,
 * which only ever asks "what level should I apply now?".
 */

import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Api } from '@earendil-works/pi-ai';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/compat';
import type { Model } from '../../core/index.js';
import { createLogger } from '../../core/index.js';
import { claudeSupportsAdaptiveThinking } from '../../providers/claude-model-version.js';
import { THINKING_LEVELS } from '../types.js';

const log = createLogger('scoop-context');

/**
 * Resolve a thinking level against an active model. Returns the value the
 * `Agent` should be initialized with — never throws.
 *
 * Rules:
 *   - Non-reasoning model → always `'off'`, regardless of `requested`.
 *   - `requested === undefined` → `'off'` (default; UI/CLI can opt in).
 *   - `requested === 'xhigh'` and the model does not advertise xhigh support
 *     (via `thinkingLevelMap`) → clamped to `'high'`.
 *   - Otherwise the requested value is passed through.
 *
 * Exposed for tests and re-used by `agent-bridge.ts`.
 */
export function resolveThinkingLevel(
  requested: ThinkingLevel | undefined,
  model: Model<Api>
): ThinkingLevel {
  if (!model.reasoning) return 'off';
  if (requested === undefined) return 'off';
  if (requested === 'xhigh' && !getSupportedThinkingLevels(model).includes('xhigh')) return 'high';
  return requested;
}

/**
 * What the next prompt will run, in the same vocabulary `slicc thinking` prints.
 *
 * The record stores the request. A lock replaces it and drops an effort
 * override. Otherwise the model's clamp applies, and an effort override of
 * `max` is in force only while the resolved level is not `off` (a request
 * with no reasoning does not send the override).
 */
export function runtimeThinking(args: {
  requested: ThinkingLevel | undefined;
  effortOverride?: string;
  model: Model<Api>;
  locked?: ThinkingLevel | null;
}): { level: ThinkingLevel; effortOverride?: string; effective: string } {
  if (args.locked) {
    const level = resolveThinkingLevel(args.locked, args.model);
    return { level, effective: level };
  }
  const level = resolveThinkingLevel(args.requested, args.model);
  const effortOverride = level !== 'off' && args.effortOverride === 'max' ? 'max' : undefined;
  return { level, effortOverride, effective: effortOverride ?? level };
}

/**
 * True when `off` is not a request this model can send.
 *
 * Bedrock rejects `thinking.type: disabled` for adaptive Claude 5, and a
 * request that simply omits the thinking fields still thinks. The thinking
 * map says so: `off: null` means unsupported, and Opus 5.5's map omits `off`
 * entirely. An unset record and an explicit `off` both run as `adaptive`.
 */
export function thinkingStaysAdaptive(model: Model<Api> | undefined): boolean {
  if (!model?.reasoning || !model.thinkingLevelMap) return false;
  if (!claudeSupportsAdaptiveThinking(model.id, model.name)) return false;
  if ('off' in model.thinkingLevelMap) return model.thinkingLevelMap.off === null;
  return /claude-(opus|sonnet|fable)-5(?:-|\b)/.test(model.id);
}

/**
 * What `model.state` names. `adaptive` is a report, not a level anyone can set.
 * `max` is not a wire thinking level: it is `xhigh` plus an effort override.
 */
export type ReportedThinkingLevel = Exclude<ThinkingLevel, 'max'> | 'adaptive';

function reportLevel(
  model: Model<Api> | undefined,
  level: ThinkingLevel,
  effortOverride?: string
): { level: ReportedThinkingLevel; effortOverride?: string } {
  if (level === 'off' && !effortOverride && thinkingStaysAdaptive(model)) {
    return { level: 'adaptive' };
  }
  if (level === 'max') {
    return { level: 'xhigh', effortOverride: effortOverride ?? 'max' };
  }
  return {
    level,
    ...(effortOverride ? { effortOverride } : {}),
  };
}

/**
 * The level `model.state` should report.
 *
 * The page catalogue is a hint. A hit that lost `reasoning` (the extra-model
 * entry for Opus 5.5 is not in every registry the page consults) resolves to
 * `off` even though the agent, on the model `model.set` just applied, will
 * send the requested level. The agent's stream state wins. A missing agent
 * is not a stream state: callers pass `agent` only when one is running.
 *
 * An always-on adaptive model reports `adaptive` when the level in force is
 * `off`, because that is what the next request does.
 */
export function reportedThinking(args: {
  requested: ThinkingLevel | undefined;
  effortOverride?: string;
  model?: Model<Api>;
  locked?: ThinkingLevel | null;
  agent?: { level: ThinkingLevel; effortOverride?: string };
}): { level: ReportedThinkingLevel; effortOverride?: string } | undefined {
  if (args.agent) {
    return reportLevel(args.model, args.agent.level, args.agent.effortOverride);
  }
  if (!args.model) return undefined;
  const runtime = runtimeThinking({
    requested: args.requested,
    effortOverride: args.effortOverride,
    model: args.model,
    locked: args.locked,
  });
  return reportLevel(args.model, runtime.level, runtime.effortOverride);
}

/**
 * The deployment-wide effort lock (`slicc_locked_effort_level`), when set: it
 * overrides both the record's level and any UI request. Returns `null` in a
 * worker shim or test env without `localStorage`.
 */
export function getLockedEffortLevel(): ThinkingLevel | null {
  try {
    const val = localStorage.getItem('slicc_locked_effort_level');
    if (!val) return null;
    if (THINKING_LEVELS.includes(val as ThinkingLevel)) return val as ThinkingLevel;
    log.warn('Unrecognized locked effort level in localStorage, ignoring:', val);
  } catch {
    // Worker shim or test env may not have localStorage
  }
  return null;
}
