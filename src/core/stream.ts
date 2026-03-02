/**
 * Stream — bridges the Anthropic SDK streaming API to our EventStream.
 *
 * Wraps `@anthropic-ai/sdk` message streaming into pi-compatible
 * AssistantMessageEvent stream for consumption by the agent loop.
 */

import Anthropic from '@anthropic-ai/sdk';
import { AssistantMessageEventStreamImpl } from './event-stream.js';
import { createLogger } from './logger.js';
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  LlmContext,
  StreamFn,
  StreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
  Usage,
} from './types.js';

const log = createLogger('stream');

const DEFAULT_MODEL = 'claude-opus-4-6';
const DEFAULT_MAX_TOKENS = 8192;

/** Singleton Anthropic client (recreated when API key changes). */
let cachedClient: Anthropic | null = null;
let cachedApiKey = '';

function getClient(apiKey: string): Anthropic {
  if (cachedClient && cachedApiKey === apiKey) return cachedClient;
  cachedApiKey = apiKey;
  cachedClient = new Anthropic({
    apiKey,
    dangerouslyAllowBrowser: true,
  });
  return cachedClient;
}

/** Create an empty Usage object. */
function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Convert our Message[] to Anthropic MessageParam[]. */
function toAnthropicMessages(messages: LlmContext['messages']): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'user', content: msg.content });
      } else {
        const blocks: Anthropic.ContentBlockParam[] = msg.content.map((c) => {
          if (c.type === 'text') return { type: 'text' as const, text: c.text };
          if (c.type === 'image') {
            return {
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: c.mimeType as 'image/png',
                data: c.data,
              },
            };
          }
          return { type: 'text' as const, text: '' };
        });
        result.push({ role: 'user', content: blocks });
      }
    } else if (msg.role === 'assistant') {
      const blocks: Anthropic.ContentBlockParam[] = msg.content
        .filter((c) => c.type === 'text' || c.type === 'toolCall')
        .map((c) => {
          if (c.type === 'text') return { type: 'text' as const, text: c.text };
          if (c.type === 'toolCall') {
            return {
              type: 'tool_use' as const,
              id: c.id,
              name: c.name,
              input: c.arguments,
            };
          }
          return { type: 'text' as const, text: '' };
        });
      if (blocks.length > 0) {
        result.push({ role: 'assistant', content: blocks });
      }
    } else if (msg.role === 'toolResult') {
      // Tool results become user messages with tool_result blocks
      const lastMsg = result[result.length - 1];
      const toolResultBlock: Anthropic.ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: msg.toolCallId,
        content: msg.content.map((c) => {
          if (c.type === 'text') return { type: 'text' as const, text: c.text };
          if (c.type === 'image') {
            return {
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: c.mimeType as 'image/png',
                data: c.data,
              },
            };
          }
          return { type: 'text' as const, text: '' };
        }),
        is_error: msg.isError,
      };

      // Merge consecutive tool results into one user message
      if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
        (lastMsg.content as Anthropic.ContentBlockParam[]).push(toolResultBlock);
      } else {
        result.push({ role: 'user', content: [toolResultBlock] });
      }
    }
  }

  return result;
}

/** Convert our Tool[] to Anthropic Tool[]. */
function toAnthropicTools(tools: LlmContext['tools']): Anthropic.Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool.InputSchema,
  }));
}

/**
 * Create a StreamFn that wraps the Anthropic SDK.
 *
 * Returns a function matching the StreamFn signature that can be passed
 * to the agent loop config.
 */
export function createAnthropicStreamFn(opts: {
  maxTokens?: number;
  temperature?: number;
}): StreamFn {
  return (context: LlmContext, options: StreamOptions): AssistantMessageEventStream => {
    const stream = new AssistantMessageEventStreamImpl();

    (async () => {
      try {
        const apiKey = options.apiKey;
        if (!apiKey) {
          throw new Error('No API key provided');
        }

        const client = getClient(apiKey);
        const model = options.model || DEFAULT_MODEL;
        const messages = toAnthropicMessages(context.messages);
        const tools = toAnthropicTools(context.tools);

        log.debug('API request', { model, messageCount: messages.length, toolCount: tools?.length ?? 0, hasSystemPrompt: !!context.systemPrompt });

        const sdkStream = client.messages.stream(
          {
            model,
            max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
            system: context.systemPrompt ?? undefined,
            temperature: opts.temperature ?? 0,
            messages,
            tools: tools && tools.length > 0 ? tools : undefined,
          },
          { signal: options.signal },
        );

        // Build partial AssistantMessage as we receive events
        const contentBlocks: (TextContent | ThinkingContent | ToolCall)[] = [];
        const usage = emptyUsage();
        let currentBlockIndex = -1;
        // Track partial tool call JSON for streaming
        const partialToolJson = new Map<number, string>();

        const makePartial = (): AssistantMessage => ({
          role: 'assistant',
          content: [...contentBlocks],
          api: 'anthropic-messages',
          provider: 'anthropic',
          model,
          usage: { ...usage, cost: { ...usage.cost } },
          stopReason: 'stop',
          timestamp: Date.now(),
        });

        // Process raw SSE events via streamEvent for correct ordering.
        // The high-level callbacks (on('contentBlock'), on('text')) fire in
        // wrong order: 'contentBlock' fires on content_block_stop (after
        // the block finishes) while 'text' fires during content_block_delta
        // (before contentBlock). Using streamEvent gives us events in the
        // correct SSE order.
        let startEmitted = false;

        sdkStream.on('streamEvent', (event: { type: string; [key: string]: any }) => {
          // Emit 'start' on the very first event
          if (!startEmitted) {
            startEmitted = true;
            stream.push({ type: 'start', partial: makePartial() });
          }

          switch (event.type) {
            case 'content_block_start': {
              currentBlockIndex++;
              const block = event.content_block as { type: string; id?: string; name?: string };
              log.debug('Content block', { type: block.type, index: currentBlockIndex });
              if (block.type === 'text') {
                contentBlocks.push({ type: 'text', text: '' });
                stream.push({
                  type: 'text_start',
                  contentIndex: currentBlockIndex,
                  partial: makePartial(),
                });
              } else if (block.type === 'tool_use') {
                contentBlocks.push({
                  type: 'toolCall',
                  id: (block as any).id ?? '',
                  name: (block as any).name ?? '',
                  arguments: {},
                });
                partialToolJson.set(currentBlockIndex, '');
                stream.push({
                  type: 'toolcall_start',
                  contentIndex: currentBlockIndex,
                  partial: makePartial(),
                });
              } else if (block.type === 'thinking') {
                contentBlocks.push({ type: 'thinking', thinking: '' });
                stream.push({
                  type: 'thinking_start',
                  contentIndex: currentBlockIndex,
                  partial: makePartial(),
                });
              }
              break;
            }

            case 'content_block_delta': {
              const delta = event.delta as { type: string; text?: string; partial_json?: string; thinking?: string };
              if (delta.type === 'text_delta' && delta.text !== undefined) {
                const idx = contentBlocks.findLastIndex((b: any) => b.type === 'text');
                if (idx >= 0) {
                  (contentBlocks[idx] as any).text += delta.text;
                  stream.push({
                    type: 'text_delta',
                    contentIndex: idx,
                    delta: delta.text,
                    partial: makePartial(),
                  });
                }
              } else if (delta.type === 'input_json_delta' && delta.partial_json !== undefined) {
                const idx = contentBlocks.findLastIndex((b: any) => b.type === 'toolCall');
                if (idx >= 0) {
                  const existing = partialToolJson.get(idx) ?? '';
                  partialToolJson.set(idx, existing + delta.partial_json);
                  stream.push({
                    type: 'toolcall_delta',
                    contentIndex: idx,
                    delta: delta.partial_json,
                    partial: makePartial(),
                  });
                }
              } else if (delta.type === 'thinking_delta' && delta.thinking !== undefined) {
                const idx = contentBlocks.findLastIndex((b: any) => b.type === 'thinking');
                if (idx >= 0) {
                  (contentBlocks[idx] as any).thinking += delta.thinking;
                  stream.push({
                    type: 'thinking_delta',
                    contentIndex: idx,
                    delta: delta.thinking,
                    partial: makePartial(),
                  });
                }
              }
              break;
            }

            // content_block_stop, message_start, message_stop, message_delta
            // are handled by finalMessage() below — no action needed here
          }
        });

        // Wait for final message
        const finalMessage = await sdkStream.finalMessage();
        if (!startEmitted) {
          startEmitted = true;
          stream.push({ type: 'start', partial: makePartial() });
        }

        // Build the final AssistantMessage
        const finalContent: (TextContent | ThinkingContent | ToolCall)[] = [];
        for (const block of finalMessage.content) {
          if (block.type === 'text') {
            finalContent.push({ type: 'text', text: block.text });
          } else if (block.type === 'tool_use') {
            finalContent.push({
              type: 'toolCall',
              id: block.id,
              name: block.name,
              arguments: block.input as Record<string, any>,
            });
          } else if (block.type === 'thinking') {
            finalContent.push({ type: 'thinking', thinking: block.thinking });
          }
        }

        const finalUsage: Usage = {
          input: finalMessage.usage?.input_tokens ?? 0,
          output: finalMessage.usage?.output_tokens ?? 0,
          cacheRead: (finalMessage.usage as any)?.cache_read_input_tokens ?? 0,
          cacheWrite: (finalMessage.usage as any)?.cache_creation_input_tokens ?? 0,
          totalTokens: (finalMessage.usage?.input_tokens ?? 0) + (finalMessage.usage?.output_tokens ?? 0),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };

        const hasToolUse = finalContent.some((c) => c.type === 'toolCall');
        const stopReason: 'stop' | 'length' | 'toolUse' =
          finalMessage.stop_reason === 'tool_use' || hasToolUse
            ? 'toolUse'
            : finalMessage.stop_reason === 'max_tokens'
              ? 'length'
              : 'stop';

        const result: AssistantMessage = {
          role: 'assistant',
          content: finalContent,
          api: 'anthropic-messages',
          provider: 'anthropic',
          model,
          usage: finalUsage,
          stopReason,
          timestamp: Date.now(),
        };

        // Emit end events for any remaining content blocks
        for (let i = 0; i < finalContent.length; i++) {
          const block = finalContent[i];
          if (block.type === 'text') {
            stream.push({
              type: 'text_end',
              contentIndex: i,
              content: block.text,
              partial: result,
            });
          } else if (block.type === 'toolCall') {
            stream.push({
              type: 'toolcall_end',
              contentIndex: i,
              toolCall: block,
              partial: result,
            });
          } else if (block.type === 'thinking') {
            stream.push({
              type: 'thinking_end',
              contentIndex: i,
              content: block.thinking,
              partial: result,
            });
          }
        }

        log.info('API response', { model, stopReason, usage: { input: finalUsage.input, output: finalUsage.output, cacheRead: finalUsage.cacheRead }, contentBlocks: finalContent.length });

        stream.push({ type: 'done', reason: stopReason, message: result });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const isAborted = errorMessage.includes('aborted') ||
          (err instanceof DOMException && err.name === 'AbortError');

        log.error('API error', { error: errorMessage, isAborted });

        const errorResult: AssistantMessage = {
          role: 'assistant',
          content: [{ type: 'text', text: '' }],
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: options.model || DEFAULT_MODEL,
          usage: emptyUsage(),
          stopReason: isAborted ? 'aborted' : 'error',
          errorMessage,
          timestamp: Date.now(),
        };

        stream.push({
          type: 'error',
          reason: isAborted ? 'aborted' : 'error',
          error: errorResult,
        });
      }
    })();

    return stream;
  };
}
