/**
 * Cerebras provider.
 *
 * Registers a ProviderConfig for the `cerebras` ID so that
 * `account-store.getProviderModels()` uses our `getModelIds()` list instead
 * of the pi-ai static registry (which is stale).
 *
 * Model catalog: fetched live from `GET /v1/models` on every account-change
 * event via `refreshModels`. `getModelIds()` reads from the in-memory cache,
 * falls back to localStorage (cold consumers / page reload), and falls back
 * to a hardcoded seed list when no key has been saved yet.
 *
 * We also register a `cerebras-openai` API stream that delegates straight to
 * pi-ai's `streamOpenAICompletions` — the Cerebras backend is fully
 * OpenAI-compatible and pi-ai already handles non-standard Cerebras behaviour
 * (`supportsStore: false`, etc.) via `provider === 'cerebras'` and
 * `baseUrl.includes('cerebras.ai')`. Same indirection as `xai-grok.ts`.
 */

import type {
  Api,
  Context,
  Model,
  ProviderStreamOptions,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream, registerApiProvider } from '@earendil-works/pi-ai';
import {
  streamOpenAICompletions,
  streamSimpleOpenAICompletions,
} from '@earendil-works/pi-ai/openai-completions';
import { getApiKeyForProvider } from '../src/providers/account-store.js';
import type { ModelMetadata, ProviderConfig } from '../src/providers/types.js';

// ── Constants ──────────────────────────────────────────────────────

const PROVIDER_ID = 'cerebras';
const CEREBRAS_BASE_URL = 'https://api.cerebras.ai/v1';
const OPENAI_COMPLETIONS_API: Api = 'openai-completions';
const CEREBRAS_API: Api = `${PROVIDER_ID}-openai` as Api;

/** localStorage key — mirrors Adobe's pattern for cold-consumer reads. */
const STORAGE_KEY = 'slicc-cerebras-models';

// ── Model cache ────────────────────────────────────────────────────

type CerebrasModelDef = { id: string; name: string } & ModelMetadata;

/** In-memory cache populated by refreshModels(). */
let modelsCache: CerebrasModelDef[] = [];

/**
 * Hardcoded seed list — shown before the first refreshModels() resolves or
 * when no API key has been saved. Kept in sync with the public catalog at
 * https://inference-docs.cerebras.ai/models/overview.
 */
const SEED_MODELS: CerebrasModelDef[] = [
  {
    id: 'gpt-oss-120b',
    name: 'GPT OSS 120B',
    api: 'openai',
    reasoning: true,
    input: ['text'],
    context_window: 131072,
    max_tokens: 40960,
  },
  {
    id: 'zai-glm-4.7',
    name: 'Z.AI GLM-4.7',
    api: 'openai',
    reasoning: false,
    input: ['text'],
    context_window: 131072,
    max_tokens: 40960,
  },
];
// gemma-4-31b is intentionally absent from the seed: the Cerebras endpoint
// currently reports function_calling: false / tools: false, making it
// incompatible with SLICC's tool-driven agent loop. refreshModels() will
// surface it automatically if Cerebras enables tool use in the future.

function persistModels(models: CerebrasModelDef[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(models));
  } catch {
    // Ignore — storage quota or worker context without localStorage.
  }
}

function loadPersistedModels(): CerebrasModelDef[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CerebrasModelDef[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : [];
  } catch {
    return [];
  }
}

// ── Model fetching ─────────────────────────────────────────────────

interface CerebrasModelsResponse {
  data?: Array<{
    id?: string;
    name?: string;
    capabilities?: {
      vision?: boolean;
      reasoning?: boolean;
    };
    limits?: {
      max_context_length?: number;
      max_completion_tokens?: number;
    };
  }>;
}

/**
 * Map a raw /v1/models entry to our CerebrasModelDef shape.
 * Merges live API data with seed-list metadata when available — the seed list
 * carries context_window / max_tokens / input modalities that the plain
 * /v1/models endpoint does not always return.
 */
function toModelDef(entry: NonNullable<CerebrasModelsResponse['data']>[number]): CerebrasModelDef {
  const id = entry.id ?? '';
  const seed = SEED_MODELS.find((m) => m.id === id);
  return {
    id,
    name: entry.name ?? seed?.name ?? id,
    api: 'openai',
    reasoning: entry.capabilities?.reasoning ?? seed?.reasoning ?? false,
    input: entry.capabilities?.vision ? ['text', 'image'] : ['text'],
    context_window: entry.limits?.max_context_length ?? seed?.context_window ?? 8192,
    max_tokens: entry.limits?.max_completion_tokens ?? seed?.max_tokens ?? 4096,
  };
}

/**
 * Fetch the live model list from the Cerebras API and populate the cache.
 * Called by `refreshModels` — errors are logged but never thrown so a
 * transient network blip never breaks the settings UI.
 */
async function fetchAndCacheModels(apiKey: string): Promise<void> {
  const res = await fetch(`${CEREBRAS_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`GET /v1/models → ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as CerebrasModelsResponse;
  const models = (body.data ?? []).map(toModelDef).filter((m) => m.id.length > 0);
  if (models.length > 0) {
    modelsCache = models;
    persistModels(models);
  }
}

// ── Stream helpers ─────────────────────────────────────────────────

function makeErrorOutput(model: Model<Api>, error: unknown) {
  return {
    type: 'error' as const,
    reason: 'error' as const,
    error: {
      role: 'assistant' as const,
      content: [],
      api: CEREBRAS_API,
      provider: PROVIDER_ID,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'error' as const,
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    },
  };
}

// ── Stream functions ───────────────────────────────────────────────

const streamCerebras = (
  model: Model<Api>,
  context: Context,
  options: ProviderStreamOptions = {}
) => {
  const stream = createAssistantMessageEventStream();
  (async () => {
    try {
      const proxyModel = {
        ...model,
        baseUrl: CEREBRAS_BASE_URL,
        api: OPENAI_COMPLETIONS_API,
      } as Model<'openai-completions'>;
      const inner = streamOpenAICompletions(proxyModel, context, options);
      for await (const event of inner) stream.push(event);
      stream.end();
    } catch (error) {
      console.error(
        '[cerebras] Stream error:',
        error instanceof Error ? error.message : String(error)
      );
      stream.push(makeErrorOutput(model, error) as never);
      stream.end();
    }
  })();
  return stream;
};

const streamSimpleCerebras = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions
) => {
  const stream = createAssistantMessageEventStream();
  (async () => {
    try {
      const proxyModel = {
        ...model,
        baseUrl: CEREBRAS_BASE_URL,
        api: OPENAI_COMPLETIONS_API,
      } as Model<'openai-completions'>;
      const inner = streamSimpleOpenAICompletions(proxyModel, context, options);
      for await (const event of inner) stream.push(event);
      stream.end();
    } catch (error) {
      console.error(
        '[cerebras] Stream error:',
        error instanceof Error ? error.message : String(error)
      );
      stream.push(makeErrorOutput(model, error) as never);
      stream.end();
    }
  })();
  return stream;
};

// ── Provider config ────────────────────────────────────────────────

export const config: ProviderConfig = {
  id: PROVIDER_ID,
  name: 'Cerebras',
  description: 'Ultra-fast inference on Cerebras hardware. Get an API key at cloud.cerebras.ai.',
  requiresApiKey: true,
  requiresBaseUrl: false,

  getModelIds: () => {
    // 1. Live cache populated by the last refreshModels() call.
    if (modelsCache.length > 0) return modelsCache;
    // 2. Persisted list from a previous session (survives page reload).
    const persisted = loadPersistedModels();
    if (persisted.length > 0) return persisted;
    // 3. Hardcoded seed — shown before any API key is saved.
    return SEED_MODELS;
  },

  refreshModels: async (accessToken?: string) => {
    const apiKey = accessToken ?? getApiKeyForProvider(PROVIDER_ID) ?? '';
    if (!apiKey) return;
    try {
      await fetchAndCacheModels(apiKey);
    } catch (err) {
      console.warn(
        '[cerebras] Failed to refresh model list:',
        err instanceof Error ? err.message : String(err)
      );
    }
  },
};

// ── Registration ───────────────────────────────────────────────────

export function register(): void {
  registerApiProvider({
    api: CEREBRAS_API,
    stream: streamCerebras as Parameters<typeof registerApiProvider>[0]['stream'],
    streamSimple: streamSimpleCerebras as Parameters<typeof registerApiProvider>[0]['streamSimple'],
  });
}
