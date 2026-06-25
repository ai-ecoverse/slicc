/**
 * Model capability: does this model accept the `temperature` sampling param?
 *
 * Bedrock-backed Claude Opus ≥ 4.7 rejects `temperature` — Bedrock returns
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
 * Predicate lives in `claude-model-version.ts` so future Opus releases
 * (4.9 / 5.x) are handled automatically by the version threshold.
 */

import { claudeRejectsTemperature } from './claude-model-version.js';

/** True unless the model is known to reject the `temperature` param. */
export function modelSupportsTemperature(modelId: string, modelName?: string): boolean {
  return !claudeRejectsTemperature(modelId, modelName);
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
