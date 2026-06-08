/**
 * Model capability: does this model accept the `temperature` sampling param?
 *
 * Bedrock-backed Claude Opus 4.7 and 4.8 reject `temperature` — Bedrock
 * returns `400 "temperature is deprecated for this model."`. Through the
 * Adobe proxy that surfaces as a `502 upstream_error`, which the node-server
 * fetch-proxy relays to the agent. Both the Adobe provider (`providers/adobe.ts`)
 * and the Bedrock CAMP provider (`providers/built-in/bedrock-camp.ts`) route
 * these models to Bedrock, so both must omit `temperature`.
 *
 * pi-ai's `anthropic-messages` builder already drops `temperature` when extended
 * thinking is enabled, so the main cone stream is unaffected — but the
 * thinking-disabled helper calls (`ui/quick-llm.ts`, e.g. the scope-label and
 * session-title helpers) send `temperature: 0.3` and would otherwise 502.
 *
 * Keep this list in one place; adding a future temperature-rejecting model is a
 * single edit consumed by every provider.
 */
const TEMPERATURE_UNSUPPORTED = [
  'claude-opus-4-7',
  'opus-4-7',
  'claude-opus-4-8',
  'opus-4-8',
] as const;

/**
 * Normalize an id/name to comparison candidates: lower-cased, plus a variant
 * with run-together separators (spaces / dots / underscores / colons) collapsed
 * to dashes. Mirrors the matcher in `bedrock-camp.ts` so `Claude Opus 4.8`,
 * `claude_opus_4_8`, and `us.anthropic.claude-opus-4-8` all match `opus-4-8`.
 */
function matchCandidates(modelId: string, modelName?: string): string[] {
  const values = modelName ? [modelId, modelName] : [modelId];
  return values.flatMap((value) => {
    const lower = value.toLowerCase();
    return [lower, lower.replace(/[\s_.:]+/g, '-')];
  });
}

/** True unless the model is known to reject the `temperature` param. */
export function modelSupportsTemperature(modelId: string, modelName?: string): boolean {
  const candidates = matchCandidates(modelId, modelName);
  return !candidates.some((c) => TEMPERATURE_UNSUPPORTED.some((needle) => c.includes(needle)));
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
