/**
 * Azure OpenAI — GPT models via Azure AI Foundry Chat Completions API.
 *
 * Uses AzureOpenAI client from the openai SDK which handles deployment
 * routing, api-version query params, and api-key auth automatically.
 *
 * LOCAL TESTING ONLY — not committed.
 */

import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  TextContent,
  ToolCall,
} from '@earendil-works/pi-ai';
import {
  calculateCost,
  createAssistantMessageEventStream,
  registerApiProvider,
} from '@earendil-works/pi-ai';
import { buildBaseOptions } from '@earendil-works/pi-ai/dist/providers/simple-options.js';
import { transformMessages } from '@earendil-works/pi-ai/dist/providers/transform-messages.js';
import { AzureOpenAI } from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { getApiVersionForProvider, getDeploymentForProvider } from '../account-store.js';
import type { ProviderConfig } from '../types.js';

// ── Config ─────────────────────────────────────────────────────────

const PROVIDER_ID = 'azure-openai';
const API_VERSION = '2024-12-01-preview';

export const config: ProviderConfig = {
  id: PROVIDER_ID,
  name: 'Azure OpenAI',
  description: 'GPT models via Azure AI Foundry',
  requiresApiKey: true,
  apiKeyPlaceholder: 'Azure API key',
  apiKeyEnvVar: 'AZURE_OPENAI_API_KEY',
  requiresBaseUrl: true,
  baseUrlPlaceholder: 'https://your-resource.cognitiveservices.azure.com/',
  baseUrlDescription: 'Azure resource endpoint',
  requiresDeployment: true,
  deploymentPlaceholder: 'gpt-4.1-mini, gpt-4o, o4-mini',
  deploymentDescription: 'Comma-separated deployment names (from Azure Portal → Deployments)',
  requiresApiVersion: true,
  apiVersionDefault: API_VERSION,
  apiVersionDescription: 'Azure OpenAI API version',
  // Each deployment becomes a selectable model in the chat dropdown.
  getModelIds: () => {
    const raw = getDeploymentForProvider(PROVIDER_ID);
    if (!raw)
      return [{ id: 'azure-unconfigured', name: 'Azure OpenAI (set deployments in Settings)' }];
    const deployments = raw
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);
    if (deployments.length === 0)
      return [{ id: 'azure-unconfigured', name: 'Azure OpenAI (set deployments in Settings)' }];
    return deployments.map((d) => {
      const isReasoning = d.startsWith('o1') || d.startsWith('o3') || d.startsWith('o4');
      return { id: d, name: `${d} (Azure)`, reasoning: isReasoning, input: ['text', 'image'] };
    });
  },
};

// ── Message conversion ─────────────────────────────────────────────

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

function normalizeToolCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function convertMessages(context: Context, model: Model<Api>): ChatCompletionMessageParam[] {
  const transformed = transformMessages(
    context.messages,
    model,
    normalizeToolCallId
  ) as TransformedMessage[];
  const result: ChatCompletionMessageParam[] = [];

  for (const m of transformed) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        result.push({ role: 'user', content: m.content });
      } else {
        const parts = (m.content as ContentBlock[]).map((c) => {
          if (c.type === 'text') return { type: 'text' as const, text: c.text ?? '' };
          if (c.type === 'image')
            return {
              type: 'image_url' as const,
              image_url: { url: `data:${c.mimeType};base64,${c.data}` },
            };
          return { type: 'text' as const, text: JSON.stringify(c) };
        });
        result.push({ role: 'user', content: parts });
      }
    } else if (m.role === 'assistant') {
      const blocks = m.content as ContentBlock[];
      const content = blocks
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('');
      const toolCalls = blocks
        .filter((c) => c.type === 'toolCall')
        .map((c) => ({
          id: c.id ?? '',
          type: 'function' as const,
          function: { name: c.name ?? '', arguments: JSON.stringify(c.arguments ?? {}) },
        }));
      if (toolCalls.length) {
        result.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });
      } else {
        result.push({ role: 'assistant', content });
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

function convertTools(tools: Context['tools']): ChatCompletionTool[] | undefined {
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

// ── Streaming helpers ──────────────────────────────────────────────

interface ToolCallAccumulator extends ToolCall {
  _partialJson: string;
}

function findOrCreateTextBlock(output: AssistantMessage): { block: TextContent; index: number } {
  const existing = output.content.find((b): b is TextContent => b.type === 'text');
  if (existing) return { block: existing, index: output.content.indexOf(existing) };
  const block: TextContent = { type: 'text', text: '' };
  output.content.push(block);
  return { block, index: output.content.length - 1 };
}

function findToolCallById(output: AssistantMessage, id: string): ToolCallAccumulator | undefined {
  return output.content.find((b): b is ToolCallAccumulator => b.type === 'toolCall' && b.id === id);
}

// ── Stream function ────────────────────────────────────────────────

type StreamHandle = ReturnType<typeof createAssistantMessageEventStream>;
type ChoiceDelta = ChatCompletionChunk['choices'][number]['delta'];
type ToolCallDelta = NonNullable<ChoiceDelta['tool_calls']>[number];

function createInitialOutput(model: Model<Api>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'azure-openai-anthropic' as Api,
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
}

function buildAzureClient(
  model: Model<Api>,
  options: SimpleStreamOptions & { apiKey?: string }
): { client: AzureOpenAI; deployment: string } {
  const apiKey = options.apiKey;
  if (!apiKey) throw new Error('Azure API key is required');
  const endpoint = model.baseUrl;
  if (!endpoint) throw new Error('Azure endpoint is required');

  const headers: Record<string, string> = {};
  if (model.headers) Object.assign(headers, model.headers);
  if (options.headers) Object.assign(headers, options.headers);

  const apiVersion = getApiVersionForProvider(PROVIDER_ID) || API_VERSION;
  // model.id = deployment name (selected from the chat dropdown, one per deployment)
  const deployment = model.id;
  const client = new AzureOpenAI({
    endpoint: endpoint.replace(/\/+$/, ''),
    apiKey,
    deployment,
    apiVersion,
    dangerouslyAllowBrowser: true,
    defaultHeaders: headers,
  });
  return { client, deployment };
}

function buildChatMessages(context: Context, model: Model<Api>): ChatCompletionMessageParam[] {
  return [
    ...(context.systemPrompt ? [{ role: 'system' as const, content: context.systemPrompt }] : []),
    ...convertMessages(context, model),
  ];
}

function applyUsageChunk(
  output: AssistantMessage,
  model: Model<Api>,
  usage: ChatCompletionChunk['usage']
): void {
  if (!usage) return;
  output.usage.input = usage.prompt_tokens ?? 0;
  output.usage.output = usage.completion_tokens ?? 0;
  output.usage.totalTokens = usage.total_tokens ?? 0;
  calculateCost(model, output.usage);
}

function mapFinishReason(reason: string): AssistantMessage['stopReason'] {
  if (reason === 'tool_calls') return 'toolUse';
  if (reason === 'length') return 'length';
  return 'stop';
}

function emitTextDelta(stream: StreamHandle, output: AssistantMessage, text: string): void {
  const { block, index } = findOrCreateTextBlock(output);
  if (block.text === '') {
    stream.push({ type: 'text_start', contentIndex: index, partial: output });
  }
  block.text += text;
  stream.push({ type: 'text_delta', contentIndex: index, delta: text, partial: output });
}

function ensureToolCallAccumulator(
  stream: StreamHandle,
  output: AssistantMessage,
  tc: ToolCallDelta
): ToolCallAccumulator | undefined {
  const existing = tc.id ? findToolCallById(output, tc.id) : undefined;
  if (existing || !tc.id) return existing;
  const created: ToolCallAccumulator = {
    type: 'toolCall',
    id: tc.id,
    name: tc.function?.name ?? '',
    arguments: {},
    _partialJson: '',
  };
  output.content.push(created);
  stream.push({
    type: 'toolcall_start',
    contentIndex: output.content.length - 1,
    partial: output,
  });
  return created;
}

function appendToolCallArguments(
  stream: StreamHandle,
  output: AssistantMessage,
  acc: ToolCallAccumulator,
  argChunk: string
): void {
  acc._partialJson += argChunk;
  try {
    acc.arguments = JSON.parse(acc._partialJson);
  } catch {
    /* partial JSON, keep accumulating */
  }
  stream.push({
    type: 'toolcall_delta',
    contentIndex: output.content.indexOf(acc),
    delta: argChunk,
    partial: output,
  });
}

function emitToolCallsDelta(
  stream: StreamHandle,
  output: AssistantMessage,
  toolCalls: NonNullable<ChoiceDelta['tool_calls']>
): void {
  for (const tc of toolCalls) {
    const acc = ensureToolCallAccumulator(stream, output, tc);
    if (acc && tc.function?.arguments) {
      appendToolCallArguments(stream, output, acc, tc.function.arguments);
    }
  }
}

function processChoice(
  stream: StreamHandle,
  output: AssistantMessage,
  choice: ChatCompletionChunk['choices'][number]
): void {
  const delta = choice.delta;
  if (!delta) return;
  if (delta.content) emitTextDelta(stream, output, delta.content);
  if (delta.tool_calls) emitToolCallsDelta(stream, output, delta.tool_calls);
  if (choice.finish_reason) output.stopReason = mapFinishReason(choice.finish_reason);
}

function finalizeToolCall(
  stream: StreamHandle,
  output: AssistantMessage,
  block: ToolCallAccumulator,
  idx: number
): void {
  try {
    block.arguments = JSON.parse(block._partialJson || '{}');
  } catch {
    /* keep partial */
  }
  delete (block as Partial<ToolCallAccumulator>)._partialJson;
  stream.push({
    type: 'toolcall_end',
    contentIndex: idx,
    toolCall: block as ToolCall,
    partial: output,
  });
}

function finalizeContentBlocks(stream: StreamHandle, output: AssistantMessage): void {
  for (let idx = 0; idx < output.content.length; idx += 1) {
    const block = output.content[idx];
    if (block.type === 'toolCall') {
      finalizeToolCall(stream, output, block as ToolCallAccumulator, idx);
    } else if (block.type === 'text') {
      stream.push({
        type: 'text_end',
        contentIndex: idx,
        content: (block as TextContent).text,
        partial: output,
      });
    }
  }
}

async function runAzureStream(
  stream: StreamHandle,
  output: AssistantMessage,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions & { apiKey?: string }
): Promise<void> {
  const { client, deployment } = buildAzureClient(model, options);
  const tools = convertTools(context.tools);
  // Match the Azure Portal SDK snippet:
  //   new AzureOpenAI({ endpoint, apiKey, deployment, apiVersion })
  const openaiStream = await client.chat.completions.create({
    model: deployment,
    messages: buildChatMessages(context, model),
    stream: true,
    stream_options: { include_usage: true },
    ...(options.maxTokens ? { max_completion_tokens: options.maxTokens } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(tools ? { tools } : {}),
  });

  stream.push({ type: 'start', partial: output });

  for await (const chunk of openaiStream as AsyncIterable<ChatCompletionChunk>) {
    applyUsageChunk(output, model, chunk.usage);
    for (const choice of chunk.choices ?? []) {
      processChoice(stream, output, choice);
    }
  }

  finalizeContentBlocks(stream, output);
  stream.push({
    type: 'done',
    reason: output.stopReason as 'stop' | 'length' | 'toolUse',
    message: output,
  });
  stream.end();
}

function emitStreamError(
  stream: StreamHandle,
  output: AssistantMessage,
  error: unknown,
  aborted: boolean
): void {
  output.stopReason = aborted ? 'aborted' : 'error';
  output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
  stream.push({ type: 'error', reason: output.stopReason, error: output });
  stream.end();
}

const streamAzureOpenAI = (
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions & { apiKey?: string } = {}
): AssistantMessageEventStream => {
  const stream = createAssistantMessageEventStream();
  const output = createInitialOutput(model);
  void runAzureStream(stream, output, model, context, options).catch((error) => {
    emitStreamError(stream, output, error, Boolean(options.signal?.aborted));
  });
  return stream;
};

const streamSimpleAzureOpenAI = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions
): AssistantMessageEventStream => {
  const apiKey = options?.apiKey;
  if (!apiKey) throw new Error('Azure API key is required');
  const base = buildBaseOptions(model, options, apiKey);
  return streamAzureOpenAI(model, context, { ...base });
};

// ── Registration ───────────────────────────────────────────────────

export function register(): void {
  registerApiProvider({
    api: 'azure-openai-anthropic' as Api,
    stream: streamAzureOpenAI as Parameters<typeof registerApiProvider>[0]['stream'],
    streamSimple: streamSimpleAzureOpenAI as Parameters<
      typeof registerApiProvider
    >[0]['streamSimple'],
  });
}
