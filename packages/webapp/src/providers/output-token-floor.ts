/**
 * Model capability: the smallest `maxTokens` a model's API accepts.
 *
 * pi-ai's `buildBaseOptions` caps `maxTokens` at the room left in the context
 * window (window − estimated context − 4096) and floors it at 1, so a nearly
 * full context sends `maxTokens: 1`. Some backends reject a budget that small
 * and fail the turn instead of answering briefly. pi-ai's own OpenAI Responses
 * builders already raise `max_output_tokens` to 16; stream functions slicc
 * implements itself call {@link withOutputTokenFloor} before building the
 * request.
 *
 * Rules are keyed by the wire API, narrowed by model, and hold measured
 * minimums only. A model no rule covers keeps pi-ai's floor of 1.
 */

import { isBedrockCampClaudeModel } from './built-in/bedrock-camp-compat.js';

interface OutputTokenModel {
  api: string;
  id: string;
  name?: string;
}

interface OutputTokenFloorRule {
  apis: readonly string[];
  applies: (model: OutputTokenModel) => boolean;
  min: number;
}

const RULES: readonly OutputTokenFloorRule[] = [
  {
    // Bedrock Converse serves non-Anthropic models through backends that answer
    // `maxTokens` below 16 with `400 integer_below_min_value` ("Expected a value
    // >= 16"): every allowlisted GPT-5.6, GPT-6 and GPT-6.1 model, Kimi K3 and
    // Grok 4.7 (bedrock-runtime, 2026-10-09; BU Bench bu2-022 failed a GPT-6
    // Luna run this way). Claude accepts 1. An opaque application inference
    // profile id never matches the Claude pattern, so it gets the floor too,
    // which Claude would also accept.
    apis: ['bedrock-camp-converse', 'bedrock-converse-stream'],
    applies: (model) => !isBedrockCampClaudeModel(model),
    min: 16,
  },
];

/** The smallest output-token budget the model's API accepts; 1 when no rule is known. */
export function minOutputTokens(model: OutputTokenModel): number {
  let min = 1;
  for (const rule of RULES) {
    if (rule.apis.includes(model.api) && rule.applies(model)) min = Math.max(min, rule.min);
  }
  return min;
}

/** `maxTokens` raised to the model's minimum; an absent budget stays absent. */
export function withOutputTokenFloor(
  model: OutputTokenModel,
  maxTokens: number | undefined
): number | undefined {
  return maxTokens === undefined ? undefined : Math.max(maxTokens, minOutputTokens(model));
}
