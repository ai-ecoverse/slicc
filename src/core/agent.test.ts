import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Agent } from './agent.js';
import { adaptTool } from './tool-adapter.js';
import type { AgentEvent, AgentTool, ToolDefinition, StreamFn, AssistantMessage, LlmContext, StreamOptions } from './types.js';
import { AssistantMessageEventStreamImpl } from './event-stream.js';

/**
 * Create a mock StreamFn that returns a pre-built AssistantMessage.
 * This replaces the old approach of mocking the Anthropic SDK.
 */
function createMockStreamFn(responses: AssistantMessage[]): StreamFn {
  let callIndex = 0;
  return (_context: LlmContext, _options: StreamOptions) => {
    const stream = new AssistantMessageEventStreamImpl();
    const response = responses[callIndex++] ?? responses[responses.length - 1];

    // Emit events asynchronously
    setTimeout(() => {
      stream.push({ type: 'start', partial: response });

      // Emit text deltas for text content
      for (let i = 0; i < response.content.length; i++) {
        const block = response.content[i];
        if (block.type === 'text') {
          stream.push({
            type: 'text_start',
            contentIndex: i,
            partial: response,
          });
          stream.push({
            type: 'text_delta',
            contentIndex: i,
            delta: block.text,
            partial: response,
          });
          stream.push({
            type: 'text_end',
            contentIndex: i,
            content: block.text,
            partial: response,
          });
        } else if (block.type === 'toolCall') {
          stream.push({
            type: 'toolcall_start',
            contentIndex: i,
            partial: response,
          });
          stream.push({
            type: 'toolcall_end',
            contentIndex: i,
            toolCall: block,
            partial: response,
          });
        }
      }

      const hasToolUse = response.content.some((c) => c.type === 'toolCall');
      stream.push({
        type: 'done',
        reason: hasToolUse ? 'toolUse' : 'stop',
        message: response,
      });
    }, 0);

    return stream;
  };
}

/** Helper to create a text-only AssistantMessage. */
function textResponse(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    usage: {
      input: 10, output: 5,
      cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

/** Helper to create an AssistantMessage with a tool call. */
function toolCallResponse(toolName: string, args: Record<string, any>): AssistantMessage {
  return {
    role: 'assistant',
    content: [{
      type: 'toolCall',
      id: `tool_${Date.now()}`,
      name: toolName,
      arguments: args,
    }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    usage: {
      input: 10, output: 5,
      cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: Date.now(),
  };
}

/** Helper to create an error AssistantMessage. */
function errorResponse(message: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: '' }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    usage: {
      input: 0, output: 0,
      cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    errorMessage: message,
    timestamp: Date.now(),
  };
}

/** Create a mock StreamFn that throws an error. */
function createErrorStreamFn(errorMessage: string): StreamFn {
  return () => {
    const stream = new AssistantMessageEventStreamImpl();
    setTimeout(() => {
      stream.push({
        type: 'error',
        reason: 'error',
        error: errorResponse(errorMessage),
      });
    }, 0);
    return stream;
  };
}

describe('Agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates an agent with config', () => {
    const agent = new Agent({
      config: { apiKey: 'test-key', model: 'claude-opus-4-6' },
      streamFn: createMockStreamFn([textResponse('hi')]),
    });
    expect(agent.getMessages()).toEqual([]);
    expect(agent.getSessionId()).toBeTruthy();
  });

  it('subscribes and unsubscribes from events', () => {
    const agent = new Agent({
      config: { apiKey: 'test-key' },
      streamFn: createMockStreamFn([textResponse('hi')]),
    });
    const events: string[] = [];
    const unsub = agent.on((event) => events.push(event.type));
    unsub();
    expect(events).toEqual([]);
  });

  it('resets the conversation', () => {
    const agent = new Agent({
      config: { apiKey: 'test-key' },
      streamFn: createMockStreamFn([textResponse('hi')]),
    });
    const oldId = agent.getSessionId();
    agent.reset();
    expect(agent.getMessages()).toEqual([]);
    expect(agent.getSessionId()).not.toBe(oldId);
  });

  it('sends a text-only message and gets a response', async () => {
    const agent = new Agent({
      config: { apiKey: 'test-key' },
      streamFn: createMockStreamFn([textResponse('Hello back!')]),
    });

    const response = await agent.sendMessage('Hello');

    expect(response.role).toBe('assistant');
    expect(response.content).toEqual([{ type: 'text', text: 'Hello back!' }]);

    // Messages should include user + assistant
    const msgs = agent.getMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('user');
    expect(msgs[1].role).toBe('assistant');
  });

  it('handles tool use loop', async () => {
    const echoTool: ToolDefinition = {
      name: 'echo_tool',
      description: 'Echoes input',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      async execute(input) {
        return { content: `Echoed: ${(input as any).text}` };
      },
    };

    const agent = new Agent({
      config: { apiKey: 'test-key' },
      tools: [adaptTool(echoTool)],
      streamFn: createMockStreamFn([
        toolCallResponse('echo_tool', { text: 'hi' }),
        textResponse('Done!'),
      ]),
    });

    const events: string[] = [];
    agent.on((event) => events.push(event.type));

    const response = await agent.sendMessage('Use the tool');

    // Final response should be text
    expect(response.role).toBe('assistant');
    expect(response.content).toEqual([{ type: 'text', text: 'Done!' }]);

    // Events should include tool execution events
    expect(events).toContain('tool_execution_start');
    expect(events).toContain('tool_execution_end');
    expect(events).toContain('turn_end');
  });

  it('emits message_update events during streaming', async () => {
    const agent = new Agent({
      config: { apiKey: 'test-key' },
      streamFn: createMockStreamFn([textResponse('Hello!')]),
    });

    const updateEvents: AgentEvent[] = [];
    agent.on((event) => {
      if (event.type === 'message_update') updateEvents.push(event);
    });

    await agent.sendMessage('Hi');

    // Should have received text delta updates
    expect(updateEvents.length).toBeGreaterThan(0);
    const textDeltas = updateEvents.filter(
      (e) => e.type === 'message_update' &&
        (e as any).assistantMessageEvent?.type === 'text_delta',
    );
    expect(textDeltas.length).toBeGreaterThan(0);
  });

  it('handles errors gracefully', async () => {
    const agent = new Agent({
      config: { apiKey: 'test-key' },
      streamFn: createErrorStreamFn('API error'),
    });

    const errors: AgentEvent[] = [];
    agent.on((event) => {
      if (event.type === 'agent_end') errors.push(event);
    });

    // The agent loop should handle the error and produce an error message
    const response = await agent.sendMessage('Hi');

    // The response should indicate an error
    expect((response as AssistantMessage).stopReason).toBe('error');
    expect((response as AssistantMessage).errorMessage).toBe('API error');
  });

  it('updates API key', () => {
    const agent = new Agent({
      config: { apiKey: 'old-key' },
      streamFn: createMockStreamFn([textResponse('hi')]),
    });
    agent.setApiKey('new-key');
    expect((agent as any).config.apiKey).toBe('new-key');
  });

  it('updates system prompt', () => {
    const agent = new Agent({
      config: { apiKey: 'key' },
      streamFn: createMockStreamFn([textResponse('hi')]),
    });
    agent.setSystemPrompt('Be concise');
    expect(agent.state.systemPrompt).toBe('Be concise');
  });

  it('updates model', () => {
    const agent = new Agent({
      config: { apiKey: 'key' },
      streamFn: createMockStreamFn([textResponse('hi')]),
    });
    agent.setModel('claude-opus-4-6');
    expect(agent.state.model).toBe('claude-opus-4-6');
  });
});
