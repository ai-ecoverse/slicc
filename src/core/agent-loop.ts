/**
 * Agent loop — ported from pi-mono's agent-loop.ts.
 *
 * Pure TypeScript agent loop with no Node.js dependencies.
 * Works with AgentMessage throughout, transforms to Message[]
 * only at the LLM call boundary.
 */

import { EventStream } from './event-stream.js';
import { createLogger } from './logger.js';
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  AssistantMessage,
  AssistantMessageEventStream,
  StreamFn,
  ToolResultMessage,
  LlmContext,
} from './types.js';

const log = createLogger('agent-loop');

/**
 * Start an agent loop with new prompt messages.
 */
export function agentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
): EventStream<AgentEvent, AgentMessage[]> {
  const stream = createAgentStream();

  (async () => {
    const newMessages: AgentMessage[] = [...prompts];
    const currentContext: AgentContext = {
      ...context,
      messages: [...context.messages, ...prompts],
    };

    stream.push({ type: 'agent_start' });
    stream.push({ type: 'turn_start' });
    for (const prompt of prompts) {
      stream.push({ type: 'message_start', message: prompt });
      stream.push({ type: 'message_end', message: prompt });
    }

    await runLoop(currentContext, newMessages, config, signal, stream);
  })();

  return stream;
}

/**
 * Continue an agent loop from existing context.
 */
export function agentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
): EventStream<AgentEvent, AgentMessage[]> {
  if (context.messages.length === 0) {
    throw new Error('Cannot continue: no messages in context');
  }

  if (context.messages[context.messages.length - 1].role === 'assistant') {
    throw new Error('Cannot continue from message role: assistant');
  }

  const stream = createAgentStream();

  (async () => {
    const newMessages: AgentMessage[] = [];
    const currentContext: AgentContext = { ...context };

    stream.push({ type: 'agent_start' });
    stream.push({ type: 'turn_start' });

    await runLoop(currentContext, newMessages, config, signal, stream);
  })();

  return stream;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
  return new EventStream<AgentEvent, AgentMessage[]>(
    (event: AgentEvent) => event.type === 'agent_end',
    (event: AgentEvent) => (event.type === 'agent_end' ? event.messages : []),
  );
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
  currentContext: AgentContext,
  newMessages: AgentMessage[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  stream: EventStream<AgentEvent, AgentMessage[]>,
): Promise<void> {
  let firstTurn = true;
  let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

  // Outer loop: continues when follow-up messages arrive after agent would stop
  while (true) {
    let hasMoreToolCalls = true;
    let steeringAfterTools: AgentMessage[] | null = null;

    // Inner loop: process tool calls and steering messages
    while (hasMoreToolCalls || pendingMessages.length > 0) {
      if (!firstTurn) {
        stream.push({ type: 'turn_start' });
      } else {
        firstTurn = false;
      }
      log.debug('Turn start', { messageCount: currentContext.messages.length });

      // Process pending messages
      if (pendingMessages.length > 0) {
        for (const message of pendingMessages) {
          stream.push({ type: 'message_start', message });
          stream.push({ type: 'message_end', message });
          currentContext.messages.push(message);
          newMessages.push(message);
        }
        pendingMessages = [];
      }

      // Stream assistant response
      const message = await streamAssistantResponse(currentContext, config, signal, stream);
      newMessages.push(message);

      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        stream.push({ type: 'turn_end', message, toolResults: [] });
        stream.push({ type: 'agent_end', messages: newMessages });
        stream.end(newMessages);
        return;
      }

      // Check for tool calls
      const toolCalls = message.content.filter((c) => c.type === 'toolCall');
      hasMoreToolCalls = toolCalls.length > 0;

      const toolResults: ToolResultMessage[] = [];
      if (hasMoreToolCalls) {
        const toolExecution = await executeToolCalls(
          currentContext.tools,
          message,
          signal,
          stream,
          config.getSteeringMessages,
        );
        toolResults.push(...toolExecution.toolResults);
        steeringAfterTools = toolExecution.steeringMessages ?? null;

        for (const result of toolResults) {
          currentContext.messages.push(result);
          newMessages.push(result);
        }
      }

      stream.push({ type: 'turn_end', message, toolResults });

      // Get steering messages after turn completes
      if (steeringAfterTools && steeringAfterTools.length > 0) {
        pendingMessages = steeringAfterTools;
        steeringAfterTools = null;
      } else {
        pendingMessages = (await config.getSteeringMessages?.()) || [];
      }
    }

    // Check for follow-up messages
    const followUpMessages = (await config.getFollowUpMessages?.()) || [];
    if (followUpMessages.length > 0) {
      pendingMessages = followUpMessages;
      continue;
    }

    break;
  }

  log.info('Agent loop complete', { newMessages: newMessages.length });

  stream.push({ type: 'agent_end', messages: newMessages });
  stream.end(newMessages);
}

/**
 * Stream an assistant response from the LLM.
 */
async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  stream: EventStream<AgentEvent, AgentMessage[]>,
): Promise<AssistantMessage> {
  // Apply context transform if configured
  let messages = context.messages;
  if (config.transformContext) {
    messages = await config.transformContext(messages, signal);
  }

  // Convert to LLM-compatible messages
  const llmMessages = config.convertToLlm(messages);

  // Build LLM context
  const llmContext: LlmContext = {
    systemPrompt: context.systemPrompt,
    messages: llmMessages,
    tools: context.tools,
  };

  // Resolve API key
  const resolvedApiKey =
    (config.getApiKey ? await config.getApiKey() : undefined) || config.apiKey;

  log.debug('LLM call', { messageCount: llmMessages.length, toolCount: llmContext.tools?.length ?? 0 });

  const response = config.streamFn(llmContext, {
    apiKey: resolvedApiKey,
    signal,
    model: config.model,
  });

  let partialMessage: AssistantMessage | null = null;
  let addedPartial = false;

  for await (const event of response) {
    switch (event.type) {
      case 'start':
        partialMessage = event.partial;
        context.messages.push(partialMessage);
        addedPartial = true;
        stream.push({ type: 'message_start', message: { ...partialMessage } });
        break;

      case 'text_start':
      case 'text_delta':
      case 'text_end':
      case 'thinking_start':
      case 'thinking_delta':
      case 'thinking_end':
      case 'toolcall_start':
      case 'toolcall_delta':
      case 'toolcall_end':
        if (partialMessage) {
          partialMessage = event.partial;
          context.messages[context.messages.length - 1] = partialMessage;
          stream.push({
            type: 'message_update',
            assistantMessageEvent: event,
            message: { ...partialMessage },
          });
        }
        break;

      case 'done':
      case 'error': {
        const finalMessage = await response.result();
        if (addedPartial) {
          context.messages[context.messages.length - 1] = finalMessage;
        } else {
          context.messages.push(finalMessage);
        }
        if (!addedPartial) {
          stream.push({ type: 'message_start', message: { ...finalMessage } });
        }
        stream.push({ type: 'message_end', message: finalMessage });
        return finalMessage;
      }
    }
  }

  return await response.result();
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
  tools: AgentTool[] | undefined,
  assistantMessage: AssistantMessage,
  signal: AbortSignal | undefined,
  stream: EventStream<AgentEvent, AgentMessage[]>,
  getSteeringMessages?: AgentLoopConfig['getSteeringMessages'],
): Promise<{ toolResults: ToolResultMessage[]; steeringMessages?: AgentMessage[] }> {
  const toolCalls = assistantMessage.content.filter((c) => c.type === 'toolCall');
  const results: ToolResultMessage[] = [];
  let steeringMessages: AgentMessage[] | undefined;

  for (let index = 0; index < toolCalls.length; index++) {
    const toolCall = toolCalls[index];
    if (toolCall.type !== 'toolCall') continue;

    const tool = tools?.find((t) => t.name === toolCall.name);

    log.debug('Tool call', { tool: toolCall.name, id: toolCall.id, args: toolCall.arguments });

    stream.push({
      type: 'tool_execution_start',
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });

    let result: AgentToolResult;
    let isError = false;

    try {
      if (!tool) throw new Error(`Tool ${toolCall.name} not found`);

      result = await tool.execute(toolCall.id, toolCall.arguments, signal, (partialResult) => {
        stream.push({
          type: 'tool_execution_update',
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          args: toolCall.arguments,
          partialResult,
        });
      });
    } catch (e) {
      result = {
        content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
        details: {},
      };
      isError = true;
    }

    log.debug('Tool result', { tool: toolCall.name, isError, contentLength: JSON.stringify(result.content).length });

    stream.push({
      type: 'tool_execution_end',
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result,
      isError,
    });

    const toolResultMessage: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: result.content,
      details: result.details,
      isError,
      timestamp: Date.now(),
    };

    results.push(toolResultMessage);
    stream.push({ type: 'message_start', message: toolResultMessage });
    stream.push({ type: 'message_end', message: toolResultMessage });

    // Check for steering messages
    if (getSteeringMessages) {
      const steering = await getSteeringMessages();
      if (steering.length > 0) {
        steeringMessages = steering;
        // Skip remaining tool calls
        const remainingCalls = toolCalls.slice(index + 1);
        for (const skipped of remainingCalls) {
          if (skipped.type === 'toolCall') {
            results.push(skipToolCall(skipped, stream));
          }
        }
        break;
      }
    }
  }

  return { toolResults: results, steeringMessages };
}

function skipToolCall(
  toolCall: { type: 'toolCall'; id: string; name: string; arguments: Record<string, any> },
  stream: EventStream<AgentEvent, AgentMessage[]>,
): ToolResultMessage {
  const result: AgentToolResult = {
    content: [{ type: 'text', text: 'Skipped due to queued user message.' }],
    details: {},
  };

  stream.push({
    type: 'tool_execution_start',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    args: toolCall.arguments,
  });
  stream.push({
    type: 'tool_execution_end',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    result,
    isError: true,
  });

  const toolResultMessage: ToolResultMessage = {
    role: 'toolResult',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: result.content,
    details: {},
    isError: true,
    timestamp: Date.now(),
  };

  stream.push({ type: 'message_start', message: toolResultMessage });
  stream.push({ type: 'message_end', message: toolResultMessage });

  return toolResultMessage;
}
