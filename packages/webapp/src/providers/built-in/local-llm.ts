/**
 * Local LLM — universal OpenAI-compatible provider for local model servers.
 *
 * One provider that connects to any server speaking the OpenAI Chat
 * Completions API: Ollama, LM Studio, llama.cpp's `llama-server`, vLLM,
 * mlx_lm.server, Jan, LocalAI, or any custom OpenAI-compat endpoint
 * (Together, Anyscale, Fireworks, etc. via their OpenAI base URL).
 *
 * Why one provider for all of them: the OpenAI surface is the de facto
 * standard for local inference in 2026. Each runtime exposes
 * /v1/chat/completions, /v1/models, /v1/embeddings on a different port,
 * but the request/response shape is identical. Users pick a base URL and
 * a model list; SLICC streams through pi-ai's openai-completions provider.
 *
 * Runtime quirks worth knowing (handled or surfaced to the user):
 *
 * - **Ollama silently drops tool_calls when streaming.** The `/v1/*` path
 *   returns empty content with finish_reason: "stop" instead of streaming
 *   tool deltas (ollama/ollama#12557). Their native /api/chat is fine, but
 *   that's a different wire shape — out of scope for this single
 *   OpenAI-compat provider. Users running tool-heavy agents on Ollama
 *   should prefer LM Studio or llama.cpp for now. {@link detectRuntime}
 *   surfaces the runtime kind so a future native-Ollama path can branch.
 *
 * - **CORS.** From the SLICC extension and standalone webapp the browser
 *   will reach localhost directly. LM Studio and llama.cpp send
 *   `Access-Control-Allow-Origin: *` by default. Ollama does NOT — it
 *   rejects everything except 127.0.0.1 and 0.0.0.0 origins until
 *   `OLLAMA_ORIGINS` is set (see the description text below). The
 *   extension manifest already declares `host_permissions: <all_urls>`
 *   so MV3 fetch from offscreen bypasses browser-side CORS, but Ollama's
 *   server-side origin check still applies.
 *
 * - **API key.** Most local servers ignore it. pi-ai's openai-completions
 *   stream throws if no key is provided, so {@link streamLocalLlmOpenAI}
 *   injects a placeholder when the user didn't set one.
 */

import type { ProviderConfig } from '../types.js';
import { registerApiProvider, createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import {
  streamOpenAICompletions,
  streamSimpleOpenAICompletions,
} from '@earendil-works/pi-ai/openai-completions';
import type {
  Api,
  Model,
  Context,
  StreamOptions,
  SimpleStreamOptions,
  AssistantMessage,
  AssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import { getDeploymentForProvider } from '../../ui/provider-settings.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger('local-llm');

// ── Config ─────────────────────────────────────────────────────────

const PROVIDER_ID = 'local-llm';

/** Placeholder API key passed to pi-ai when the user didn't set one.
 *  Local servers (Ollama, LM Studio, llama.cpp, vLLM, mlx) accept any
 *  non-empty string; pi-ai's openai-completions stream requires one. */
const PLACEHOLDER_API_KEY = 'local';

const UNCONFIGURED_MODEL_ID = `${PROVIDER_ID}-unconfigured`;

const DESCRIPTION = [
  'Connect to any OpenAI-compatible local model server.',
  '',
  'Common base URLs:',
  '  • Ollama       http://localhost:11434/v1',
  '  • LM Studio    http://localhost:1234/v1',
  '  • llama.cpp    http://localhost:8080/v1',
  '  • vLLM         http://localhost:8000/v1',
  '  • mlx_lm       http://localhost:8080/v1',
  '  • Jan          http://localhost:1337/v1',
  '',
  'Ollama needs OLLAMA_ORIGINS=* (or chrome-extension://*) so the',
  'browser can reach it. macOS: launchctl setenv OLLAMA_ORIGINS "*".',
].join('\n');

export const config: ProviderConfig = {
  id: PROVIDER_ID,
  name: 'Local LLM (OpenAI-compatible)',
  description: DESCRIPTION,
  // Local servers (Ollama, LM Studio, llama.cpp) ignore the key, so the
  // dialog shows the field but doesn't enforce a value. Hosted OpenAI-compat
  // endpoints (Together, Anyscale, Fireworks) need a real key in this field.
  requiresApiKey: false,
  optionalApiKey: true,
  apiKeyPlaceholder: 'Leave empty for local servers, or paste a key for hosted endpoints',
  apiKeyEnvVar: 'LOCAL_LLM_API_KEY',
  requiresBaseUrl: true,
  baseUrlPlaceholder: 'http://localhost:11434/v1',
  baseUrlDescription:
    'Ollama: 11434 • LM Studio: 1234 • llama.cpp/mlx: 8080 • vLLM: 8000 • Jan: 1337. Trailing /v1 required.',
  requiresDeployment: true,
  deploymentPlaceholder: 'llama3.1:8b, qwen2.5-coder:14b',
  deploymentDescription:
    'Comma-separated model IDs from your server. List them with: curl <baseUrl>/models | jq -r .data[].id',
  // Each model ID becomes a row in the chat dropdown.
  getModelIds: () => {
    const raw = getDeploymentForProvider(PROVIDER_ID);
    const ids = parseModelList(raw);
    if (ids.length === 0) {
      return [
        {
          id: UNCONFIGURED_MODEL_ID,
          name: 'Local LLM (set base URL + model IDs in Settings)',
          api: 'openai',
        },
      ];
    }
    return ids.map((id) => ({
      id,
      name: id,
      api: 'openai' as const,
      input: ['text'],
      // Conservative defaults — most local runtimes don't advertise these.
      // Users can refine in modelOverrides if a specific model needs more.
      context_window: 32_000,
      max_tokens: 4_096,
    }));
  },
};

function parseModelList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── Stream function ────────────────────────────────────────────────
//
// pi-ai's openai-completions stream is registered for the literal
// api: 'openai-completions'. provider-settings.ts rewrites our models
// to api: 'local-llm-openai' so they route to *us*, not pi-ai. We
// register `local-llm-openai` and delegate to pi-ai by passing a model
// clone with the api temporarily set back to 'openai-completions'.
//
// This is the same trick bedrock-camp would use if it wanted to share
// a stream impl, but kept inline here because the delegation is two
// lines and avoids a second indirection layer.

const OPENAI_COMPLETIONS_API: Api = 'openai-completions' as Api;
const LOCAL_LLM_API: Api = `${PROVIDER_ID}-openai` as Api;

interface LocalLlmStreamOptions extends StreamOptions {
  // local servers accept any non-empty string; we inject one if missing
  apiKey?: string;
}

function asOpenAIModel(model: Model<Api>): Model<'openai-completions'> {
  return { ...model, api: OPENAI_COMPLETIONS_API } as unknown as Model<'openai-completions'>;
}

function ensureApiKey<T extends { apiKey?: string }>(options: T | undefined): T {
  const opts = (options ?? {}) as T;
  if (!opts.apiKey || opts.apiKey.length === 0) {
    return { ...opts, apiKey: PLACEHOLDER_API_KEY };
  }
  return opts;
}

const streamLocalLlmOpenAI = (
  model: Model<Api>,
  context: Context,
  options: LocalLlmStreamOptions = {}
): AssistantMessageEventStream => {
  if (model.id === UNCONFIGURED_MODEL_ID) {
    return errorStream(
      model,
      'Local LLM is not configured. Set base URL and model IDs in Settings.'
    );
  }
  if (!model.baseUrl) {
    return errorStream(model, 'Local LLM base URL is required (e.g. http://localhost:11434/v1).');
  }
  return streamOpenAICompletions(asOpenAIModel(model), context, ensureApiKey(options));
};

const streamSimpleLocalLlmOpenAI = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions
): AssistantMessageEventStream => {
  if (model.id === UNCONFIGURED_MODEL_ID) {
    return errorStream(
      model,
      'Local LLM is not configured. Set base URL and model IDs in Settings.'
    );
  }
  if (!model.baseUrl) {
    return errorStream(model, 'Local LLM base URL is required (e.g. http://localhost:11434/v1).');
  }
  return streamSimpleOpenAICompletions(asOpenAIModel(model), context, ensureApiKey(options));
};

function errorStream(model: Model<Api>, message: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    errorMessage: message,
    timestamp: Date.now(),
  };
  // Async push so subscribers attached on the same tick receive the event.
  queueMicrotask(() => {
    stream.push({ type: 'error', reason: 'error', error: output });
    stream.end();
  });
  return stream;
}

// ── Registration ───────────────────────────────────────────────────

export function register(): void {
  registerApiProvider({
    api: LOCAL_LLM_API,
    stream: streamLocalLlmOpenAI as Parameters<typeof registerApiProvider>[0]['stream'],
    streamSimple: streamSimpleLocalLlmOpenAI as Parameters<
      typeof registerApiProvider
    >[0]['streamSimple'],
  });
}

// ── Discovery / detection helpers (exported for future UI wiring) ──
//
// Kept in this file so they ship with the provider. Today they're not
// called from the dialog; a follow-up can add a "Detect server" button
// that calls verifyConnection() and writes discovered model IDs into
// the deployment field.

export type LocalLlmRuntimeKind =
  | 'ollama'
  | 'lmstudio'
  | 'llamacpp'
  | 'vllm'
  | 'mlx'
  | 'jan'
  | 'localai'
  | 'unknown';

export interface LocalLlmRuntimeInfo {
  kind: LocalLlmRuntimeKind;
  /** Server-reported version, when the runtime exposes one. */
  version?: string;
}

export interface LocalLlmConnectionResult {
  ok: boolean;
  runtime: LocalLlmRuntimeInfo;
  models: string[];
  error?: {
    /** Best-effort diagnosis to drive UI hints. */
    kind: 'cors' | 'connection' | 'auth' | 'http' | 'unknown';
    message: string;
    hint?: string;
  };
}

/** Return the origin (scheme://host:port) of an OpenAI base URL.
 *  e.g. "http://localhost:11434/v1" -> "http://localhost:11434". */
export function originOf(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return baseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  }
}

/** Append `/v1` when the user typed only the host (no path). Leaves
 *  any explicit path alone — `/v1`, `/openai/v1`, custom mounts. The
 *  full streaming layer also relies on `/v1` being present in baseUrl,
 *  so this only papers over the discover path; users who type the host
 *  alone will still hit a 404 on first chat. The `baseUrlDescription`
 *  in the config tells them `/v1` is required, but be forgiving here. */
function normalizeBaseUrl(baseUrl: string): string {
  const stripped = baseUrl.replace(/\/+$/, '');
  try {
    const u = new URL(stripped);
    if (u.pathname === '' || u.pathname === '/') return `${stripped}/v1`;
  } catch {
    /* fall through — let the caller surface the URL error */
  }
  return stripped;
}

/** GET /v1/models on the configured base URL. Returns model IDs.
 *  Caller is responsible for surfacing CORS/connection errors. */
export async function discoverModels(
  baseUrl: string,
  apiKey?: string,
  signal?: AbortSignal
): Promise<string[]> {
  const url = `${normalizeBaseUrl(baseUrl)}/models`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey && apiKey.length > 0) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(url, { method: 'GET', headers, signal });
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  if (!Array.isArray(body.data)) return [];
  return body.data.map((m) => m.id ?? '').filter((id) => id.length > 0);
}

/** Probe a few well-known endpoints to fingerprint the runtime.
 *  Falls back to 'unknown' if nothing matches — discovery still works. */
export async function detectRuntime(
  baseUrl: string,
  signal?: AbortSignal
): Promise<LocalLlmRuntimeInfo> {
  const origin = originOf(baseUrl);
  // Ollama exposes /api/version on the server root (not /v1).
  const ollama = await tryJson(`${origin}/api/version`, signal);
  if (ollama && typeof (ollama as { version?: unknown }).version === 'string') {
    return { kind: 'ollama', version: (ollama as { version: string }).version };
  }
  // LM Studio exposes /api/v0 (its own native API). Tighten the check
  // to LM Studio's known response shape (`{ object: 'list', data: [...] }`)
  // so any random JSON-200 at that path doesn't get misidentified.
  const lmstudio = await tryJson(`${origin}/api/v0/models`, signal);
  if (lmstudio && (lmstudio as Record<string, unknown>).object === 'list') {
    return { kind: 'lmstudio' };
  }
  // llama.cpp's llama-server exposes /props with build_info etc.
  const llamacpp = await tryJson(`${origin}/props`, signal);
  if (llamacpp && 'build_info' in (llamacpp as Record<string, unknown>)) {
    const build = (llamacpp as { build_info?: { version?: string } }).build_info;
    return { kind: 'llamacpp', version: build?.version };
  }
  // Heuristic fallback by port — best-effort, never wrong-blocks the user.
  const port = safePort(baseUrl);
  if (port === '11434') return { kind: 'ollama' };
  if (port === '1234') return { kind: 'lmstudio' };
  if (port === '8000') return { kind: 'vllm' };
  if (port === '1337') return { kind: 'jan' };
  return { kind: 'unknown' };
}

function safePort(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).port || null;
  } catch {
    return null;
  }
}

async function tryJson(url: string, signal?: AbortSignal): Promise<unknown | null> {
  try {
    const res = await fetch(url, { method: 'GET', signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Fingerprint + list models in one call, with CORS/connection diagnosis.
 *  Designed for an in-dialog "Test connection" button. */
export async function verifyConnection(
  baseUrl: string,
  apiKey?: string,
  signal?: AbortSignal
): Promise<LocalLlmConnectionResult> {
  let runtime: LocalLlmRuntimeInfo = { kind: 'unknown' };
  try {
    runtime = await detectRuntime(baseUrl, signal);
  } catch {
    /* runtime stays unknown; the discovery call below will surface the real error */
  }
  try {
    const models = await discoverModels(baseUrl, apiKey, signal);
    return { ok: true, runtime, models };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const diagnosed = diagnoseError(message, runtime.kind);
    log.warn('verifyConnection failed', { baseUrl, runtime: runtime.kind, message });
    return { ok: false, runtime, models: [], error: diagnosed };
  }
}

function diagnoseError(
  message: string,
  runtime: LocalLlmRuntimeKind
): NonNullable<LocalLlmConnectionResult['error']> {
  // Browser fetch errors don't expose the underlying CORS reason in
  // `message`. The shape is "Failed to fetch" + (optionally) a console
  // log the SW intercepts. We diagnose by combining message text with
  // the runtime hint.
  const lower = message.toLowerCase();
  if (lower.includes('failed to fetch') || lower.includes('networkerror')) {
    if (runtime === 'ollama') {
      return {
        kind: 'cors',
        message,
        hint:
          'Ollama rejects requests from non-localhost origins by default. ' +
          'Set OLLAMA_ORIGINS=* (or chrome-extension://*) and restart Ollama. ' +
          'macOS: `launchctl setenv OLLAMA_ORIGINS "*"` then quit and relaunch the Ollama app.',
      };
    }
    return {
      kind: 'connection',
      message,
      hint: 'Server unreachable. Check the URL and that the server is running.',
    };
  }
  if (lower.includes(' 401') || lower.includes(' 403')) {
    return {
      kind: 'auth',
      message,
      hint: 'Server returned an auth error. If your endpoint requires a key, set it in Settings.',
    };
  }
  if (/-> \d{3} /.test(message)) {
    return { kind: 'http', message };
  }
  return { kind: 'unknown', message };
}
