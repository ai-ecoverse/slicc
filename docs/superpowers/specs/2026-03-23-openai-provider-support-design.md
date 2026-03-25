# OpenAI-Compatible Provider Support + Proxy Model Metadata

**Date:** 2026-03-23
**Branch:** `feature/openai-provider-support`
**Status:** Approved

## Problem

The Adobe provider currently assumes all models use the Anthropic Messages API format. This prevents supporting OpenAI-compatible backends (e.g., Cerebras) behind the same proxy. Additionally, model capabilities (context window, max tokens) are either inherited from pi-ai's Anthropic registry or fall back to hardcoded defaults — the proxy has no way to communicate the actual capabilities of its models.

This matters because:
1. The proxy may expose Cerebras models (GLM 4.7, Llama) that use the OpenAI Chat Completions API
2. The proxy may grant access to Claude models with different limits than the pi-ai defaults (e.g., 1M context)
3. Unknown model IDs get wrong defaults (200K context, 16K max tokens, reasoning: true)

## Design

### 1. Extended `/v1/models` Response

The proxy's `/v1/models` endpoint returns optional metadata per model. New fields are all optional — omitted fields fall back to current behavior.

```json
{
  "data": [
    {
      "id": "claude-opus-4-6",
      "name": "Claude Opus 4.6",
      "context_window": 1000000,
      "max_tokens": 32768
    },
    {
      "id": "zai-glm-4.7",
      "name": "GLM 4.7",
      "api": "openai",
      "context_window": 131072,
      "max_tokens": 40960,
      "reasoning": true,
      "input": ["text"]
    },
    {
      "id": "llama-3.3-70b",
      "name": "Llama 3.3 70B",
      "api": "openai",
      "context_window": 131072,
      "max_tokens": 8192,
      "reasoning": false,
      "input": ["text"]
    }
  ]
}
```

**New optional fields per model:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `api` | `"anthropic" \| "openai"` | `"anthropic"` | Which API format the proxy expects for this model |
| `context_window` | `number` | pi-ai registry or 200000 | Context window size in tokens |
| `max_tokens` | `number` | pi-ai registry or 16384 | Maximum output tokens |
| `reasoning` | `boolean` | pi-ai registry or true | Whether model supports thinking/reasoning |
| `input` | `string[]` | pi-ai registry or `["text", "image"]` | Supported input modalities |

### 2. Model Metadata Overrides (Two Mechanisms)

Two complementary ways for providers to override model capabilities:

#### A. `modelOverrides` on ProviderConfig (static, any provider)

Any provider can declare per-model overrides in its config:

```typescript
modelOverrides?: Record<string, {
  api?: 'anthropic' | 'openai';
  context_window?: number;
  max_tokens?: number;
  reasoning?: boolean;
  input?: string[];
}>;
```

Example — Azure AI Foundry with a custom context window:
```typescript
export const config: ProviderConfig = {
  id: 'azure-ai-foundry',
  name: 'Azure (Claude)',
  // ...existing fields...
  modelOverrides: {
    'claude-opus-4-6': { context_window: 1000000 },
  },
};
```

#### B. `getModelIds()` metadata (dynamic, proxy providers)

Providers that implement `getModelIds()` (like Adobe) return metadata per model from the proxy. This is the same mechanism described in Section 1.

#### Merge Priority

In `packages/webapp/src/ui/provider-settings.ts`, `getProviderModels()` resolves model capabilities:

1. **Pi-ai registry** — base defaults for known model IDs
2. **`modelOverrides`** from ProviderConfig — static overrides, applied to any model
3. **`getModelIds()` metadata** — dynamic overrides from proxy, highest priority

Each layer only overrides fields it provides. Omitted fields pass through from the previous layer.

This means:
- Any provider (even config-only like Azure) can override model capabilities via `modelOverrides`
- Proxy providers (like Adobe) can also return dynamic metadata that takes the highest priority
- Pi-ai is the fallback for fields nobody overrides

### 3. Stream Function Routing in Adobe Provider

In `packages/webapp/providers/adobe.ts`, the stream functions check the model's API type:

**Current:** All models → `streamAnthropic()`

**New:**
- Model `api` is `"anthropic"` (or unset) → `streamAnthropic()` (existing path)
- Model `api` is `"openai"` → `streamOpenAICompletions()` from pi-ai

The `api` field is stored on the `Model` object during model resolution (step 2) and read at stream time.

### 4. Proxy-Side Routing (Out of Scope for SLICC)

The proxy handles backend routing based on model ID:
- Anthropic models → forward to Anthropic API
- Cerebras models → forward to `https://api.cerebras.ai/v1`

The proxy accepts requests in whichever format the model's `api` field indicates. SLICC sends the right format because it picks the right stream function.

## Changes

### File: `packages/webapp/src/ui/provider-settings.ts`

**In `getProviderModels()`** — implement the three-layer merge:

- Apply `modelOverrides` from ProviderConfig (if present) to all resolved models
- Parse new optional fields from `getModelIds()` return value (if present)
- When merging, later layers override earlier: pi-ai → modelOverrides → getModelIds metadata
- For unknown model IDs, use override/metadata fields instead of hardcoded defaults
- Store `api` type on the model object for stream function routing

### File: `packages/webapp/providers/adobe.ts`

**In `streamAdobe()` and `streamSimpleAdobe()`:**

- Check model's API type
- If `"openai"` → use `streamOpenAICompletions()` / `streamSimpleOpenAICompletions()` from pi-ai
- If `"anthropic"` (default) → existing `streamAnthropic()` path

**In `fetchProxyModels()` and `getModelIds()`:**

- Parse and propagate the new optional fields from `/v1/models` response
- Return them in the `getModelIds()` result so `provider-settings.ts` can use them

### File: `packages/webapp/src/providers/types.ts`

- Add `ModelMetadata` type for shared override fields:
  ```typescript
  export interface ModelMetadata {
    api?: 'anthropic' | 'openai';
    context_window?: number;
    max_tokens?: number;
    reasoning?: boolean;
    input?: string[];
  }
  ```

- Add `modelOverrides` to `ProviderConfig`:
  ```typescript
  modelOverrides?: Record<string, ModelMetadata>;
  ```

- Extend `getModelIds` return type:
  ```typescript
  getModelIds?: () => Array<{ id: string; name?: string } & ModelMetadata>;
  ```

## Testing

- Unit tests for model resolution with `modelOverrides` (context_window, max_tokens, reasoning)
- Unit tests for model resolution with `getModelIds()` metadata overrides
- Unit tests for three-layer merge priority (pi-ai < modelOverrides < getModelIds)
- Unit tests for stream function routing (anthropic vs openai based on api field)
- Existing Adobe provider tests should continue to pass (backwards compatible)
- Build gates: `npm run typecheck && npm run test && npm run build && npm run build:extension`

## Backwards Compatibility

All new fields are optional. Existing proxy responses without metadata fields produce identical behavior to today. The `api` field defaults to `"anthropic"`, preserving the current stream function selection.

## Out of Scope

- Proxy-side implementation (model routing, Cerebras integration)
- Cerebras-specific features (disable_reasoning, clear_thinking)
- New UI for model capabilities display
- Scoop-level model selection (already supported)
