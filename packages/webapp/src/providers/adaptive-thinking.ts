/**
 * Adaptive-thinking shim for Bedrock-backed Claude models that the pinned pi-ai
 * does not yet recognize.
 *
 * Claude Opus and Sonnet at version ≥ 4.6 use **adaptive** thinking: the
 * request must carry `thinking: { type: 'adaptive' }` + `output_config.effort`
 * rather than the legacy `thinking: { type: 'enabled', budget_tokens }`. pi-ai's
 * `supportsAdaptiveThinking()` decides which shape to emit from a hardcoded
 * model list — and the pinned pi-ai (0.75.3) knows opus-4-6/4-7 + sonnet-4-6
 * but NOT opus-4-8 (or any future Opus 4.9 / Sonnet 4.7 / 5.x). For those it
 * emits the legacy shape, and Bedrock rejects it: `400 "thinking.type.enabled
 * is not supported for this model. Use thinking.type.adaptive and
 * output_config.effort..."` (surfaced via the Adobe proxy as a 502).
 *
 * pi-ai's `streamAnthropic` exposes an `onPayload(params, model)` hook (the same
 * one `bedrock-camp` uses). This module builds an `onPayload` that rewrites the
 * emitted body from the enabled shape into the adaptive shape for any Claude
 * Opus / Sonnet ≥ 4.6. Sibling of `temperature-support.ts` — both delegate to
 * the shared `claude-model-version` helper so new releases are handled
 * automatically. The rewrite is a no-op when the enabled shape is not present
 * (thinking off, or pi-ai already emitted the adaptive shape itself), so it is
 * safe to fire for all of them.
 *
 * See `docs/pitfalls.md`.
 */

import type { ThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai';

import {
  claudeSupportsAdaptiveThinking,
  claudeSupportsMaxEffort,
  claudeSupportsNativeXhighEffort,
} from './claude-model-version.js';

/**
 * True when the model needs the adaptive-thinking payload rewrite. Returns true
 * for any Claude Opus / Sonnet ≥ 4.6; the rewrite itself is gated on the
 * presence of `thinking.type === 'enabled'`, so models pi-ai already emits the
 * adaptive shape for (opus-4-6/4-7, sonnet-4-6) are unaffected even though this
 * returns true for them.
 */
export function modelNeedsAdaptiveThinkingShim(modelId: string, modelName?: string): boolean {
  return claudeSupportsAdaptiveThinking(modelId, modelName);
}

/**
 * Clamp an unsupported `xhigh` effort for the adaptive models that don't accept
 * it natively, mirroring `bedrock-camp`'s `mapThinkingLevelToEffort`:
 * - Opus ≥ 4.7, Sonnet ≥ 5.0 (`claudeSupportsNativeXhighEffort`) → `xhigh`
 * - Opus 4.6, Sonnet 4.6 (`claudeSupportsMaxEffort`) → `xhigh` → `max`
 * - Anything else → `xhigh` → `high`
 *
 * Non-`xhigh` efforts pass through unchanged. When the model id is missing the
 * value is returned as-is so unaware callers retain the legacy mapping.
 */
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

/**
 * Map a pi-ai `ThinkingLevel` to a Bedrock adaptive-thinking effort. Mirrors
 * pi-ai's (non-exported) `mapThinkingLevelToEffort`: an explicit
 * `model.thinkingLevelMap` override wins, else minimal/low→low, medium→medium,
 * high→high, xhigh→xhigh, and an absent level defaults to `high`.
 *
 * The final value is then run through {@link clampXhighEffort} (using the
 * shared `claudeSupportsNativeXhighEffort` / `claudeSupportsMaxEffort`
 * predicates) so an unsupported `xhigh` — including one produced by a
 * `thinkingLevelMap` override — is downshifted to `max` (Opus 4.6,
 * Sonnet 4.6) or `high` (older models).
 */
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
  const effort = clampXhighEffort(
    o.effort ?? thinkingLevelToEffort(o.reasoning, model),
    model.id,
    model.name
  );
  return { ...options, onPayload: adaptiveThinkingPayloadHook(effort, o.onPayload) };
}
