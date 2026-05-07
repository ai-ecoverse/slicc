/**
 * SwiftLM model construction for pi-ai.
 *
 * SwiftLM exposes an OpenAI-compatible `/v1/chat/completions` endpoint,
 * so we wire it through pi-ai's built-in `openai-completions` API rather
 * than registering a custom provider. That keeps the call shape we
 * exercise here byte-identical to what pi-ai sends in production for
 * any other OpenAI-compatible endpoint, which is the whole point of
 * the eval — we want to surface real protocol mismatches, not test a
 * shim we wrote ourselves.
 *
 * The cost numbers are zero (local inference), and `contextWindow`/
 * `maxTokens` are conservative defaults that the agent loop never
 * actually enforces — the SwiftLM `--ctx-size` flag is the real wall.
 */

import { registerBuiltInApiProviders, type Model } from '@mariozechner/pi-ai';

export const SWIFTLM_DEFAULT_BASE_URL = 'http://127.0.0.1:5413';
export const SWIFTLM_DEFAULT_MODEL_ID = 'mlx-community/Qwen3.6-35B-A3B-4bit';

let providersRegistered = false;

/**
 * Register pi-ai's built-in providers exactly once per process.
 * `streamSimple` dispatches by `model.api`; without registration it
 * throws "no provider for openai-completions" on the first request.
 */
export function ensureProviders(): void {
  if (providersRegistered) return;
  registerBuiltInApiProviders();
  providersRegistered = true;
}

/**
 * Build a `Model<"openai-completions">` pointing at a SwiftLM instance.
 * Caller passes the model id (the HuggingFace `repoId` SwiftLM is
 * serving) and optionally the base URL.
 */
export function buildSwiftLMModel(opts: {
  modelId: string;
  /** SwiftLM root, e.g. `http://127.0.0.1:5413`. Without trailing /v1
   *  — that's appended internally because pi-ai passes the value
   *  straight to the OpenAI SDK, which suffixes `/chat/completions`. */
  baseUrl?: string;
}): Model<'openai-completions'> {
  const root = (opts.baseUrl ?? SWIFTLM_DEFAULT_BASE_URL).replace(/\/+$/, '');
  return {
    id: opts.modelId,
    name: opts.modelId,
    api: 'openai-completions',
    provider: 'swiftlm-eval',
    baseUrl: `${root}/v1`,
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // These are defensive bounds on the pi-ai side; the actual cap
    // is whatever SwiftLM was launched with via --ctx-size and
    // --max-tokens.
    contextWindow: 262_144,
    maxTokens: 8_192,
  };
}

/**
 * Probe `/health` and `/v1/models` against a SwiftLM endpoint. Returns
 * the first text-capable model id, or null when nothing is available.
 * Filters out image-only model ids that mlx_lm.server (or any
 * HF-cache-aware server) may also list.
 */
export async function probeAndPickModel(
  baseUrl: string
): Promise<{ ok: true; modelId: string } | { ok: false; reason: string }> {
  try {
    const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!health.ok) {
      return { ok: false, reason: `/health returned HTTP ${health.status}` };
    }
    const modelsResp = await fetch(`${baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!modelsResp.ok) {
      return { ok: false, reason: `/v1/models returned HTTP ${modelsResp.status}` };
    }
    const payload = (await modelsResp.json()) as { data?: Array<{ id?: string }> };
    const ids = (payload.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
    const text = ids.filter((id) => !/(?:flux|z-image|stable-diffusion)/i.test(id));
    if (text.length === 0) {
      return { ok: false, reason: '/v1/models listed no text-capable model ids' };
    }
    return { ok: true, modelId: text[0] };
  } catch (err) {
    return {
      ok: false,
      reason: `endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
