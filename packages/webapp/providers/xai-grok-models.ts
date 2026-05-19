/**
 * Model catalog for the xAI Grok provider.
 *
 * Adapted from https://github.com/stnly/pi-grok/blob/main/models.ts.
 *
 * Pricing comes from xAI's published rate card; the multi-agent ("Grok
 * Heavy") SKU bills as a single request despite running multiple agents in
 * parallel internally. `grok-build` is on the SuperGrok plan with zero
 * marginal cost — billed via the subscription, not per token.
 */

import type { ModelMetadata } from '../src/providers/types.js';

const COST_BUILD = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const COST_43 = { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 };
const COST_420 = { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 };

export interface XaiModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: ('text' | 'image')[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  /** Non-reasoning variants need a thinkingLevelMap to disable thinking-effort. */
  thinkingLevelMap?: Record<string, string | null>;
}

export const FALLBACK_MODELS: XaiModelConfig[] = [
  {
    id: 'grok-build',
    name: 'Grok Build',
    reasoning: true,
    input: ['text', 'image'],
    cost: COST_BUILD,
    contextWindow: 1_000_000,
    maxTokens: 30_000,
  },
  {
    id: 'grok-4.3',
    name: 'Grok 4.3',
    reasoning: true,
    input: ['text', 'image'],
    cost: COST_43,
    contextWindow: 1_000_000,
    maxTokens: 30_000,
  },
  {
    id: 'grok-4.20-0309-reasoning',
    name: 'Grok 4.20 Reasoning',
    reasoning: true,
    input: ['text', 'image'],
    cost: COST_420,
    contextWindow: 2_000_000,
    maxTokens: 30_000,
  },
  {
    id: 'grok-4.20-0309-non-reasoning',
    name: 'Grok 4.20 Non-Reasoning',
    reasoning: false,
    input: ['text', 'image'],
    cost: COST_420,
    contextWindow: 2_000_000,
    maxTokens: 30_000,
    thinkingLevelMap: {
      off: 'none',
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
    },
  },
  {
    id: 'grok-4.20-multi-agent-0309',
    name: 'Grok Heavy',
    reasoning: true,
    input: ['text', 'image'],
    cost: COST_420,
    contextWindow: 2_000_000,
    maxTokens: 30_000,
  },
];

/**
 * Only these model prefixes accept `reasoning.effort` in xAI's Responses
 * API. Everything else gets the param stripped in the sanitizer.
 */
const EFFORT_CAPABLE_PREFIXES = ['grok-3-mini', 'grok-4.20-multi-agent', 'grok-4.3'];

export function supportsReasoningEffort(modelId: string): boolean {
  const name = modelId.includes('/') ? modelId.split('/').pop()! : modelId;
  return EFFORT_CAPABLE_PREFIXES.some((p) => name.toLowerCase().startsWith(p));
}

/**
 * `PI_XAI_OAUTH_MODELS=grok-build,grok-4.3` filters / reorders the catalog.
 * Unknown ids get a sensible default config so users can opt in to new
 * models without an extension update.
 */
export function resolveModels(envValue?: string | null): XaiModelConfig[] {
  const env = (envValue ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (env.length === 0) return FALLBACK_MODELS;
  const byId = new Map(FALLBACK_MODELS.map((m) => [m.id, m]));
  return env.map(
    (id) =>
      byId.get(id) ?? {
        id,
        name: id,
        reasoning: true,
        input: ['text'] as ('text' | 'image')[],
        cost: COST_BUILD,
        contextWindow: 1_000_000,
        maxTokens: 30_000,
      }
  );
}

/** Convert {@link XaiModelConfig} into slicc {@link ModelMetadata} shape. */
export function toModelMetadata(m: XaiModelConfig): { id: string; name: string } & ModelMetadata {
  return {
    id: m.id,
    name: m.name,
    api: 'openai',
    reasoning: m.reasoning,
    input: m.input,
    context_window: m.contextWindow,
    max_tokens: m.maxTokens,
  };
}
