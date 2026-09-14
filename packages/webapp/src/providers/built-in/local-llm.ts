import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  StreamOptions,
} from '@earendil-works/pi-ai';
import {
  createAssistantMessageEventStream,
  registerApiProvider,
  streamOpenAICompletions,
  streamSimpleOpenAICompletions,
} from '@earendil-works/pi-ai/compat';
import { createLogger } from '../../base/logger.js';
import { getDeploymentForProvider } from '../account-store.js';
import type { ProviderConfig } from '../types.js';

const log = createLogger('local-llm');

const PROVIDER_ID = 'local-llm';

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

const OPENAI_COMPLETIONS_API: Api = 'openai-completions' as Api;
const LOCAL_LLM_API: Api = `${PROVIDER_ID}-openai` as Api;

interface LocalLlmStreamOptions extends StreamOptions {
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

  queueMicrotask(() => {
    stream.push({ type: 'error', reason: 'error', error: output });
    stream.end();
  });
  return stream;
}

export function register(): void {
  registerApiProvider({
    api: LOCAL_LLM_API,
    stream: streamLocalLlmOpenAI as Parameters<typeof registerApiProvider>[0]['stream'],
    streamSimple: streamSimpleLocalLlmOpenAI as Parameters<
      typeof registerApiProvider
    >[0]['streamSimple'],
  });
}

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

  version?: string;
}

export interface LocalLlmConnectionResult {
  ok: boolean;
  runtime: LocalLlmRuntimeInfo;
  models: string[];
  error?: {
    kind: 'cors' | 'connection' | 'auth' | 'http' | 'unknown';
    message: string;
    hint?: string;
  };
}

interface LmStudioModelsProbe {
  object: 'list';
}

interface LlamaCppPropsProbe {
  build_info?: { version?: string };
}

function isLmStudioModelsProbe(value: unknown): value is LmStudioModelsProbe {
  return (
    typeof value === 'object' &&
    value !== null &&
    'object' in value &&
    (value as LmStudioModelsProbe).object === 'list'
  );
}

function isLlamaCppPropsProbe(value: unknown): value is LlamaCppPropsProbe {
  return typeof value === 'object' && value !== null && 'build_info' in value;
}

export function originOf(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return baseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  const stripped = baseUrl.replace(/\/+$/, '');
  try {
    const u = new URL(stripped);
    if (u.pathname === '' || u.pathname === '/') return `${stripped}/v1`;
  } catch {}
  return stripped;
}

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

export async function detectRuntime(
  baseUrl: string,
  signal?: AbortSignal
): Promise<LocalLlmRuntimeInfo> {
  const origin = originOf(baseUrl);

  const ollama = await tryJson(`${origin}/api/version`, signal);
  if (ollama && typeof (ollama as { version?: unknown }).version === 'string') {
    return { kind: 'ollama', version: (ollama as { version: string }).version };
  }

  const lmstudio = await tryJson(`${origin}/api/v0/models`, signal);
  if (isLmStudioModelsProbe(lmstudio)) {
    return { kind: 'lmstudio' };
  }

  const llamacpp = await tryJson(`${origin}/props`, signal);
  if (isLlamaCppPropsProbe(llamacpp)) {
    return { kind: 'llamacpp', version: llamacpp.build_info?.version };
  }

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

export async function verifyConnection(
  baseUrl: string,
  apiKey?: string,
  signal?: AbortSignal
): Promise<LocalLlmConnectionResult> {
  let runtime: LocalLlmRuntimeInfo = { kind: 'unknown' };
  try {
    runtime = await detectRuntime(baseUrl, signal);
  } catch {}
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
