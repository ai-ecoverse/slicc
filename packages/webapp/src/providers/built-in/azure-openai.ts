/**
 * Azure OpenAI — GPT models via Azure AI Foundry Chat Completions API.
 *
 * Uses AzureOpenAI client from the openai SDK which handles deployment
 * routing, api-version query params, and api-key auth automatically.
 *
 * LOCAL TESTING ONLY — not committed.
 */

import type { ProviderConfig } from '../types.js';
import {
  registerApiProvider,
  calculateCost,
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import type { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { transformMessages } from '@earendil-works/pi-ai/dist/providers/transform-messages.js';
import { buildBaseOptions } from '@earendil-works/pi-ai/dist/providers/simple-options.js';
import type {
  Api,
  Model,
  Context,
  SimpleStreamOptions,
  AssistantMessage,
  TextContent,
  ToolCall,
} from '@earendil-works/pi-ai';
import { AzureOpenAI } from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { getDeploymentForProvider, getApiVersionForProvider } from '../../ui/provider-settings.js';

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

const streamAzureOpenAI = (
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions & { apiKey?: string } = {}
): AssistantMessageEventStream => {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
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

    try {
      const apiKey = options.apiKey;
      if (!apiKey) throw new Error('Azure API key is required');

      const endpoint = model.baseUrl;
      if (!endpoint) throw new Error('Azure endpoint is required');

      // model.id = deployment name (selected from the chat dropdown, one per deployment)
      const deployment = model.id;

      const headers: Record<string, string> = {};
      if (model.headers) Object.assign(headers, model.headers);
      if (options.headers) Object.assign(headers, options.headers);

      // Match the Azure Portal SDK snippet:
      //   new AzureOpenAI({ endpoint, apiKey, deployment, apiVersion })
      const apiVersion = getApiVersionForProvider(PROVIDER_ID) || API_VERSION;

      const client = new AzureOpenAI({
        endpoint: endpoint.replace(/\/+$/, ''),
        apiKey,
        deployment,
        apiVersion,
        dangerouslyAllowBrowser: true,
        defaultHeaders: headers,
      });

      const messages: ChatCompletionMessageParam[] = [
        ...(context.systemPrompt
          ? [{ role: 'system' as const, content: context.systemPrompt }]
          : []),
        ...convertMessages(context, model),
      ];

      const tools = convertTools(context.tools);
      const openaiStream = await client.chat.completions.create({
        model: deployment,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(options.maxTokens ? { max_completion_tokens: options.maxTokens } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(tools ? { tools } : {}),
      });

      stream.push({ type: 'start', partial: output });

      for await (const chunk of openaiStream as AsyncIterable<ChatCompletionChunk>) {
        if (chunk.usage) {
          output.usage.input = chunk.usage.prompt_tokens ?? 0;
          output.usage.output = chunk.usage.completion_tokens ?? 0;
          output.usage.totalTokens = chunk.usage.total_tokens ?? 0;
          calculateCost(model, output.usage);
        }

        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta;
          if (!delta) continue;

          if (delta.content) {
            const { block, index } = findOrCreateTextBlock(output);
            if (block.text === '') {
              stream.push({ type: 'text_start', contentIndex: index, partial: output });
            }
            block.text += delta.content;
            stream.push({
              type: 'text_delta',
              contentIndex: index,
              delta: delta.content,
              partial: output,
            });
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              let existing = tc.id ? findToolCallById(output, tc.id) : undefined;
              if (!existing && tc.id) {
                existing = {
                  type: 'toolCall',
                  id: tc.id,
                  name: tc.function?.name ?? '',
                  arguments: {},
                  _partialJson: '',
                } satisfies ToolCallAccumulator;
                output.content.push(existing);
                stream.push({
                  type: 'toolcall_start',
                  contentIndex: output.content.length - 1,
                  partial: output,
                });
              }
              if (existing && tc.function?.arguments) {
                existing._partialJson += tc.function.arguments;
                try {
                  existing.arguments = JSON.parse(existing._partialJson);
                } catch {
                  /* partial JSON, keep accumulating */
                }
                stream.push({
                  type: 'toolcall_delta',
                  contentIndex: output.content.indexOf(existing),
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
            /* keep partial */
          }
          delete (tc as Partial<ToolCallAccumulator>)._partialJson;
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
