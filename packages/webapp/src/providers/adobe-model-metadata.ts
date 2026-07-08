/**
 * Pure Adobe model-metadata merge helper.
 *
 * Extracted from `providers/adobe.ts:getModelIds()` so it has zero DOM /
 * `chrome` / `import.meta.glob` dependencies and can be unit-tested directly
 * (adobe.ts itself cannot be imported under vitest).
 *
 * The merge fills a model entry's metadata from two sources, cache-first:
 *   1. `cached` — proxy metadata captured from the authenticated `/v1/models`
 *      response (authoritative; carries `api` for OpenAI-compatible routing).
 *   2. `entry`  — the model descriptor itself, which on the unauthenticated
 *      `/v1/config` fallback path is the ONLY place `context_window` /
 *      `max_tokens` are available.
 *
 * Carrying the window through the config-fallback path matters because the
 * resolved `model.contextWindow` sizes context compaction (GC): an Adobe
 * Sonnet/Opus 4.x model reports a 1M window, and dropping it would leave GC on
 * the 200K default. See `scoops/scoop-context.ts` compaction wiring.
 */

/** Per-token cost structure (values in $ per million tokens). */
export interface AdobeModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Metadata shape shared by `/v1/config` entries and the `/v1/models` cache. */
export interface AdobeModelMetadata {
  id: string;
  name?: string;
  api?: 'anthropic' | 'openai';
  context_window?: number;
  max_tokens?: number;
  reasoning?: boolean;
  input?: string[];
  cost?: AdobeModelCost;
}

/** Per-model compat overrides merged onto the streaming `Model<Api>`. */
export interface AdobeModelCompat {
  supportsEagerToolInputStreaming: boolean;
}

/** Enriched descriptor returned to `getModelIds()` (a `ModelMetadata` superset). */
export interface EnrichedAdobeModel {
  id: string;
  name: string;
  api?: 'anthropic' | 'openai';
  context_window?: number;
  max_tokens?: number;
  reasoning?: boolean;
  input?: string[];
  cost?: AdobeModelCost;
  compat?: AdobeModelCompat;
}

/**
 * Merge a model `entry` with optional `cached` proxy metadata. Cached values
 * win; the entry fills any gaps. Absent optional fields are omitted entirely
 * (no `undefined` keys) so downstream `applyModelMetadata` only sets what was
 * actually reported.
 */
export function enrichAdobeModel(
  entry: AdobeModelMetadata,
  cached?: AdobeModelMetadata
): EnrichedAdobeModel {
  const out: EnrichedAdobeModel = { id: entry.id, name: entry.name ?? entry.id };

  const api = cached?.api ?? entry.api;
  const contextWindow = cached?.context_window ?? entry.context_window;
  const maxTokens = cached?.max_tokens ?? entry.max_tokens;
  const reasoning = cached?.reasoning ?? entry.reasoning;
  const input = cached?.input ?? entry.input;

  if (api) out.api = api;
  if (contextWindow !== undefined) out.context_window = contextWindow;
  if (maxTokens !== undefined) out.max_tokens = maxTokens;
  if (reasoning !== undefined) out.reasoning = reasoning;
  if (input) out.input = input;

  const cost = cached?.cost ?? entry.cost;
  if (cost) out.cost = cost;

  // Adobe's IMS proxy forwards Anthropic-Messages requests to AWS Bedrock.
  // Bedrock's Haiku endpoints 400 on `tools[].eager_input_streaming` ("Extra
  // inputs are not permitted"); the same field works on Opus and Sonnet.
  // pi-ai adds the field to every tool definition by default, so disable it
  // for Haiku only — pi-ai then omits it and sends the legacy
  // `fine-grained-tool-streaming-2025-05-14` beta header instead, which
  // Haiku-on-Bedrock accepts.
  if (/haiku/i.test(entry.id)) {
    out.compat = { supportsEagerToolInputStreaming: false };
  }

  return out;
}
