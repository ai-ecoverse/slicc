import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Api } from '@earendil-works/pi-ai';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/compat';
import type { Model } from '../../core/index.js';
import { createLogger } from '../../core/index.js';
import { claudeSupportsAdaptiveThinking } from '../../providers/claude-model-version.js';
import { THINKING_LEVELS } from '../types.js';

const log = createLogger('scoop-context');

export function resolveThinkingLevel(
  requested: ThinkingLevel | undefined,
  model: Model<Api>
): ThinkingLevel {
  if (!model.reasoning) return 'off';
  if (requested === undefined) return 'off';
  if (requested === 'xhigh' && !getSupportedThinkingLevels(model).includes('xhigh')) return 'high';
  return requested;
}

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

export function thinkingStaysAdaptive(model: Model<Api> | undefined): boolean {
  if (!model?.reasoning || !model.thinkingLevelMap) return false;
  if (!claudeSupportsAdaptiveThinking(model.id, model.name)) return false;
  if ('off' in model.thinkingLevelMap) return model.thinkingLevelMap.off === null;
  return /claude-(opus|sonnet|fable)-5(?:-|\b)/.test(model.id);
}

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

export function getLockedEffortLevel(): ThinkingLevel | null {
  try {
    const val = localStorage.getItem('slicc_locked_effort_level');
    if (!val) return null;
    if (THINKING_LEVELS.includes(val as ThinkingLevel)) return val as ThinkingLevel;
    log.warn('Unrecognized locked effort level in localStorage, ignoring:', val);
  } catch {}
  return null;
}
