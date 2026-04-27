/**
 * Local SwiftLM — OpenAI-compatible LLM running on localhost via the
 * Sliccstart Models tab.
 *
 * No auth/baseUrl configuration: the URL is hardcoded to the SwiftLM
 * default (`http://localhost:5413/v1`) and the server is unauthenticated
 * by default. The model list is fetched from `/v1/models` at boot and
 * cached in localStorage so `getModelIds` (which must be sync) can return
 * the currently-loaded model. When SwiftLM isn't reachable, the cache is
 * cleared and the provider's model list returns empty — the entry stops
 * appearing in the chat dropdown until SwiftLM comes back up.
 */

import type { ProviderConfig, ModelMetadata } from '../types.js';
import { registerApiProvider, streamOpenAICompletions } from '@mariozechner/pi-ai';
import type {
  AssistantMessageEventStream,
  Api,
  Model,
  Context,
  SimpleStreamOptions,
  StreamFunction,
  StreamOptions,
} from '@mariozechner/pi-ai';
import { buildBaseOptions } from '@mariozechner/pi-ai/dist/providers/simple-options.js';

const PROVIDER_ID = 'swiftlm';
const SWIFTLM_BASE_URL = 'http://localhost:5413/v1';
const SWIFTLM_API_TYPE = 'swiftlm-openai' as Api;

/** Cache key in localStorage. The webapp pre-fetches the SwiftLM `/v1/models`
 *  and `/health` endpoints at boot and stuffs the result here so the
 *  (synchronous) provider `getModelIds` callback can answer without a
 *  network round-trip. */
const MODELS_CACHE_KEY = 'swiftlm:models';

interface CachedModel {
  id: string;
  name?: string;
  /** True when SwiftLM was launched with `--vision` and this model is a
   *  VLM (Gemma 4, Qwen-VL, Pixtral, ...). Sliccstart sets the flag
   *  automatically based on the model's `config.json`. */
  supportsVision?: boolean;
}

/** True when the runtime has both `localStorage` and `fetch` — i.e. an
 *  actual browser. Node test environments (vitest's default) have neither,
 *  and the provider's auto-discovery import would otherwise crash test
 *  runs that load the providers index. */
const isBrowser =
  typeof localStorage !== 'undefined' &&
  typeof fetch !== 'undefined' &&
  typeof window !== 'undefined';

/** Best-effort fetch of `GET /v1/models` + `GET /health`. Refreshes the
 *  local cache on success; clears it on any error so SwiftLM transparently
 *  disappears from the model dropdown when the server stops. The two
 *  requests are issued in parallel and a small abort budget keeps boot
 *  fast when SwiftLM isn't running. */
async function refreshModelsCache(): Promise<void> {
  if (!isBrowser) return;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const [modelsRes, healthRes] = await Promise.all([
      fetch(`${SWIFTLM_BASE_URL}/models`, { signal: controller.signal }),
      fetch('http://localhost:5413/health', { signal: controller.signal }).catch(() => null),
    ]);
    clearTimeout(timeout);
    if (!modelsRes.ok) {
      localStorage.removeItem(MODELS_CACHE_KEY);
      return;
    }
    const modelsJson = (await modelsRes.json()) as { data?: Array<{ id?: string }> };
    let supportsVision = false;
    if (healthRes && healthRes.ok) {
      const healthJson = (await healthRes.json().catch(() => null)) as {
        vision?: boolean;
      } | null;
      supportsVision = healthJson?.vision === true;
    }
    const models: CachedModel[] = (modelsJson.data ?? [])
      .filter((m) => typeof m.id === 'string')
      .map((m) => ({ id: m.id as string, supportsVision }));
    if (models.length === 0) {
      localStorage.removeItem(MODELS_CACHE_KEY);
      return;
    }
    localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify(models));
  } catch {
    if (isBrowser) localStorage.removeItem(MODELS_CACHE_KEY);
  }
}

function readCachedModels(): Array<{ id: string; name?: string } & ModelMetadata> {
  if (!isBrowser) return [];
  const raw = localStorage.getItem(MODELS_CACHE_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return (parsed as CachedModel[])
    .filter((m): m is CachedModel => typeof m?.id === 'string')
    .map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      api: 'openai',
      // Mirror the SwiftLM CLI defaults Sliccstart sets: 32 768 ctx, 8 192
      // max output. Both can be raised once SwiftLM exposes them via
      // `/v1/models` (currently it doesn't), and individual mlx-community
      // releases may report tighter limits via their HF metadata.
      context_window: 32_768,
      max_tokens: 8_192,
      // SwiftLM's `--vision` flag flips this; detected via `/health` at
      // boot and persisted in the cache. Non-VLMs stay text-only.
      input: m.supportsVision ? ['text', 'image'] : ['text'],
    }));
}

export const config: ProviderConfig = {
  id: PROVIDER_ID,
  name: 'Local (SwiftLM)',
  description: 'Local LLMs served by SwiftLM on http://localhost:5413',
  requiresApiKey: false,
  requiresBaseUrl: false,
  getModelIds: readCachedModels,
};

/** Wrap pi-ai's OpenAI Completions streamer with the SwiftLM baseURL and
 *  the `openai-completions` api type the streamer expects. The original
 *  `Model<Api>` arrives tagged `swiftlm-openai`; we shallow-clone and
 *  retag for the underlying call. */
function withSwiftLMBaseURL(model: Model<Api>): Model<'openai-completions'> {
  const cloned: Model<Api> = {
    ...model,
    baseUrl: SWIFTLM_BASE_URL,
    api: 'openai-completions' as Api,
  };
  return cloned as unknown as Model<'openai-completions'>;
}

const streamSwiftLM: StreamFunction<Api, StreamOptions> = (model, context, options) => {
  // SwiftLM is unauthenticated by default; the OpenAI SDK still wants an
  // apiKey arg so we pass a sentinel.
  const opts = { ...(options ?? {}), apiKey: 'sk-swiftlm-no-auth' };
  return streamOpenAICompletions(
    withSwiftLMBaseURL(model),
    context as Context,
    opts as Parameters<typeof streamOpenAICompletions>[2]
  );
};

const streamSimpleSwiftLM: StreamFunction<Api, SimpleStreamOptions> = (model, context, options) => {
  const base = buildBaseOptions(model, options, 'sk-swiftlm-no-auth');
  return streamOpenAICompletions(
    withSwiftLMBaseURL(model),
    context as Context,
    base as Parameters<typeof streamOpenAICompletions>[2]
  );
};

export function register(): void {
  // Kick off the cache refresh once at module load. `getModelIds` is sync,
  // so the first chat-panel render after boot will see whatever was last
  // cached (or empty); subsequent renders pick up live data.
  void refreshModelsCache();

  registerApiProvider({
    api: SWIFTLM_API_TYPE,
    stream: streamSwiftLM as Parameters<typeof registerApiProvider>[0]['stream'],
    streamSimple: streamSimpleSwiftLM as Parameters<typeof registerApiProvider>[0]['streamSimple'],
  });
}

/** Exposed for tests / future debug commands; refreshes the model cache
 *  on demand. The actual periodic refresh lives in the chat-panel render
 *  cycle (which is fine because models almost never change at runtime). */
export const __refreshSwiftLMModels = refreshModelsCache;
