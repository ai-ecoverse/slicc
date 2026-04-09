/**
 * Bedrock CAMP provider — config + stream function registration.
 *
 * Uses the Converse API with Bearer token auth instead of SigV4.
 * Routes through /api/fetch-proxy in CLI mode, direct fetch in extension mode.
 * Registers as api: "bedrock-camp-converse" via pi-ai's registerApiProvider().
 */

import type { ProviderConfig } from '../types.js';
import {
  registerApiProvider,
  calculateCost,
  createAssistantMessageEventStream,
} from '@mariozechner/pi-ai';
import type { AssistantMessageEventStream } from '@mariozechner/pi-ai';
import { transformMessages } from '@mariozechner/pi-ai/dist/providers/transform-messages.js';
import {
  buildBaseOptions,
  adjustMaxTokensForThinking,
  clampReasoning,
} from '@mariozechner/pi-ai/dist/providers/simple-options.js';
import type {
  Api,
  Model,
  Context,
  StreamOptions,
  SimpleStreamOptions,
  AssistantMessage,
  ThinkingLevel,
  ThinkingBudgets,
} from '@mariozechner/pi-ai';

export const config: ProviderConfig = {
  id: 'bedrock-camp',
  name: 'AWS Bedrock (CAMP)',
  description: 'Claude on AWS Bedrock via CAMP Bearer token',
  requiresApiKey: true,
  apiKeyPlaceholder: 'ABSK...',
  apiKeyEnvVar: 'BEDROCK_CAMP_API_KEY',
  requiresBaseUrl: true,
  baseUrlPlaceholder: 'https://bedrock-runtime.us-west-2.amazonaws.com',
  baseUrlDescription: 'Bedrock runtime endpoint from CAMP portal',
  requiresModelSelection: true,
  defaultModelId: 'claude-sonnet-4-6',
};

// Extension detection
const isExtension = typeof chrome !== 'undefined' && !!(chrome as any)?.runtime?.id;

interface BedrockCampOptions extends StreamOptions {
  toolChoice?: 'auto' | 'any' | 'none' | { type: 'tool'; name: string };
  reasoning?: ThinkingLevel;
  thinkingBudgets?: ThinkingBudgets;
}

// ── Message conversion ──────────────────────────────────────────────

function normalizeToolCallId(id: string): string {
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  return sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
}

function sanitize(text: string | undefined | null): string {
  if (!text) return '';
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '\uFFFD'
  );
}

function convertMessages(context: Context, model: Model<Api>): any[] {
  const result: any[] = [];
  const transformed = transformMessages(context.messages, model, normalizeToolCallId);

  for (let i = 0; i < transformed.length; i++) {
    const m = transformed[i];
    switch (m.role) {
      case 'user':
        result.push({
          role: 'user',
          content:
            typeof m.content === 'string'
              ? [{ text: sanitize(m.content) }]
              : m.content.map((c: any) => {
                  if (c.type === 'text') return { text: sanitize(c.text) };
                  if (c.type === 'image')
                    return {
                      image: { source: { bytes: c.data }, format: mimeToFormat(c.mimeType) },
                    };
                  throw new Error(`Unknown user content type: ${c.type}`);
                }),
        });
        break;

      case 'assistant': {
        if (m.content.length === 0) continue;
        const blocks: any[] = [];
        for (const c of m.content) {
          switch (c.type) {
            case 'text':
              if (c.text.trim().length === 0) continue;
              blocks.push({ text: sanitize(c.text) });
              break;
            case 'toolCall':
              blocks.push({ toolUse: { toolUseId: c.id, name: c.name, input: c.arguments } });
              break;
            case 'thinking':
              if (c.thinking.trim().length === 0) continue;
              if (supportsThinkingSignature(model)) {
                blocks.push({
                  reasoningContent: {
                    reasoningText: { text: sanitize(c.thinking), signature: c.thinkingSignature },
                  },
                });
              } else {
                blocks.push({
                  reasoningContent: { reasoningText: { text: sanitize(c.thinking) } },
                });
              }
              break;
          }
        }
        if (blocks.length === 0) continue;
        result.push({ role: 'assistant', content: blocks });
        break;
      }

      case 'toolResult': {
        const toolResults: any[] = [];
        toolResults.push({
          toolResult: {
            toolUseId: m.toolCallId,
            content: m.content.map((c: any) =>
              c.type === 'image'
                ? { image: { source: { bytes: c.data }, format: mimeToFormat(c.mimeType) } }
                : { text: sanitize(c.text ?? c.json ?? JSON.stringify(c)) }
            ),
            status: m.isError ? 'error' : 'success',
          },
        });
        let j = i + 1;
        while (j < transformed.length && transformed[j].role === 'toolResult') {
          const next = transformed[j] as any;
          toolResults.push({
            toolResult: {
              toolUseId: next.toolCallId,
              content: next.content.map((c: any) =>
                c.type === 'image'
                  ? { image: { source: { bytes: c.data }, format: mimeToFormat(c.mimeType) } }
                  : { text: sanitize(c.text ?? c.json ?? JSON.stringify(c)) }
              ),
              status: next.isError ? 'error' : 'success',
            },
          });
          j++;
        }
        i = j - 1;
        result.push({ role: 'user', content: toolResults });
        break;
      }
    }
  }
  // Add cache point to the last user message for supported Claude models
  if (supportsPromptCaching(model) && result.length > 0) {
    const lastMessage = result[result.length - 1];
    if (lastMessage.role === 'user' && Array.isArray(lastMessage.content)) {
      lastMessage.content.push({ cachePoint: { type: 'default' } });
    }
  }

  return result;
}

function mimeToFormat(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpeg';
    case 'image/png':
      return 'png';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    default:
      return 'png';
  }
}

function supportsThinkingSignature(model: Model<Api>): boolean {
  const id = model.id.toLowerCase();
  return id.includes('anthropic.claude') || id.includes('anthropic/claude');
}

function supportsAdaptiveThinking(modelId: string): boolean {
  return (
    modelId.includes('opus-4-6') ||
    modelId.includes('opus-4.6') ||
    modelId.includes('sonnet-4-6') ||
    modelId.includes('sonnet-4.6')
  );
}

// ── Tool config ─────────────────────────────────────────────────────

function convertToolConfig(
  tools: Context['tools'],
  toolChoice?: BedrockCampOptions['toolChoice']
): any | undefined {
  if (!tools?.length || toolChoice === 'none') return undefined;
  const bedrockTools = tools.map((t) => ({
    toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.parameters } },
  }));
  let choice: any;
  switch (toolChoice) {
    case 'auto':
      choice = { auto: {} };
      break;
    case 'any':
      choice = { any: {} };
      break;
    default:
      if (toolChoice && typeof toolChoice === 'object' && toolChoice.type === 'tool') {
        choice = { tool: { name: toolChoice.name } };
      }
  }
  return { tools: bedrockTools, toolChoice: choice };
}

// ── Thinking / reasoning fields ─────────────────────────────────────

function mapThinkingLevelToEffort(level: ThinkingLevel | undefined, modelId: string): string {
  switch (level) {
    case 'minimal':
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
      return modelId.includes('opus-4-6') || modelId.includes('opus-4.6') ? 'max' : 'high';
    default:
      return 'high';
  }
}

function buildAdditionalModelRequestFields(
  model: Model<Api>,
  options: BedrockCampOptions
): any | undefined {
  if (!options.reasoning || !model.reasoning) return undefined;
  if (model.id.includes('anthropic.claude') || model.id.includes('anthropic/claude')) {
    const result: any = supportsAdaptiveThinking(model.id)
      ? {
          thinking: { type: 'adaptive' },
          output_config: { effort: mapThinkingLevelToEffort(options.reasoning, model.id) },
        }
      : (() => {
          const defaults: Record<string, number> = {
            minimal: 1024,
            low: 2048,
            medium: 8192,
            high: 16384,
            xhigh: 16384,
          };
          const level = options.reasoning === 'xhigh' ? 'high' : options.reasoning!;
          const budget =
            options.thinkingBudgets?.[level as keyof ThinkingBudgets] ??
            defaults[options.reasoning!];
          return { thinking: { type: 'enabled', budget_tokens: budget } };
        })();
    return result;
  }
  return undefined;
}

// ── Prompt caching ─────────────────────────────────────────────────

/**
 * Check if the model supports prompt caching.
 * Matches pi-ai's built-in Bedrock provider logic.
 */
function supportsPromptCaching(model: Model<Api>): boolean {
  const id = model.id.toLowerCase();
  if (!id.includes('claude')) {
    return false;
  }
  // Claude 4.x models (opus-4, sonnet-4, haiku-4)
  if (id.includes('-4-') || id.includes('-4.')) return true;
  // Claude 3.7 Sonnet
  if (id.includes('claude-3-7-sonnet')) return true;
  // Claude 3.5 Haiku
  if (id.includes('claude-3-5-haiku')) return true;
  return false;
}

// ── System prompt ───────────────────────────────────────────────────

function buildSystemPrompt(systemPrompt: string | undefined, model: Model<Api>): any[] | undefined {
  if (!systemPrompt) return undefined;
  const blocks: any[] = [{ text: sanitize(systemPrompt) }];
  if (supportsPromptCaching(model)) {
    blocks.push({ cachePoint: { type: 'default' } });
  }
  return blocks;
}

// ── Stop reason mapping ─────────────────────────────────────────────

function mapStopReason(reason: string): 'stop' | 'length' | 'toolUse' | 'error' {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'tool_use':
      return 'toolUse';
    default:
      return 'error';
  }
}

// ── Response parsing (non-streaming /converse) ──────────────────────

function parseConverseResponse(
  body: any,
  model: Model<Api>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream
): void {
  stream.push({ type: 'start', partial: output });

  const message = body.output?.message;
  if (message?.content) {
    for (let i = 0; i < message.content.length; i++) {
      const block = message.content[i];
      if (block.text !== undefined) {
        const textBlock = { type: 'text' as const, text: block.text };
        output.content.push(textBlock);
        const idx = output.content.length - 1;
        stream.push({ type: 'text_start', contentIndex: idx, partial: output });
        stream.push({ type: 'text_delta', contentIndex: idx, delta: block.text, partial: output });
        stream.push({ type: 'text_end', contentIndex: idx, content: block.text, partial: output });
      } else if (block.toolUse) {
        const toolBlock = {
          type: 'toolCall' as const,
          id: block.toolUse.toolUseId || '',
          name: block.toolUse.name || '',
          arguments: block.toolUse.input || {},
        };
        output.content.push(toolBlock);
        const idx = output.content.length - 1;
        stream.push({ type: 'toolcall_start', contentIndex: idx, partial: output });
        stream.push({
          type: 'toolcall_end',
          contentIndex: idx,
          toolCall: toolBlock,
          partial: output,
        });
      } else if (block.reasoningContent?.reasoningText) {
        const thinkingBlock = {
          type: 'thinking' as const,
          thinking: block.reasoningContent.reasoningText.text || '',
          thinkingSignature: block.reasoningContent.reasoningText.signature || '',
        };
        output.content.push(thinkingBlock);
        const idx = output.content.length - 1;
        stream.push({ type: 'thinking_start', contentIndex: idx, partial: output });
        stream.push({
          type: 'thinking_delta',
          contentIndex: idx,
          delta: thinkingBlock.thinking,
          partial: output,
        });
        stream.push({
          type: 'thinking_end',
          contentIndex: idx,
          content: thinkingBlock.thinking,
          partial: output,
        });
      }
    }
  }

  // Usage
  if (body.usage) {
    output.usage.input = body.usage.inputTokens || 0;
    output.usage.output = body.usage.outputTokens || 0;
    output.usage.cacheRead = body.usage.cacheReadInputTokens || 0;
    output.usage.cacheWrite = body.usage.cacheWriteInputTokens || 0;
    output.usage.totalTokens = body.usage.totalTokens || output.usage.input + output.usage.output;
    calculateCost(model, output.usage);
  }

  // Stop reason
  output.stopReason = mapStopReason(body.stopReason || 'end_turn');
}

// ── Stream function ─────────────────────────────────────────────────

export const streamBedrockCamp = (
  model: Model<Api>,
  context: Context,
  options: BedrockCampOptions = {}
): AssistantMessageEventStream => {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: 'bedrock-camp-converse' as Api,
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
      stopReason: 'stop',
      timestamp: Date.now(),
    };

    try {
      const apiKey = options.apiKey;
      if (!apiKey) throw new Error('API key is required for Bedrock CAMP');

      const baseUrl = model.baseUrl;
      if (!baseUrl) throw new Error('Base URL is required for Bedrock CAMP');

      // Build request body (Converse API format)
      const body: any = {
        modelId: model.id,
        messages: convertMessages(context, model),
        system: buildSystemPrompt(context.systemPrompt, model),
        inferenceConfig: {
          maxTokens: options.maxTokens,
          temperature: options.temperature,
        },
        toolConfig: convertToolConfig(context.tools, options.toolChoice),
        additionalModelRequestFields: buildAdditionalModelRequestFields(model, options),
      };

      // Remove undefined fields
      if (!body.system) delete body.system;
      if (!body.toolConfig) delete body.toolConfig;
      if (!body.additionalModelRequestFields) delete body.additionalModelRequestFields;

      options?.onPayload?.(body, model);

      // Build URL: POST {baseUrl}/model/{modelId}/converse
      const targetUrl = `${baseUrl.replace(/\/$/, '')}/model/${encodeURIComponent(model.id)}/converse`;

      // Route through CORS proxy in CLI mode, direct in extension mode
      const fetchUrl = isExtension ? targetUrl : '/api/fetch-proxy';
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      };
      if (!isExtension) {
        headers['X-Target-URL'] = targetUrl;
      }

      const response = await fetch(fetchUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Bedrock CAMP API error (${response.status}): ${errorText}`);
      }

      const responseBody = await response.json();
      parseConverseResponse(responseBody, model, output, stream);

      if (output.stopReason === 'error' || output.stopReason === 'aborted') {
        throw new Error('An unknown error occurred');
      }
      stream.push({ type: 'done', reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      for (const block of output.content) {
        delete (block as any).index;
        delete (block as any).partialJson;
      }
      output.stopReason = options.signal?.aborted ? 'aborted' : 'error';
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({ type: 'error', reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
};

// ── Simple stream wrapper ───────────────────────────────────────────

export const streamSimpleBedrockCamp = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions
): AssistantMessageEventStream => {
  const base = buildBaseOptions(model, options, undefined);
  if (!options?.reasoning) {
    return streamBedrockCamp(model, context, { ...base, reasoning: undefined });
  }
  if (model.id.includes('anthropic.claude') || model.id.includes('anthropic/claude')) {
    if (supportsAdaptiveThinking(model.id)) {
      return streamBedrockCamp(model, context, {
        ...base,
        reasoning: options.reasoning,
        thinkingBudgets: options.thinkingBudgets,
      });
    }
    const adjusted = adjustMaxTokensForThinking(
      base.maxTokens || 0,
      model.maxTokens,
      options.reasoning,
      options.thinkingBudgets
    );
    return streamBedrockCamp(model, context, {
      ...base,
      maxTokens: adjusted.maxTokens,
      reasoning: options.reasoning,
      thinkingBudgets: {
        ...(options.thinkingBudgets || {}),
        [clampReasoning(options.reasoning)!]: adjusted.budgetTokens,
      },
    });
  }
  return streamBedrockCamp(model, context, {
    ...base,
    reasoning: options.reasoning,
    thinkingBudgets: options.thinkingBudgets,
  });
};

// ── Registration ────────────────────────────────────────────────────

export function register(): void {
  registerApiProvider({
    api: 'bedrock-camp-converse' as Api,
    stream: streamBedrockCamp,
    streamSimple: streamSimpleBedrockCamp,
  });
}
