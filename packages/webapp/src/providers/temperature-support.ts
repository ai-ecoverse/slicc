/**
 * Model capability: does this model accept the `temperature` sampling param?
 *
 * Bedrock-backed Claude Opus ≥ 4.7, Sonnet ≥ 5.0, and Fable reject
 * `temperature` — Bedrock returns
 * `400 "temperature is deprecated for this model."`. Through the Adobe proxy
 * that surfaces as a `502 upstream_error`, which the node-server fetch-proxy
 * relays to the agent. Both the Adobe provider (`providers/adobe.ts`) and the
 * Bedrock CAMP provider (`providers/built-in/bedrock-camp.ts`) route these
 * models to Bedrock, so both must omit `temperature`.
 *
 * pi-ai's `anthropic-messages` builder already drops `temperature` when extended
 * thinking is enabled, so the main cone stream is unaffected — but the
 * thinking-disabled helper calls (`providers/quick-llm.ts`, e.g. the scope-
 * label and session-title helpers) send `temperature: 0.3` and would otherwise 502.
 *
 * Predicate lives in `claude-model-version.ts` so future releases within a
 * known family are handled automatically by the version threshold.
 */

import { claudeRejectsTemperature } from './claude-model-version.js';

/**
 * Non-Claude Bedrock models that reject `temperature` the same way.
 *
 * The newest third-party models on Bedrock have followed Anthropic in
 * dropping the param: `openai.gpt-5.6-*` answers `400 "This model doesn't
 * support the temperature field. Remove temperature and try again."`
 * (verified on `bedrock-runtime.us-west-2`). Only models the bedrock-camp
 * picker can actually reach need to be listed here — the allowlist in
 * `built-in/bedrock-camp-compat.ts` is the other half of this pair, so extend
 * both together.
 *
 * `xai.grok-4.6` also rejects `temperature`, but it is not allowlisted (it
 * does not cache), so it is deliberately absent — add it here in the same
 * change that admits it to the picker.
 *
 * Matched WITHOUT the vendor prefix so the display name of an opaque
 * application-inference-profile ARN ("GPT-5.6 Sol (Global)") hits the same
 * rule as the id ("global.openai.gpt-5.6-sol"). Both `.` and `-` separators
 * are accepted because the name normalizer collapses spaces to dashes.
 * The version is pinned: `gpt-5.5` still accepts `temperature`.
 */
const NON_CLAUDE_REJECTS_TEMPERATURE_RE = /gpt-5[.-]6/;

function nonClaudeRejectsTemperature(modelId: string, modelName?: string): boolean {
  const values = modelName ? [modelId, modelName] : [modelId];
  return values.some((value) => {
    const lower = value.toLowerCase();
    return (
      NON_CLAUDE_REJECTS_TEMPERATURE_RE.test(lower) ||
      NON_CLAUDE_REJECTS_TEMPERATURE_RE.test(lower.replace(/[\s_]+/g, '-'))
    );
  });
}

/** True unless the model is known to reject the `temperature` param. */
export function modelSupportsTemperature(modelId: string, modelName?: string): boolean {
  if (claudeRejectsTemperature(modelId, modelName)) return false;
  return !nonClaudeRejectsTemperature(modelId, modelName);
}

/**
 * Return `options` unchanged when the model accepts `temperature`, otherwise a
 * shallow clone with `temperature` removed. Never mutates the input; returns the
 * same reference when there is nothing to strip so callers can rely on identity.
 */
export function withSupportedTemperature<T extends { temperature?: number }>(
  modelId: string,
  modelName: string | undefined,
  options: T
): T {
  if (options.temperature === undefined || modelSupportsTemperature(modelId, modelName)) {
    return options;
  }
  const { temperature: _omitted, ...rest } = options;
  return rest as T;
}
