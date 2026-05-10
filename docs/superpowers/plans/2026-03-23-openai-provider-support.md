# OpenAI-Compatible Provider Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable providers to override model capabilities (context window, max tokens, reasoning) and route OpenAI-compatible models through the correct stream function.

**Architecture:** Three-layer merge for model capabilities (pi-ai registry → modelOverrides → getModelIds metadata). Stream function routing based on model `api` field. All changes are backwards compatible — omitted fields preserve current behavior.

**Tech Stack:** TypeScript, pi-ai (`@earendil-works/pi-ai`), Vitest

**Spec:** `docs/superpowers/specs/2026-03-23-openai-provider-support-design.md`

---

### Task 1: Add ModelMetadata type and modelOverrides to ProviderConfig

**Files:**

- Modify: `packages/webapp/src/providers/types.ts`
- Test: `packages/webapp/tests/providers/index.test.ts`

- [ ] **Step 1: Write failing test for ModelMetadata and modelOverrides**

Add to `packages/webapp/tests/providers/index.test.ts`:

```typescript
describe('provider config model metadata', () => {
  it('ProviderConfig supports modelOverrides field', () => {
    const config: ProviderConfig = {
      id: 'test-provider',
      name: 'Test',
      description: '',
      requiresApiKey: true,
      requiresBaseUrl: false,
      modelOverrides: {
        'claude-opus-4-6': { context_window: 1000000, max_tokens: 32768 },
        'zai-glm-4.7': { api: 'openai', context_window: 131072, reasoning: true },
      },
    };
    expect(config.modelOverrides?.['claude-opus-4-6']?.context_window).toBe(1000000);
    expect(config.modelOverrides?.['zai-glm-4.7']?.api).toBe('openai');
  });

  it('getModelIds supports metadata fields', () => {
    const config: ProviderConfig = {
      id: 'test-provider',
      name: 'Test',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      getModelIds: () => [
        { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', context_window: 1000000 },
        {
          id: 'zai-glm-4.7',
          name: 'GLM 4.7',
          api: 'openai' as const,
          context_window: 131072,
          max_tokens: 40960,
          reasoning: true,
          input: ['text'],
        },
      ],
    };
    const models = config.getModelIds!();
    expect(models[0].context_window).toBe(1000000);
    expect(models[1].api).toBe('openai');
    expect(models[1].input).toEqual(['text']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/webapp/tests/providers/index.test.ts`
Expected: TypeScript errors — `modelOverrides` and metadata fields not on types yet.

- [ ] **Step 3: Implement ModelMetadata and update ProviderConfig**

In `packages/webapp/src/providers/types.ts`, add the `ModelMetadata` interface and extend `ProviderConfig`:

```typescript
/**
 * Optional model capability overrides.
 * Used by both modelOverrides (static) and getModelIds (dynamic).
 */
export interface ModelMetadata {
  /** API format: 'anthropic' (default) or 'openai' for OpenAI-compatible backends. */
  api?: 'anthropic' | 'openai';
  /** Context window size in tokens. */
  context_window?: number;
  /** Maximum output tokens. */
  max_tokens?: number;
  /** Whether the model supports thinking/reasoning. */
  reasoning?: boolean;
  /** Supported input modalities (e.g., ['text', 'image']). */
  input?: string[];
}
```

Add to `ProviderConfig`:

```typescript
  /**
   * Optional: override model capabilities for specific model IDs.
   * Applied after pi-ai registry defaults, before getModelIds metadata.
   * Any provider can use this for static overrides (e.g., custom context windows).
   */
  modelOverrides?: Record<string, ModelMetadata>;
```

Update `getModelIds` return type:

```typescript
  getModelIds?: () => Array<{ id: string; name?: string } & ModelMetadata>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/webapp/tests/providers/index.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/providers/types.ts packages/webapp/tests/providers/index.test.ts
git commit -m "feat: add ModelMetadata type and modelOverrides to ProviderConfig

Enables providers to override model capabilities (context window,
max tokens, reasoning, API format) via static config or dynamic
getModelIds() metadata.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Apply model metadata overrides in getProviderModels

**Files:**

- Modify: `packages/webapp/src/ui/provider-settings.ts:112-160` (the `getProviderModels` function)
- Test: `packages/webapp/tests/ui/provider-settings.test.ts`

- [ ] **Step 1: Write failing tests for model metadata overrides**

Add to `packages/webapp/tests/ui/provider-settings.test.ts`. These tests need to work within the existing mock structure. Add a new `describe` block:

```typescript
describe('model metadata overrides', () => {
  beforeEach(() => {
    storage.clear();
    mockGetProviders.mockReturnValue(['anthropic']);
    mockGetModels.mockImplementation((providerId: string) => {
      if (providerId === 'anthropic') {
        return [
          {
            id: 'claude-opus-4-6',
            name: 'Claude Opus 4.6',
            contextWindow: 200000,
            maxTokens: 16384,
            reasoning: true,
          },
        ];
      }
      return [];
    });
  });

  it('getModelIds metadata overrides pi-ai defaults for known models', () => {
    // Register a provider with getModelIds returning metadata overrides
    mockRegisteredConfigs.set('test-proxy', {
      id: 'test-proxy',
      name: 'Test Proxy',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      getModelIds: () => [
        {
          id: 'claude-opus-4-6',
          name: 'Claude Opus 4.6',
          context_window: 1000000,
          max_tokens: 32768,
        },
      ],
    });

    const models = getProviderModels('test-proxy');
    expect(models).toHaveLength(1);
    expect(models[0].contextWindow).toBe(1000000);
    expect(models[0].maxTokens).toBe(32768);
  });

  it('getModelIds metadata creates correct fallback for unknown models', () => {
    mockRegisteredConfigs.set('test-proxy', {
      id: 'test-proxy',
      name: 'Test Proxy',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      getModelIds: () => [
        {
          id: 'zai-glm-4.7',
          name: 'GLM 4.7',
          api: 'openai' as const,
          context_window: 131072,
          max_tokens: 40960,
          reasoning: true,
          input: ['text'],
        },
      ],
    });

    const models = getProviderModels('test-proxy');
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('zai-glm-4.7');
    expect(models[0].contextWindow).toBe(131072);
    expect(models[0].maxTokens).toBe(40960);
    expect(models[0].reasoning).toBe(true);
  });

  it('modelOverrides applies to all resolved models', () => {
    mockRegisteredConfigs.set('custom-azure', {
      id: 'custom-azure',
      name: 'Custom Azure',
      description: '',
      requiresApiKey: true,
      requiresBaseUrl: true,
      isOAuth: true,
      modelOverrides: {
        'claude-opus-4-6': { context_window: 500000 },
      },
    });

    const models = getProviderModels('custom-azure');
    const opus = models.find((m) => m.id === 'claude-opus-4-6');
    expect(opus).toBeDefined();
    expect(opus!.contextWindow).toBe(500000);
  });

  it('getModelIds metadata takes priority over modelOverrides', () => {
    mockRegisteredConfigs.set('test-proxy', {
      id: 'test-proxy',
      name: 'Test Proxy',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      modelOverrides: {
        'claude-opus-4-6': { context_window: 500000 },
      },
      getModelIds: () => [
        { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', context_window: 1000000 },
      ],
    });

    const models = getProviderModels('test-proxy');
    expect(models[0].contextWindow).toBe(1000000); // getModelIds wins
  });

  it('api field is preserved on model object', () => {
    mockRegisteredConfigs.set('test-proxy', {
      id: 'test-proxy',
      name: 'Test Proxy',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      getModelIds: () => [
        { id: 'zai-glm-4.7', name: 'GLM 4.7', api: 'openai' as const, context_window: 131072 },
      ],
    });

    const models = getProviderModels('test-proxy');
    // The api field should be stored somewhere accessible for stream routing
    // It gets encoded in the model's api field as 'test-proxy-openai'
    expect(models[0].api).toContain('openai');
  });
});
```

Note: The test mocking structure must match the existing `provider-settings.test.ts` pattern — check the existing `mockRegisteredConfigs` and mock setup. Adapt the mock variable names to match what exists in the file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/webapp/tests/ui/provider-settings.test.ts`
Expected: Failures — metadata fields not applied yet.

- [ ] **Step 3: Implement metadata merge in getProviderModels**

In `packages/webapp/src/ui/provider-settings.ts`, update the `getProviderModels` function's `getModelIds` branch (lines 125-159).

The key change is in the `modelIds.map()` callback. After constructing the base model (from pi-ai registry or fallback), apply metadata overrides:

```typescript
// Helper to apply metadata overrides to a model
function applyModelMetadata(
  model: Record<string, any>,
  metadata: { context_window?: number; max_tokens?: number; reasoning?: boolean; input?: string[] }
): void {
  if (metadata.context_window !== undefined) model.contextWindow = metadata.context_window;
  if (metadata.max_tokens !== undefined) model.maxTokens = metadata.max_tokens;
  if (metadata.reasoning !== undefined) model.reasoning = metadata.reasoning;
  if (metadata.input !== undefined) model.input = metadata.input;
}
```

In the `getModelIds` branch, update the mapping:

```typescript
return modelIds.map((pm) => {
  const base = modelMap.get(pm.id);
  // Determine API type: use metadata api field, or default to anthropic
  const apiType = pm.api ?? 'anthropic';
  const customApi =
    apiType === 'openai' ? (`${providerId}-openai` as Api) : (`${providerId}-anthropic` as Api);

  let model: Record<string, any>;
  if (base) {
    model = { ...base, api: customApi, provider: providerId };
  } else {
    model = {
      id: pm.id,
      name: pm.name ?? pm.id,
      provider: providerId,
      api: customApi,
      baseUrl: '',
      contextWindow: 200000,
      maxTokens: 16384,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      reasoning: true,
    };
  }

  // Layer 2: Apply modelOverrides from ProviderConfig (if any)
  const overrides = providerConfig.modelOverrides?.[pm.id];
  if (overrides) applyModelMetadata(model, overrides);

  // Layer 3: Apply getModelIds metadata (highest priority)
  applyModelMetadata(model, pm);

  return model as unknown as Model<Api>;
});
```

Also apply `modelOverrides` in the `isOAuth` branch (lines 161-166) for providers that don't use `getModelIds`:

```typescript
if (providerConfig.isOAuth) {
  const anthropicModels = getModelsDynamic('anthropic');
  const customApi = `${providerId}-anthropic` as Api;
  return anthropicModels.map((m) => {
    const model: Record<string, any> = { ...m, api: customApi, provider: providerId };
    const overrides = providerConfig.modelOverrides?.[m.id];
    if (overrides) applyModelMetadata(model, overrides);
    return model as unknown as Model<Api>;
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/webapp/tests/ui/provider-settings.test.ts`
Expected: All tests pass (existing + new).

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/webapp/src/ui/provider-settings.ts packages/webapp/tests/ui/provider-settings.test.ts
git commit -m "feat: apply model metadata overrides in getProviderModels

Three-layer merge: pi-ai registry → modelOverrides → getModelIds.
Proxy metadata can override context_window, max_tokens, reasoning,
and input modalities. API type (anthropic/openai) encoded in model's
api field for stream function routing.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Add OpenAI stream routing in Adobe provider

**Files:**

- Modify: `packages/webapp/providers/adobe.ts:339-381` (streamAdobe and streamSimpleAdobe functions)
- Modify: `packages/webapp/providers/adobe.ts:385-418` (fetchProxyModels — propagate metadata)
- Modify: `packages/webapp/providers/adobe.ts:195-221` (getModelIds — propagate metadata)

- [ ] **Step 1: Update fetchProxyModels to parse and propagate metadata**

In `packages/webapp/providers/adobe.ts`, update `fetchProxyModels()` (line ~385) to parse new optional fields from `/v1/models` response and store them:

The `/v1/models` response may now include: `api`, `context_window`, `max_tokens`, `reasoning`, `input`.

Update the interface for proxy model data:

```typescript
interface ProxyModelEntry {
  id: string;
  name?: string;
  api?: 'anthropic' | 'openai';
  context_window?: number;
  max_tokens?: number;
  reasoning?: boolean;
  input?: string[];
}
```

In `fetchProxyModels`, update the type of `data.data`:

```typescript
const data = (await res.json()) as { data?: ProxyModelEntry[] };
```

Store the metadata on each model object returned:

```typescript
return data.data.map((pm) => {
  const base = modelMap.get(pm.id);
  const model: Record<string, any> = base
    ? { ...base, provider: 'adobe', api: 'adobe-anthropic' as Api }
    : {
        id: pm.id,
        name: pm.name ?? pm.id,
        provider: 'adobe',
        api: 'adobe-anthropic' as Api,
        baseUrl: endpoint,
        contextWindow: 200000,
        maxTokens: 16384,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        inputCost: 0,
        outputCost: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        reasoning: true,
      };
  // Store metadata from proxy (will be used by provider-settings)
  if (pm.api) (model as any)._proxyApi = pm.api;
  return model as unknown as Model<Api>;
});
```

- [ ] **Step 2: Update getModelIds to return metadata**

In `config.getModelIds` (line ~195), propagate proxy metadata:

The `modelsCache` stores `Model<Api>[]` from `fetchProxyModels`. The `getModelIds` function returns `{ id, name }[]`. Update it to also return metadata fields.

In `getModelIds`:

```typescript
  getModelIds: () => {
    // Prefer the authenticated /v1/models response (has all available models)
    for (const models of modelsCache.values()) {
      if (models.length) {
        const result = models.map(m => {
          const entry: any = { id: m.id, name: m.name ?? m.id };
          // Propagate proxy metadata if present
          if ((m as any)._proxyApi) entry.api = (m as any)._proxyApi;
          if ((m as any)._proxyContextWindow) entry.context_window = (m as any)._proxyContextWindow;
          if ((m as any)._proxyMaxTokens) entry.max_tokens = (m as any)._proxyMaxTokens;
          if ((m as any)._proxyReasoning !== undefined) entry.reasoning = (m as any)._proxyReasoning;
          if ((m as any)._proxyInput) entry.input = (m as any)._proxyInput;
          return entry;
        });
        // Persist so models survive page refresh
        try { localStorage.setItem('slicc-adobe-models', JSON.stringify(result)); } catch {}
        return result;
      }
    }
    // ... existing fallback logic unchanged
  },
```

Actually, a cleaner approach: store the full proxy metadata on the model directly during `fetchProxyModels`, and read it back in `getModelIds`. Let me simplify.

**Revised approach**: Store proxy metadata fields directly on a separate cache keyed by model ID:

```typescript
// Cache proxy metadata per model ID
const proxyMetadataCache = new Map<string, ProxyModelEntry>();
```

In `fetchProxyModels`, after parsing:

```typescript
if (data.data?.length) {
  for (const pm of data.data) {
    proxyMetadataCache.set(pm.id, pm);
  }
  // ... existing model construction
}
```

In `getModelIds`, include metadata from cache:

```typescript
const entry: any = { id: m.id, name: m.name ?? m.id };
const meta = proxyMetadataCache.get(m.id);
if (meta?.api) entry.api = meta.api;
if (meta?.context_window !== undefined) entry.context_window = meta.context_window;
if (meta?.max_tokens !== undefined) entry.max_tokens = meta.max_tokens;
if (meta?.reasoning !== undefined) entry.reasoning = meta.reasoning;
if (meta?.input) entry.input = meta.input;
return entry;
```

- [ ] **Step 3: Add OpenAI stream routing**

In `packages/webapp/providers/adobe.ts`, update `streamAdobe` and `streamSimpleAdobe` to check the model's API type and route accordingly.

Add import at the top:

```typescript
import {
  registerApiProvider,
  streamAnthropic,
  streamSimpleAnthropic,
  streamOpenAICompletions,
  streamSimpleOpenAICompletions,
  getModels,
} from '@earendil-works/pi-ai';
```

Update `streamAdobe` (~line 339):

```typescript
const streamAdobe = (model: Model<Api>, context: Context, options: AnthropicOptions = {}) => {
  const stream = new AssistantMessageEventStream();
  (async () => {
    try {
      const accessToken = await getValidAccessToken();
      const proxyEndpoint = getProxyEndpoint();
      const proxyModel = { ...model, baseUrl: proxyEndpoint };

      // Route based on API type encoded in model.api
      const isOpenAI = String(model.api).includes('openai');
      if (isOpenAI) {
        const inner = streamOpenAICompletions(
          { ...proxyModel, api: 'openai-chat' as Api } as any,
          context,
          { ...options, apiKey: accessToken } as any
        );
        for await (const event of inner) stream.push(event as any);
      } else {
        const inner = streamAnthropic(
          { ...proxyModel, api: 'anthropic-messages' as Api } as any,
          context,
          { ...options, apiKey: accessToken }
        );
        for await (const event of inner) stream.push(event as any);
      }
      stream.end();
    } catch (error) {
      console.error(
        '[adobe] Stream error:',
        error instanceof Error ? error.message : String(error)
      );
      stream.push(makeErrorOutput(model, error) as any);
      stream.end();
    }
  })();
  return stream;
};
```

Apply the same pattern to `streamSimpleAdobe` (~line 361).

- [ ] **Step 4: Register the OpenAI API provider**

In `register()` (line ~433), register the OpenAI API too:

```typescript
export function register(): void {
  registerApiProvider({
    api: 'adobe-anthropic' as Api,
    stream: streamAdobe as any,
    streamSimple: streamSimpleAdobe as any,
  });
  registerApiProvider({
    api: 'adobe-openai' as Api,
    stream: streamAdobe as any,
    streamSimple: streamSimpleAdobe as any,
  });
}
```

- [ ] **Step 5: Run build gates**

```bash
npm run typecheck && npm run test && npm run build && npm run build:extension
```

Expected: All four pass.

- [ ] **Step 6: Commit**

```bash
git add packages/webapp/providers/adobe.ts
git commit -m "feat(adobe): add OpenAI stream routing and proxy metadata propagation

Adobe provider now routes to streamOpenAICompletions for models
with api='openai' (e.g., Cerebras GLM 4.7). Proxy metadata
(context_window, max_tokens, reasoning) propagated through
getModelIds for accurate model resolution.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Final verification and documentation

**Files:**

- Modify: `CLAUDE.md` (add note about provider model metadata)

- [ ] **Step 1: Run all build gates**

```bash
npm run typecheck && npm run test && npm run build && npm run build:extension
```

Expected: All four pass.

- [ ] **Step 2: Update CLAUDE.md**

In the "Key Conventions" section, update the "Provider composition" bullet to mention model metadata:

```
- **Provider composition**: Auto-discovered from pi-ai. External providers: drop `.ts` in `packages/webapp/providers/`. OAuth via `createOAuthLauncher()` in `packages/webapp/src/providers/oauth-service.ts`. Registration runs in both `main.ts` and `offscreen.ts`. Providers can override model capabilities via `modelOverrides` (static) or `getModelIds()` metadata (dynamic). Three-layer merge: pi-ai → modelOverrides → getModelIds.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document provider model metadata override system

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```
