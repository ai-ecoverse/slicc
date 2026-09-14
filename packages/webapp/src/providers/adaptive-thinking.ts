import type { ThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai';

import {
  claudeSupportsAdaptiveThinking,
  claudeSupportsMaxEffort,
  claudeSupportsNativeXhighEffort,
} from './claude-model-version.js';

export function modelNeedsAdaptiveThinkingShim(modelId: string, modelName?: string): boolean {
  return claudeSupportsAdaptiveThinking(modelId, modelName);
}

function clampXhighEffort(effort: string, modelId?: string, modelName?: string): string {
  if (effort !== 'xhigh' || !modelId) return effort;
  if (claudeSupportsNativeXhighEffort(modelId, modelName)) return 'xhigh';
  if (claudeSupportsMaxEffort(modelId, modelName)) return 'max';
  return 'high';
}

interface ThinkingLevelModel {
  id?: string;
  name?: string;
  thinkingLevelMap?: ThinkingLevelMap;
}

export function thinkingLevelToEffort(
  level: ThinkingLevel | undefined,
  model?: ThinkingLevelModel
): string {
  const mapped = level ? model?.thinkingLevelMap?.[level] : undefined;
  const base = (() => {
    if (typeof mapped === 'string') return mapped;
    switch (level) {
      case 'minimal':
      case 'low':
        return 'low';
      case 'medium':
        return 'medium';
      case 'xhigh':
        return 'xhigh';
      default:
        return 'high';
    }
  })();
  return clampXhighEffort(base, model?.id, model?.name);
}

interface AdaptiveThinkingBlock {
  type?: string;
  display?: string;
  budget_tokens?: number;
}

interface AdaptiveOutputConfig {
  effort?: string;
}

export interface AdaptiveThinkingPayload {
  thinking?: AdaptiveThinkingBlock;
  output_config?: AdaptiveOutputConfig;
  model?: string;
  max_tokens?: number;
  tagged?: boolean;
}

type PayloadHook = (
  params: AdaptiveThinkingPayload,
  model: unknown
) => AdaptiveThinkingPayload | Promise<AdaptiveThinkingPayload>;

export function adaptiveThinkingPayloadHook(effort: string, prior?: PayloadHook): PayloadHook {
  return async (params, model) => {
    const base = prior ? ((await prior(params, model)) ?? params) : params;
    const thinking = base.thinking;
    if (thinking && thinking.type === 'enabled') {
      base.thinking = {
        type: 'adaptive',
        ...(thinking.display !== undefined ? { display: thinking.display } : {}),
      };
      base.output_config = { ...(base.output_config ?? {}), effort };
    }
    return base;
  };
}

interface AdaptiveShimModel {
  id: string;
  name?: string;
  thinkingLevelMap?: ThinkingLevelMap;
}

export function withAdaptiveThinkingShim<T extends object>(
  model: AdaptiveShimModel,
  options: T
): T {
  if (!modelNeedsAdaptiveThinkingShim(model.id, model.name)) return options;
  const o = options as {
    reasoning?: ThinkingLevel;
    effort?: string;
    onPayload?: PayloadHook;
  };
  const effort = clampXhighEffort(
    o.effort ?? thinkingLevelToEffort(o.reasoning, model),
    model.id,
    model.name
  );
  return { ...options, onPayload: adaptiveThinkingPayloadHook(effort, o.onPayload) };
}
