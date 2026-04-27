/**
 * Local SwiftLM — OpenAI-compatible LLM running on localhost via the
 * Sliccstart Models tab.
 *
 * Routes through `/api/fetch-proxy` in CLI/Electron (X-Target-URL header)
 * and direct fetch in extension mode, mirroring `bedrock-camp.ts`. Going
 * via the proxy avoids browser cross-origin headaches with the OpenAI
 * SDK (the SDK's `credentials: 'include'` fetch is incompatible with
 * SwiftLM's wildcard CORS response).
 *
 * No auth/baseUrl configuration: SwiftLM's URL is hardcoded to its CLI
 * default (`http://localhost:5413/v1`) and the server is unauthenticated.
 * The model list is fetched from `/v1/models` + `/health` at boot and
 * cached in localStorage so `getModelIds` (which must be sync) can return
 * the currently-loaded model. When SwiftLM isn't reachable, the cache is
 * cleared and the provider's model list returns empty — the entry stops
 * appearing in the chat dropdown until SwiftLM comes back up.
 */

import type { ProviderConfig, ModelMetadata } from '../types.js';
import {
  registerApiProvider,
  calculateCost,
  createAssistantMessageEventStream,
} from '@mariozechner/pi-ai';
import type { AssistantMessageEventStream } from '@mariozechner/pi-ai';
import { transformMessages } from '@mariozechner/pi-ai/dist/providers/transform-messages.js';
import { buildBaseOptions } from '@mariozechner/pi-ai/dist/providers/simple-options.js';
import type {
  Api,
  Model,
  Context,
  SimpleStreamOptions,
  StreamOptions,
  AssistantMessage,
  TextContent,
  ThinkingContent,
  ToolCall,
} from '@mariozechner/pi-ai';

const PROVIDER_ID = 'swiftlm';
const SWIFTLM_BASE_URL = 'http://localhost:5413';
const SWIFTLM_API_TYPE = 'swiftlm-openai' as Api;
const MODELS_CACHE_KEY = 'swiftlm:models';

const isExtension =
  typeof chrome !== 'undefined' && !!(chrome as { runtime?: { id?: string } })?.runtime?.id;
const isBrowser =
  typeof localStorage !== 'undefined' &&
  typeof fetch !== 'undefined' &&
  typeof window !== 'undefined';

// ── Model discovery / cache ─────────────────────────────────────────

interface CachedModel {
  id: string;
  name?: string;
  /** True when SwiftLM was launched with `--vision` and this model is a
   *  VLM (Gemma 4, Qwen-VL, Pixtral, ...). Sliccstart sets the flag
   *  automatically based on the model's `config.json`. */
  supportsVision?: boolean;
}

/** Build a fetch URL pair (`fetchUrl`, `targetUrl`) that routes through
 *  the slicc-server proxy in CLI/Electron and hits SwiftLM directly in
 *  extension mode. The proxy adds an `X-Target-URL` header that the server
 *  forwards transparently. */
function proxyURL(targetUrl: string): { url: string; headers: Record<string, string> } {
  if (isExtension) {
    return { url: targetUrl, headers: {} };
  }
  return { url: '/api/fetch-proxy', headers: { 'X-Target-URL': targetUrl } };
}

/** Best-effort fetch of `GET /v1/models` + `GET /health`. Refreshes the
 *  local cache on success; clears it on any error so SwiftLM transparently
 *  disappears from the model dropdown when the server stops. */
async function refreshModelsCache(): Promise<void> {
  if (!isBrowser) return;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    const modelsTarget = proxyURL(`${SWIFTLM_BASE_URL}/v1/models`);
    const healthTarget = proxyURL(`${SWIFTLM_BASE_URL}/health`);
    const [modelsRes, healthRes] = await Promise.all([
      fetch(modelsTarget.url, { signal: controller.signal, headers: modelsTarget.headers }),
      fetch(healthTarget.url, { signal: controller.signal, headers: healthTarget.headers }).catch(
        () => null
      ),
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
      // Sliccstart launches SwiftLM at the model's declared
      // `max_position_embeddings` (Gemma 4 / Qwen 3.6 ship at 262 144).
      context_window: 262_144,
      // Thinking-capable models (Gemma 4, Qwen 3.6) routinely burn
      // 4–6k reasoning tokens before any user-visible content emits, and
      // tool-call rounds add more on top. 8k was clipping the answer at
      // `finish_reason: length`. 32k leaves headroom for one full
      // think → content → tool-call cycle without being wasteful.
      max_tokens: 32_768,
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

// ── Message conversion (OpenAI Chat Completions) ────────────────────

interface ContentBlock {
  type: string;
  text?: string;
  mimeType?: string;
  data?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  toolCallId?: string;
  isError?: boolean;
  content?: ContentBlock[];
}

interface TransformedMessage {
  role: string;
  content: string | ContentBlock[];
  toolCallId?: string;
  isError?: boolean;
}

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | Array<Record<string, unknown>> | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

function normalizeToolCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function convertMessages(context: Context, model: Model<Api>): OpenAIChatMessage[] {
  const transformed = transformMessages(
    context.messages,
    model,
    normalizeToolCallId
  ) as TransformedMessage[];
  const result: OpenAIChatMessage[] = [];

  for (const m of transformed) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        result.push({ role: 'user', content: m.content });
      } else {
        const parts = (m.content as ContentBlock[]).map((c) => {
          if (c.type === 'text') return { type: 'text', text: c.text ?? '' };
          if (c.type === 'image') {
            return {
              type: 'image_url',
              image_url: { url: `data:${c.mimeType};base64,${c.data}` },
            };
          }
          return { type: 'text', text: JSON.stringify(c) };
        });
        result.push({ role: 'user', content: parts });
      }
    } else if (m.role === 'assistant') {
      const blocks = m.content as ContentBlock[];
      const text = blocks
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('');
      const toolCalls = blocks
        .filter((c) => c.type === 'toolCall')
        .map((c) => ({
          id: c.id ?? '',
          type: 'function' as const,
          function: {
            name: c.name ?? '',
            arguments: JSON.stringify(c.arguments ?? {}),
          },
        }));
      if (toolCalls.length) {
        result.push({ role: 'assistant', content: text || null, tool_calls: toolCalls });
      } else {
        result.push({ role: 'assistant', content: text });
      }
    } else if (m.role === 'toolResult') {
      const blocks = m.content as ContentBlock[] | undefined;
      result.push({
        role: 'tool',
        tool_call_id: m.toolCallId ?? '',
        content:
          blocks?.map((c) => (c.type === 'text' ? (c.text ?? '') : JSON.stringify(c))).join('') ||
          '',
      });
    }
  }
  return result;
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

function convertTools(tools: Context['tools']): OpenAITool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as Record<string, unknown>,
    },
  }));
}

// ── Stream output helpers ───────────────────────────────────────────

interface ToolCallAccumulator extends ToolCall {
  /** Concatenated `function.arguments` strings as they arrive. Parsed into
   *  `arguments` JSON at the end (or every delta when valid). */
  _partialJson: string;
  /** Index in the assistant's content array (set when first emitted). */
  _contentIndex: number;
}

function findOrCreateTextBlock(
  output: AssistantMessage,
  stream: AssistantMessageEventStream
): { block: TextContent; index: number; created: boolean } {
  const existing = output.content.find((b): b is TextContent => b.type === 'text');
  if (existing) {
    return { block: existing, index: output.content.indexOf(existing), created: false };
  }
  const block: TextContent = { type: 'text', text: '' };
  output.content.push(block);
  const index = output.content.length - 1;
  stream.push({ type: 'text_start', contentIndex: index, partial: output });
  return { block, index, created: true };
}

function findOrCreateThinkingBlock(
  output: AssistantMessage,
  stream: AssistantMessageEventStream
): { block: ThinkingContent; index: number; created: boolean } {
  const existing = output.content.find((b): b is ThinkingContent => b.type === 'thinking');
  if (existing) {
    return { block: existing, index: output.content.indexOf(existing), created: false };
  }
  const block: ThinkingContent = { type: 'thinking', thinking: '' };
  output.content.push(block);
  const index = output.content.length - 1;
  stream.push({ type: 'thinking_start', contentIndex: index, partial: output });
  return { block, index, created: true };
}

// ── SSE parsing ─────────────────────────────────────────────────────

interface SSEDelta {
  role?: string;
  content?: string | null;
  /** llama-server / SwiftLM emit thinking/reasoning tokens here. */
  reasoning_content?: string | null;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface SSEChunk {
  choices?: Array<{
    index?: number;
    delta?: SSEDelta;
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/** Find the next event boundary in `buffer`. Returns the index of the
 *  blank line and the boundary length so the caller can slice past it.
 *  Per the SSE spec a boundary is a blank line, where line terminators
 *  may be CR, LF, or CRLF — Hummingbird-backed servers (SwiftLM, the
 *  slicc-server proxy) emit `\r\n\r\n`, llama-server emits `\n\n`. */
function nextEventBoundary(buffer: string): { index: number; length: number } | null {
  const crlf = buffer.indexOf('\r\n\r\n');
  const lf = buffer.indexOf('\n\n');
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return { index: crlf, length: 4 };
  if (lf >= 0) return { index: lf, length: 2 };
  return null;
}

async function* iterateSSE(response: Response): AsyncIterable<SSEChunk> {
  const body = response.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      // Flush a trailing event without a final blank line (defensive
      // against servers that don't terminate the last frame cleanly).
      const tail = buffer.trim();
      if (tail) {
        const payload = parseDataPayload(tail);
        if (payload && payload !== '[DONE]') {
          try {
            yield JSON.parse(payload) as SSEChunk;
          } catch {
            /* drop malformed tail */
          }
        }
      }
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const boundary = nextEventBoundary(buffer);
      if (!boundary) break;
      const event = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      const payload = parseDataPayload(event);
      if (!payload) continue;
      if (payload === '[DONE]') return;
      try {
        yield JSON.parse(payload) as SSEChunk;
      } catch {
        // Skip malformed chunks rather than failing the stream.
      }
    }
  }
}

/** Pull the JSON payload out of one SSE event, joining multi-line `data:`
 *  fields the way the spec requires. Returns null when the event has no
 *  data field (heartbeats, comment-only, etc.). */
function parseDataPayload(event: string): string | null {
  const lines = event
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trimStart());
  if (lines.length === 0) return null;
  return lines.join('');
}

// ── Stream function ─────────────────────────────────────────────────

const streamSwiftLM = (
  model: Model<Api>,
  context: Context,
  options: StreamOptions = {}
): AssistantMessageEventStream => {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: SWIFTLM_API_TYPE,
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
      stopReason: 'stop',
      timestamp: Date.now(),
    };

    try {
      const targetUrl = `${SWIFTLM_BASE_URL}/v1/chat/completions`;
      const { url, headers: proxyHeaders } = proxyURL(targetUrl);

      const tools = convertTools(context.tools);
      const messages: OpenAIChatMessage[] = [
        ...(context.systemPrompt
          ? [{ role: 'system' as const, content: context.systemPrompt }]
          : []),
        ...convertMessages(context, model),
      ];

      const body: Record<string, unknown> = {
        model: model.id,
        messages,
        stream: true,
        stream_options: { include_usage: true },
      };
      if (options.maxTokens) body.max_tokens = options.maxTokens;
      if (options.temperature !== undefined) body.temperature = options.temperature;
      if (tools) body.tools = tools;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...proxyHeaders,
        ...(options.headers ?? {}),
      };

      stream.push({ type: 'start', partial: output });

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`SwiftLM error (${response.status}): ${errText}`);
      }

      const toolCallsByIndex = new Map<number, ToolCallAccumulator>();

      for await (const chunk of iterateSSE(response)) {
        if (chunk.usage) {
          output.usage.input = chunk.usage.prompt_tokens ?? 0;
          output.usage.output = chunk.usage.completion_tokens ?? 0;
          output.usage.totalTokens = chunk.usage.total_tokens ?? 0;
          calculateCost(model, output.usage);
        }

        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta ?? {};

          if (delta.reasoning_content) {
            const thinking = findOrCreateThinkingBlock(output, stream);
            thinking.block.thinking += delta.reasoning_content;
            stream.push({
              type: 'thinking_delta',
              contentIndex: thinking.index,
              delta: delta.reasoning_content,
              partial: output,
            });
          }

          if (delta.content) {
            const text = findOrCreateTextBlock(output, stream);
            text.block.text += delta.content;
            stream.push({
              type: 'text_delta',
              contentIndex: text.index,
              delta: delta.content,
              partial: output,
            });
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const tcIndex = tc.index ?? 0;
              let acc = toolCallsByIndex.get(tcIndex);
              if (!acc) {
                acc = {
                  type: 'toolCall',
                  id: tc.id ?? `call_${tcIndex}`,
                  name: tc.function?.name ?? '',
                  arguments: {},
                  _partialJson: '',
                  _contentIndex: output.content.length,
                } as ToolCallAccumulator;
                output.content.push(acc);
                toolCallsByIndex.set(tcIndex, acc);
                stream.push({
                  type: 'toolcall_start',
                  contentIndex: acc._contentIndex,
                  partial: output,
                });
              } else if (tc.id) {
                acc.id = tc.id;
              }
              if (tc.function?.name && !acc.name) acc.name = tc.function.name;
              if (tc.function?.arguments) {
                acc._partialJson += tc.function.arguments;
                try {
                  acc.arguments = JSON.parse(acc._partialJson);
                } catch {
                  /* keep accumulating */
                }
                stream.push({
                  type: 'toolcall_delta',
                  contentIndex: acc._contentIndex,
                  delta: tc.function.arguments,
                  partial: output,
                });
              }
            }
          }

          if (choice.finish_reason) {
            output.stopReason =
              choice.finish_reason === 'tool_calls'
                ? 'toolUse'
                : choice.finish_reason === 'length'
                  ? 'length'
                  : 'stop';
          }
        }
      }

      // Finalize content blocks
      for (const block of output.content) {
        const idx = output.content.indexOf(block);
        if (block.type === 'toolCall') {
          const tc = block as ToolCallAccumulator;
          try {
            tc.arguments = JSON.parse(tc._partialJson || '{}');
          } catch {
            /* leave partial as-is */
          }
          delete (tc as Partial<ToolCallAccumulator>)._partialJson;
          delete (tc as Partial<ToolCallAccumulator>)._contentIndex;
          stream.push({
            type: 'toolcall_end',
            contentIndex: idx,
            toolCall: block as ToolCall,
            partial: output,
          });
        } else if (block.type === 'text') {
          stream.push({
            type: 'text_end',
            contentIndex: idx,
            content: (block as TextContent).text,
            partial: output,
          });
        } else if (block.type === 'thinking') {
          stream.push({
            type: 'thinking_end',
            contentIndex: idx,
            content: (block as ThinkingContent).thinking,
            partial: output,
          });
        }
      }

      stream.push({
        type: 'done',
        reason: output.stopReason as 'stop' | 'length' | 'toolUse',
        message: output,
      });
      stream.end();
    } catch (error) {
      output.stopReason = options.signal?.aborted ? 'aborted' : 'error';
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({ type: 'error', reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
};

const streamSimpleSwiftLM = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions
): AssistantMessageEventStream => {
  const base = buildBaseOptions(model, options, undefined);
  return streamSwiftLM(model, context, base as StreamOptions);
};

// ── Registration ────────────────────────────────────────────────────

export function register(): void {
  // Kick off the cache refresh once at module load. `getModelIds` is sync
  // so the first chat-panel render after boot will see whatever was last
  // cached (or empty); subsequent renders pick up live data.
  void refreshModelsCache();

  registerApiProvider({
    api: SWIFTLM_API_TYPE,
    stream: streamSwiftLM as Parameters<typeof registerApiProvider>[0]['stream'],
    streamSimple: streamSimpleSwiftLM as Parameters<typeof registerApiProvider>[0]['streamSimple'],
  });
}

export const __refreshSwiftLMModels = refreshModelsCache;
