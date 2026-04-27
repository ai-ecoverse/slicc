import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Agent } from '@mariozechner/pi-agent-core';
import { createAssistantMessageEventStream } from '@mariozechner/pi-ai';
import { adaptTool } from '../../src/core/tool-adapter.js';
import type { AgentEvent, AgentTool, StreamFn } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, AssistantMessageEvent, Model } from '@mariozechner/pi-ai';
import type { ToolDefinition } from '../../src/core/types.js';

/** Create a dummy Model object for testing. */
function testModel(): Model<any> {
  return {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    api: 'anthropic-messages',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    contextWindow: 200000,
    maxTokens: 8192,
  };
}

/**
 * Create a mock StreamFn that returns a pre-built AssistantMessage.
 */
function createMockStreamFn(responses: AssistantMessage[]): StreamFn {
  let callIndex = 0;
  return (_model: any, _context: any, _options?: any) => {
    const stream = createAssistantMessageEventStream();
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
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
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
    content: [
      {
        type: 'toolCall',
        id: `tool_${Date.now()}`,
        name: toolName,
        arguments: args,
      },
    ],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
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
}

/** Create a mock StreamFn that returns an error. */
function createErrorStreamFn(errorMessage: string): StreamFn {
  return () => {
    const stream = createAssistantMessageEventStream();
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

describe('Agent (pi-mono)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates an agent with initial state', () => {
    const agent = new Agent({
      initialState: { model: testModel() },
      streamFn: createMockStreamFn([textResponse('hi')]),
    });
    expect(agent.state.messages).toEqual([]);
  });

  it('subscribes and unsubscribes from events', () => {
    const agent = new Agent({
      initialState: { model: testModel() },
      streamFn: createMockStreamFn([textResponse('hi')]),
    });
    const events: string[] = [];
    const unsub = agent.subscribe((event) => events.push(event.type));
    unsub();
    expect(events).toEqual([]);
  });

  it('resets the conversation', () => {
    const agent = new Agent({
      initialState: { model: testModel() },
      streamFn: createMockStreamFn([textResponse('hi')]),
    });
    agent.reset();
    expect(agent.state.messages).toEqual([]);
  });

  it('sends a text-only message and gets a response', async () => {
    const agent = new Agent({
      initialState: { model: testModel() },
      streamFn: createMockStreamFn([textResponse('Hello back!')]),
    });

    await agent.prompt('Hello');

    // Messages should include user + assistant
    const msgs = agent.state.messages;
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    expect(msgs[0].role).toBe('user');
    // Find the assistant message
    const assistantMsg = msgs.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect((assistantMsg as AssistantMessage).content).toEqual([
      { type: 'text', text: 'Hello back!' },
    ]);
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
      initialState: {
        model: testModel(),
        tools: [adaptTool(echoTool)],
      },
      streamFn: createMockStreamFn([
        toolCallResponse('echo_tool', { text: 'hi' }),
        textResponse('Done!'),
      ]),
    });

    const events: string[] = [];
    agent.subscribe((event) => events.push(event.type));

    await agent.prompt('Use the tool');

    // Events should include tool execution events
    expect(events).toContain('tool_execution_start');
    expect(events).toContain('tool_execution_end');
    expect(events).toContain('turn_end');
  });

  it('emits message_update events during streaming', async () => {
    const agent = new Agent({
      initialState: { model: testModel() },
      streamFn: createMockStreamFn([textResponse('Hello!')]),
    });

    const updateEvents: AgentEvent[] = [];
    agent.subscribe((event) => {
      if (event.type === 'message_update') updateEvents.push(event);
    });

    await agent.prompt('Hi');

    // Should have received text delta updates
    expect(updateEvents.length).toBeGreaterThan(0);
    const textDeltas = updateEvents.filter(
      (e) => e.type === 'message_update' && (e as any).assistantMessageEvent?.type === 'text_delta'
    );
    expect(textDeltas.length).toBeGreaterThan(0);
  });

  it('handles errors gracefully', async () => {
    const agent = new Agent({
      initialState: { model: testModel() },
      streamFn: createErrorStreamFn('API error'),
    });

    const endEvents: AgentEvent[] = [];
    agent.subscribe((event) => {
      if (event.type === 'agent_end') endEvents.push(event);
    });

    await agent.prompt('Hi');

    // Should have received agent_end event
    expect(endEvents.length).toBeGreaterThan(0);
  });

  it('updates system prompt', () => {
    const agent = new Agent({
      initialState: { model: testModel() },
      streamFn: createMockStreamFn([textResponse('hi')]),
    });
    agent.state.systemPrompt = 'Be concise';
    expect(agent.state.systemPrompt).toBe('Be concise');
  });

  it('updates model', () => {
    const agent = new Agent({
      initialState: { model: testModel() },
      streamFn: createMockStreamFn([textResponse('hi')]),
    });
    const newModel = { ...testModel(), id: 'claude-sonnet-4-5' };
    agent.state.model = newModel;
    expect(agent.state.model.id).toBe('claude-sonnet-4-5');
  });
});
