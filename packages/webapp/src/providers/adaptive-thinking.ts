/**
 * Adaptive-thinking shim for Bedrock-backed Claude models that the pinned pi-ai
 * does not yet recognize.
 *
 * Newer Claude models (Opus 4.7/4.8, Sonnet 4.6, …) use **adaptive** thinking:
 * the request must carry `thinking: { type: 'adaptive' }` + `output_config.effort`
 * rather than the legacy `thinking: { type: 'enabled', budget_tokens }`. pi-ai's
 * `supportsAdaptiveThinking()` decides which shape to emit from a hardcoded model
 * list — and the pinned pi-ai (0.75.3) knows opus-4-6/4-7 + sonnet-4-6 but NOT
 * opus-4-8. For opus-4-8 it therefore emits the legacy shape, and Bedrock rejects
 * it: `400 "thinking.type.enabled is not supported for this model. Use
 * thinking.type.adaptive and output_config.effort..."` (surfaced via the Adobe
 * proxy as a 502).
 *
 * pi-ai's `streamAnthropic` exposes an `onPayload(params, model)` hook (the same
 * one `bedrock-camp` uses). This module builds an `onPayload` that rewrites the
 * emitted body from the enabled shape into the adaptive shape for the models
 * pi-ai misses. Sibling of `temperature-support.ts` — both work around the same
 * gap (the pinned pi-ai predates opus-4-8). A pi-ai bump that learns these models
 * makes the rewrite a no-op (it only fires when the enabled shape is present).
 *
 * See `docs/pitfalls.md`.
 */

import type { ThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai';

/** Models pi-ai 0.75.3 omits from `supportsAdaptiveThinking()` but that need it. */
const ADAPTIVE_THINKING_SHIM_MODELS = ['claude-opus-4-8', 'opus-4-8'] as const;

/** lower-case + separator-normalized comparison candidates (mirrors temperature-support.ts). */
function matchCandidates(modelId: string, modelName?: string): string[] {
  const values = modelName ? [modelId, modelName] : [modelId];
  return values.flatMap((value) => {
    const lower = value.toLowerCase();
    return [lower, lower.replace(/[\s_.:]+/g, '-')];
  });
}

/** True when the model needs the adaptive-thinking payload rewrite. */
export function modelNeedsAdaptiveThinkingShim(modelId: string, modelName?: string): boolean {
  const candidates = matchCandidates(modelId, modelName);
  return candidates.some((c) => ADAPTIVE_THINKING_SHIM_MODELS.some((needle) => c.includes(needle)));
}

/**
 * Map a pi-ai `ThinkingLevel` to a Bedrock adaptive-thinking effort. Mirrors
 * pi-ai's (non-exported) `mapThinkingLevelToEffort`: an explicit
 * `model.thinkingLevelMap` override wins, else minimal/low→low, medium→medium,
 * high→high, xhigh→xhigh, and an absent level defaults to `high`.
 */
export function thinkingLevelToEffort(
  level: ThinkingLevel | undefined,
  thinkingLevelMap?: ThinkingLevelMap
): string {
  const mapped = level ? thinkingLevelMap?.[level] : undefined;
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
}

type Params = Record<string, unknown>;
type PayloadHook = (params: Params, model: unknown) => Params | Promise<Params>;

/**
 * Build an `onPayload` hook that converts pi-ai's legacy enabled-thinking body
 * into the adaptive shape (`thinking: { type: 'adaptive', display? }` +
 * `output_config.effort`). No-ops unless the body actually carries
 * `thinking.type === 'enabled'`, so it is safe when thinking is off or once
 * pi-ai learns the model. Composes with any caller-supplied `onPayload` (that
 * one runs first).
 */
export function adaptiveThinkingPayloadHook(effort: string, prior?: PayloadHook): PayloadHook {
  return async (params, model) => {
    const base = prior ? ((await prior(params, model)) ?? params) : params;
    const thinking = base.thinking as { type?: string; display?: string } | undefined;
    if (thinking && thinking.type === 'enabled') {
      base.thinking = {
        type: 'adaptive',
        ...(thinking.display !== undefined ? { display: thinking.display } : {}),
      };
      base.output_config = { ...((base.output_config as object) ?? {}), effort };
    }
    return base;
  };
}

interface AdaptiveShimModel {
  id: string;
  name?: string;
  thinkingLevelMap?: ThinkingLevelMap;
}

/**
 * Return `options` unchanged unless the model needs the adaptive-thinking shim,
 * in which case return a clone with an `onPayload` that performs the rewrite
 * (composed over any existing `onPayload`). The effort is taken from an explicit
 * `effort` option, else derived from the `reasoning` thinking level.
 */
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
  const effort = o.effort ?? thinkingLevelToEffort(o.reasoning, model.thinkingLevelMap);
  return { ...options, onPayload: adaptiveThinkingPayloadHook(effort, o.onPayload) };
}
