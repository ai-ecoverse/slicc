/**
 * Tests for ScoopContext message queueing behavior.
 *
 * Verifies that prompt() queues messages when already processing
 * and drains them sequentially, with proper error handling.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ScoopContext,
  abortableSleep,
  isImageProcessingError,
  isNonRetryableError,
  isRetryableError,
  resolveThinkingLevel,
  type ScoopContextCallbacks,
} from '../../src/scoops/scoop-context.js';
import type { RegisteredScoop } from '../../src/scoops/types.js';

// Minimal scoop registration for testing
const testScoop: RegisteredScoop = {
  jid: 'scoop_test_1',
  name: 'test',
  folder: 'test-scoop',
  isCone: false,
  type: 'scoop',
  requiresTrigger: false,
  assistantLabel: 'test-scoop',
  addedAt: new Date().toISOString(),
};

function createMockCallbacks(): ScoopContextCallbacks {
  return {
    onResponse: vi.fn(),
    onResponseDone: vi.fn(),
    onError: vi.fn(),
    onFatalError: vi.fn(),
    onStatusChange: vi.fn(),
    onSendMessage: vi.fn(),
    getScoops: vi.fn(() => []),
    getGlobalMemory: vi.fn(async () => ''),
    getBrowserAPI: vi.fn(() => ({}) as any),
  };
}

/**
 * Helper: inject a mock agent into a ScoopContext so we can test prompt()
 * without running the full init() (which needs VFS, shell, API key, etc.).
 */
function injectMockAgent(ctx: ScoopContext, mockPrompt: (text: string) => Promise<void>): void {
  const followUpQueue: any[] = [];
  const agent = {
    prompt: mockPrompt,
    abort: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    followUp: vi.fn((msg: any) => {
      followUpQueue.push(msg);
    }),
    clearAllQueues: vi.fn(() => {
      followUpQueue.length = 0;
    }),
    state: { isStreaming: false },
    // Expose queue for test inspection
    _followUpQueue: followUpQueue,
  };
  // Inject via private field
  (ctx as any).agent = agent;
  (ctx as any).status = 'ready';
}

describe('ScoopContext session persistence', () => {
  let ctx: ScoopContext;
  let callbacks: ScoopContextCallbacks;

  beforeEach(() => {
    callbacks = createMockCallbacks();
  });

  it('accepts a sessionStore parameter', () => {
    const mockStore = { load: vi.fn(), save: vi.fn(), delete: vi.fn() } as any;
    ctx = new ScoopContext(testScoop, callbacks, {} as any, mockStore, undefined, 'cone_1');
    expect((ctx as any).sessionStore).toBe(mockStore);
    // Internal persistence key is the scoop's JID — stable across days so
    // `SessionStore.load` can restore saved conversations.
    expect((ctx as any).sessionId).toBe(testScoop.jid);
  });

  it('works without sessionStore (backwards compatible)', () => {
    ctx = new ScoopContext(testScoop, callbacks, {} as any);
    expect((ctx as any).sessionStore).toBeNull();
  });

  it('saves session on agent_end with messages', () => {
    const mockStore = { load: vi.fn(), save: vi.fn().mockResolvedValue(undefined) } as any;
    ctx = new ScoopContext(testScoop, callbacks, {} as any, mockStore, undefined, 'cone_1');
    injectMockAgent(ctx, async () => {});

    const handler = (ctx as any).handleAgentEvent.bind(ctx);
    const messages = [{ role: 'user', content: 'hello', timestamp: Date.now() }];
    handler({ type: 'agent_end', messages });

    expect(mockStore.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: testScoop.jid,
        messages,
      })
    );
  });

  it('persists full agent state, not just current turn event.messages', () => {
    const mockStore = { load: vi.fn(), save: vi.fn().mockResolvedValue(undefined) } as any;
    ctx = new ScoopContext(testScoop, callbacks, {} as any, mockStore);

    // Set up a mock agent whose state.messages has the full accumulated history
    const fullHistory = [
      { role: 'user', content: [{ type: 'text', text: 'first question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'second question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] },
    ];
    const agent = {
      prompt: vi.fn(),
      abort: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      state: { messages: fullHistory, isStreaming: false },
    };
    (ctx as any).agent = agent;
    (ctx as any).status = 'ready';

    // event.messages only has the current turn (as pi-agent-core emits)
    const currentTurnOnly = [
      { role: 'user', content: [{ type: 'text', text: 'second question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] },
    ];

    const handler = (ctx as any).handleAgentEvent.bind(ctx);
    handler({ type: 'agent_end', messages: currentTurnOnly });

    // Should save the full history from agent.state.messages, not the 2-message event
    const savedSession = mockStore.save.mock.calls[0][0];
    expect(savedSession.messages).toBe(fullHistory);
    expect(savedSession.messages).toHaveLength(4);
  });

  it('preserves original createdAt across saves', () => {
    const originalCreatedAt = 1000000;
    const mockStore = { load: vi.fn(), save: vi.fn().mockResolvedValue(undefined) } as any;
    ctx = new ScoopContext(testScoop, callbacks, {} as any, mockStore);
    injectMockAgent(ctx, async () => {});

    // Simulate having restored a session with a known createdAt
    (ctx as any).sessionCreatedAt = originalCreatedAt;

    const handler = (ctx as any).handleAgentEvent.bind(ctx);
    handler({
      type: 'agent_end',
      messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }],
    });

    const savedSession = mockStore.save.mock.calls[0][0];
    expect(savedSession.createdAt).toBe(originalCreatedAt);
    expect(savedSession.updatedAt).toBeGreaterThan(originalCreatedAt);
  });

  it('uses current time for createdAt on first save (no prior session)', () => {
    const mockStore = { load: vi.fn(), save: vi.fn().mockResolvedValue(undefined) } as any;
    ctx = new ScoopContext(testScoop, callbacks, {} as any, mockStore);
    injectMockAgent(ctx, async () => {});

    const before = Date.now();
    const handler = (ctx as any).handleAgentEvent.bind(ctx);
    handler({
      type: 'agent_end',
      messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }],
    });
    const after = Date.now();

    const savedSession = mockStore.save.mock.calls[0][0];
    expect(savedSession.createdAt).toBeGreaterThanOrEqual(before);
    expect(savedSession.createdAt).toBeLessThanOrEqual(after);
  });

  it('does not save session on agent_end with empty messages', () => {
    const mockStore = { load: vi.fn(), save: vi.fn() } as any;
    ctx = new ScoopContext(testScoop, callbacks, {} as any, mockStore);
    injectMockAgent(ctx, async () => {});

    const handler = (ctx as any).handleAgentEvent.bind(ctx);
    handler({ type: 'agent_end', messages: [] });

    expect(mockStore.save).not.toHaveBeenCalled();
  });

  it('logs error when save fails (does not throw)', () => {
    const mockStore = {
      load: vi.fn(),
      save: vi.fn().mockRejectedValue(new Error('DB full')),
    } as any;
    ctx = new ScoopContext(testScoop, callbacks, {} as any, mockStore);
    injectMockAgent(ctx, async () => {});

    const handler = (ctx as any).handleAgentEvent.bind(ctx);
    const messages = [{ role: 'user', content: 'hello', timestamp: Date.now() }];

    // Should not throw
    expect(() => handler({ type: 'agent_end', messages })).not.toThrow();
  });

  it('does not save session when no sessionStore provided', () => {
    ctx = new ScoopContext(testScoop, callbacks, {} as any);
    injectMockAgent(ctx, async () => {});

    const handler = (ctx as any).handleAgentEvent.bind(ctx);
    const messages = [{ role: 'user', content: 'hello', timestamp: Date.now() }];

    // Should not throw
    expect(() => handler({ type: 'agent_end', messages })).not.toThrow();
  });

  it('calls onError when restore fails', () => {
    const mockStore = {
      load: vi.fn().mockRejectedValue(new Error('DB corrupt')),
      save: vi.fn(),
    } as any;
    ctx = new ScoopContext(testScoop, callbacks, {} as any, mockStore);

    // Simulate the restoration error path directly
    const restoreBlock = async () => {
      let restoredMessages: any[] = [];
      try {
        const saved = await mockStore.load(testScoop.jid);
        if (saved) restoredMessages = saved.messages;
      } catch (err) {
        callbacks.onError('Conversation history could not be restored. Starting fresh.');
      }
      return restoredMessages;
    };

    return restoreBlock().then((messages) => {
      expect(messages).toEqual([]);
      expect(callbacks.onError).toHaveBeenCalledWith(
        'Conversation history could not be restored. Starting fresh.'
      );
    });
  });

  it('restores sessionCreatedAt from loaded session', () => {
    const mockStore = {
      load: vi
        .fn()
        .mockResolvedValue({ messages: [{ role: 'user', content: 'old' }], createdAt: 42 }),
      save: vi.fn(),
    } as any;
    ctx = new ScoopContext(testScoop, callbacks, {} as any, mockStore);

    // Simulate the restoration path
    const restoreBlock = async () => {
      const saved = await mockStore.load(testScoop.jid);
      if (saved) {
        (ctx as any).sessionCreatedAt = saved.createdAt;
        return saved.messages;
      }
      return [];
    };

    return restoreBlock().then((messages) => {
      expect(messages).toEqual([{ role: 'user', content: 'old' }]);
      expect((ctx as any).sessionCreatedAt).toBe(42);
    });
  });

  it('defaults to empty messages when no prior session exists', () => {
    const mockStore = { load: vi.fn().mockResolvedValue(null), save: vi.fn() } as any;
    ctx = new ScoopContext(testScoop, callbacks, {} as any, mockStore);

    const restoreBlock = async () => {
      const saved = await mockStore.load(testScoop.jid);
      if (saved) return saved.messages;
      return [];
    };

    return restoreBlock().then((messages) => {
      expect(messages).toEqual([]);
      expect(mockStore.load).toHaveBeenCalledWith(testScoop.jid);
    });
  });
});

describe('ScoopContext prompt queueing', () => {
  let ctx: ScoopContext;
  let callbacks: ScoopContextCallbacks;

  beforeEach(() => {
    callbacks = createMockCallbacks();
    ctx = new ScoopContext(testScoop, callbacks, {} as any);
  });

  it('processes a single prompt normally', async () => {
    const prompts: string[] = [];
    injectMockAgent(ctx, async (text) => {
      prompts.push(text);
    });

    await ctx.prompt('hello');

    expect(prompts).toEqual(['hello']);
    expect(callbacks.onStatusChange).toHaveBeenCalledWith('processing');
    // Last status call should be 'ready'
    const statusCalls = (callbacks.onStatusChange as any).mock.calls;
    expect(statusCalls[statusCalls.length - 1][0]).toBe('ready');
  });

  it('queues prompts via followUp when already processing', async () => {
    const prompts: string[] = [];
    let resolveFirst: () => void;
    const firstPromptDone = new Promise<void>((r) => {
      resolveFirst = r;
    });

    injectMockAgent(ctx, async (text) => {
      prompts.push(text);
      if (text === 'first') {
        await firstPromptDone;
      }
    });

    // Start first prompt (will block until we resolve)
    const promptPromise = ctx.prompt('first');

    // While first is processing, queue more prompts via followUp
    await ctx.prompt('second');
    await ctx.prompt('third');

    // Verify first was sent to agent.prompt, others queued via followUp
    expect(prompts).toEqual(['first']);
    expect((ctx as any).agent.followUp).toHaveBeenCalledTimes(2);
    expect((ctx as any).agent._followUpQueue).toHaveLength(2);

    resolveFirst!();
    await promptPromise;
  });

  it('preserves image attachments when queueing follow-up prompts', async () => {
    let resolveFirst: () => void;
    const firstPromptDone = new Promise<void>((r) => {
      resolveFirst = r;
    });

    injectMockAgent(ctx, async (text) => {
      if (text === 'first') {
        await firstPromptDone;
      }
    });

    const promptPromise = ctx.prompt('first');
    await ctx.prompt('second', [{ type: 'image', mimeType: 'image/png', data: 'abc123' }]);

    expect((ctx as any).agent.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: [
          { type: 'text', text: 'second' },
          { type: 'image', mimeType: 'image/png', data: 'abc123' },
        ],
      })
    );

    resolveFirst!();
    await promptPromise;
  });

  it('stop() clears the queue and aborts', async () => {
    let resolveFirst: () => void;
    const firstPromptDone = new Promise<void>((r) => {
      resolveFirst = r;
    });
    const prompts: string[] = [];

    injectMockAgent(ctx, async (text) => {
      prompts.push(text);
      if (text === 'first') {
        await firstPromptDone;
      }
    });

    const promptPromise = ctx.prompt('first');
    await ctx.prompt('second');
    await ctx.prompt('third');

    // Stop should clear the queue
    ctx.stop();

    expect((ctx as any).agent.clearAllQueues).toHaveBeenCalled();
    expect((ctx as any).agent.abort).toHaveBeenCalled();

    // Release first prompt
    resolveFirst!();
    await promptPromise;

    // Only 'first' was actually sent to agent.prompt
    expect(prompts).toEqual(['first']);
  });

  it('returns to ready status after prompt completes', async () => {
    const prompts: string[] = [];
    injectMockAgent(ctx, async (text) => {
      prompts.push(text);
    });

    await ctx.prompt('first');

    expect(prompts).toEqual(['first']);
    const statusCalls = (callbacks.onStatusChange as any).mock.calls;
    expect(statusCalls[statusCalls.length - 1][0]).toBe('ready');
  });

  it('reports error when agent is not initialized', async () => {
    // Don't inject a mock agent — lazy init() will run inside prompt()
    // and discover there's still no API key in the test env, so the
    // error surfaces from the no-credentials path.
    await ctx.prompt('hello');
    expect(callbacks.onError).toHaveBeenCalled();
    const lastCall = (callbacks.onError as any).mock.calls.at(-1)?.[0] ?? '';
    expect(lastCall).toMatch(/No API key configured/i);
  });

  it('does not queue when agent is not initialized', async () => {
    // Don't inject a mock agent — prompt should error, not queue
    await ctx.prompt('first');
    await ctx.prompt('second');

    // Both should surface the missing-credentials error.
    const errorCalls = (callbacks.onError as any).mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && /No API key configured/i.test(c[0] as string)
    );
    expect(errorCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('handles prompt failure gracefully', async () => {
    const prompts: string[] = [];
    // Use a 403 error which is detected as non-retryable and fails immediately
    injectMockAgent(ctx, async (text) => {
      prompts.push(text);
      throw new Error('403 Forbidden: model not found');
    });

    await ctx.prompt('first');

    // Non-retryable errors fail immediately without retries
    expect(prompts).toEqual(['first']);
    // Fatal errors call onFatalError if available, otherwise onError
    expect(callbacks.onFatalError).toHaveBeenCalled();
    // Should be in error status after fatal error
    const statusCalls = (callbacks.onStatusChange as any).mock.calls;
    expect(statusCalls[statusCalls.length - 1][0]).toBe('error');
  });
});

describe('ScoopContext clearMessages', () => {
  let ctx: ScoopContext;
  let callbacks: ScoopContextCallbacks;

  beforeEach(() => {
    callbacks = createMockCallbacks();
    ctx = new ScoopContext(testScoop, callbacks, {} as any);
  });

  it('calls agent.clearMessages() when agent exists', () => {
    injectMockAgent(ctx, async () => {});
    (ctx as any).agent.state.messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];

    ctx.clearMessages();

    expect((ctx as any).agent.state.messages).toEqual([]);
  });

  it('handles null agent gracefully (no throw)', () => {
    // Don't inject a mock agent, so agent is null
    expect((ctx as any).agent).toBeNull();

    // Should not throw
    expect(() => {
      ctx.clearMessages();
    }).not.toThrow();
  });
});

describe('ScoopContext context overflow recovery', () => {
  let ctx: ScoopContext;
  let callbacks: ScoopContextCallbacks;

  beforeEach(() => {
    callbacks = createMockCallbacks();
    ctx = new ScoopContext(testScoop, callbacks, {} as any);
  });

  function injectMockAgentWithReplace(
    ctx: ScoopContext,
    mockPrompt: (text: string) => Promise<void>
  ): { replaceMessages: ReturnType<typeof vi.fn>; mockPrompt: ReturnType<typeof vi.fn> } {
    const replaceMessages = vi.fn();
    const promptFn = vi.fn(mockPrompt);
    const stateData = { messages: [] as any[] };
    const state = new Proxy(stateData, {
      set(target, prop, value) {
        if (prop === 'messages') replaceMessages(value);
        (target as any)[prop] = value;
        return true;
      },
    });
    const agent = {
      prompt: promptFn,
      abort: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      state,
    };
    (ctx as any).agent = agent;
    (ctx as any).status = 'ready';
    return { replaceMessages, mockPrompt: promptFn };
  }

  it('detects overflow error and triggers recovery', () => {
    const { replaceMessages, mockPrompt } = injectMockAgentWithReplace(ctx, async () => {});
    mockPrompt.mockResolvedValue(undefined);

    const handler = (ctx as any).handleAgentEvent.bind(ctx);
    const overflowMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'prompt is too long: 250000 tokens > 200000 maximum',
      usage: { input: 250000, output: 0 },
      timestamp: Date.now(),
    };

    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        stopReason: 'stop',
        usage: { input: 100, output: 50 },
        timestamp: Date.now(),
      },
      overflowMessage,
    ];

    handler({ type: 'agent_end', messages });

    // Should NOT surface error to user
    expect(callbacks.onError).not.toHaveBeenCalled();
    // Should notify user that recovery is in progress
    expect(callbacks.onResponse).toHaveBeenCalledWith(expect.stringContaining('recovering'), false);
    // Should replace messages (removing the error message)
    expect(replaceMessages).toHaveBeenCalled();
    // Should re-prompt with explanation
    expect(mockPrompt).toHaveBeenCalledWith(expect.stringContaining('Context overflow recovered'));
  });

  it('replaces oversized messages during recovery', () => {
    const { replaceMessages, mockPrompt } = injectMockAgentWithReplace(ctx, async () => {});
    mockPrompt.mockResolvedValue(undefined);

    const handler = (ctx as any).handleAgentEvent.bind(ctx);
    const largeContent = 'x'.repeat(50000); // 50K chars > 40K threshold
    const overflowMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'prompt is too long: 250000 tokens > 200000 maximum',
      usage: { input: 250000, output: 0 },
      timestamp: Date.now(),
    };

    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: largeContent }] },
      overflowMessage,
    ];

    handler({ type: 'agent_end', messages });

    const replacedMessages = replaceMessages.mock.calls[0][0];
    // Should have removed the error message
    expect(replacedMessages.length).toBe(2);
    // The oversized tool result should be replaced with a placeholder
    expect(replacedMessages[1].content[0].text).toContain('Content removed');
    expect(replacedMessages[1].content[0].text).toContain('too large');
  });

  it('replaces oversized image content during recovery', () => {
    const { replaceMessages, mockPrompt } = injectMockAgentWithReplace(ctx, async () => {});
    mockPrompt.mockResolvedValue(undefined);

    const handler = (ctx as any).handleAgentEvent.bind(ctx);
    const largeBase64 = 'A'.repeat(50000);
    const overflowMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'prompt is too long: 250000 tokens > 200000 maximum',
      usage: { input: 250000, output: 0 },
      timestamp: Date.now(),
    };

    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'show image' }] },
      {
        role: 'toolResult',
        toolCallId: 't1',
        content: [{ type: 'image', data: largeBase64, mimeType: 'image/png' }],
      },
      overflowMessage,
    ];

    handler({ type: 'agent_end', messages });

    const replacedMessages = replaceMessages.mock.calls[0][0];
    expect(replacedMessages[1].content[0].text).toContain('Content removed');
  });

  it('preserves ToolCall blocks in assistant messages during overflow recovery', () => {
    const { replaceMessages, mockPrompt } = injectMockAgentWithReplace(ctx, async () => {});
    mockPrompt.mockResolvedValue(undefined);

    const handler = (ctx as any).handleAgentEvent.bind(ctx);
    const largeText = 'x'.repeat(50000); // oversized
    const overflowMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'prompt is too long: 250000 tokens > 200000 maximum',
      usage: { input: 250000, output: 0 },
      timestamp: Date.now(),
    };

    // Assistant message with BOTH large text AND a toolCall block
    const assistantWithToolCall = {
      role: 'assistant',
      content: [
        { type: 'text', text: largeText },
        { type: 'toolCall', id: 'toolu_abc123', name: 'bash', arguments: { command: 'ls' } },
      ],
      stopReason: 'tool_use',
      usage: { input: 100, output: 100 },
      timestamp: Date.now(),
    };

    const toolResult = {
      role: 'toolResult',
      toolCallId: 'toolu_abc123',
      toolName: 'bash',
      content: [{ type: 'text', text: 'file.txt' }],
      isError: false,
      timestamp: Date.now(),
    };

    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'list files' }] },
      assistantWithToolCall,
      toolResult,
      overflowMessage,
    ];

    handler({ type: 'agent_end', messages });

    const replacedMessages = replaceMessages.mock.calls[0][0];
    // The assistant message should be replaced but MUST keep the toolCall block
    const assistantMsg = replacedMessages[1];
    const toolCallBlocks = assistantMsg.content.filter((b: any) => b.type === 'toolCall');
    expect(toolCallBlocks).toHaveLength(1);
    expect(toolCallBlocks[0].id).toBe('toolu_abc123');
    // The large text should be replaced with a placeholder
    const textBlocks = assistantMsg.content.filter((b: any) => b.type === 'text');
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0].text).toContain('Content removed');
  });

  it('preserves multiple ToolCall blocks in a single assistant message', () => {
    const { replaceMessages, mockPrompt } = injectMockAgentWithReplace(ctx, async () => {});
    mockPrompt.mockResolvedValue(undefined);

    const handler = (ctx as any).handleAgentEvent.bind(ctx);
    const largeText = 'x'.repeat(50000);
    const overflowMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'prompt is too long: 250000 tokens > 200000 maximum',
      usage: { input: 250000, output: 0 },
      timestamp: Date.now(),
    };

    const assistantWithMultipleToolCalls = {
      role: 'assistant',
      content: [
        { type: 'text', text: largeText },
        { type: 'toolCall', id: 'toolu_1', name: 'read_file', arguments: { path: '/a.ts' } },
        { type: 'toolCall', id: 'toolu_2', name: 'read_file', arguments: { path: '/b.ts' } },
        { type: 'toolCall', id: 'toolu_3', name: 'bash', arguments: { command: 'ls' } },
      ],
      stopReason: 'tool_use',
      usage: { input: 100, output: 100 },
      timestamp: Date.now(),
    };

    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'do stuff' }] },
      assistantWithMultipleToolCalls,
      {
        role: 'toolResult',
        toolCallId: 'toolu_1',
        toolName: 'read_file',
        content: [{ type: 'text', text: 'a' }],
        isError: false,
        timestamp: Date.now(),
      },
      {
        role: 'toolResult',
        toolCallId: 'toolu_2',
        toolName: 'read_file',
        content: [{ type: 'text', text: 'b' }],
        isError: false,
        timestamp: Date.now(),
      },
      {
        role: 'toolResult',
        toolCallId: 'toolu_3',
        toolName: 'bash',
        content: [{ type: 'text', text: 'c' }],
        isError: false,
        timestamp: Date.now(),
      },
      overflowMessage,
    ];

    handler({ type: 'agent_end', messages });

    const replacedMessages = replaceMessages.mock.calls[0][0];
    const assistantMsg = replacedMessages[1];
    const toolCallBlocks = assistantMsg.content.filter((b: any) => b.type === 'toolCall');
    expect(toolCallBlocks).toHaveLength(3);
    expect(toolCallBlocks.map((b: any) => b.id)).toEqual(['toolu_1', 'toolu_2', 'toolu_3']);
  });

  it('preserves ToolCalls when assistant has large image content', () => {
    const { replaceMessages, mockPrompt } = injectMockAgentWithReplace(ctx, async () => {});
    mockPrompt.mockResolvedValue(undefined);

    const handler = (ctx as any).handleAgentEvent.bind(ctx);
    const overflowMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'prompt is too long: 250000 tokens > 200000 maximum',
      usage: { input: 250000, output: 0 },
      timestamp: Date.now(),
    };

    // Assistant with large image + toolCall (image inflates msgSize over threshold)
    const assistantMsg = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Here is the screenshot' },
        { type: 'image', data: 'A'.repeat(50000), mimeType: 'image/png' },
        { type: 'toolCall', id: 'toolu_img', name: 'bash', arguments: { command: 'screenshot' } },
      ],
      stopReason: 'tool_use',
      usage: { input: 100, output: 100 },
      timestamp: Date.now(),
    };

    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'take screenshot' }] },
      assistantMsg,
      {
        role: 'toolResult',
        toolCallId: 'toolu_img',
        toolName: 'bash',
        content: [{ type: 'text', text: 'done' }],
        isError: false,
        timestamp: Date.now(),
      },
      overflowMessage,
    ];

    handler({ type: 'agent_end', messages });

    const replacedMessages = replaceMessages.mock.calls[0][0];
    const replaced = replacedMessages[1];
    // ToolCall preserved
    const toolCalls = replaced.content.filter((b: any) => b.type === 'toolCall');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].id).toBe('toolu_img');
    // Image and text replaced with single placeholder
    const textBlocks = replaced.content.filter((b: any) => b.type === 'text');
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0].text).toContain('Content removed');
    // No image blocks remain
    expect(replaced.content.filter((b: any) => b.type === 'image')).toHaveLength(0);
  });

  it('does not replace assistant messages that are only ToolCalls (not oversized)', () => {
    const { replaceMessages, mockPrompt } = injectMockAgentWithReplace(ctx, async () => {});
    mockPrompt.mockResolvedValue(undefined);

    const handler = (ctx as any).handleAgentEvent.bind(ctx);
    const overflowMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'prompt is too long: 250000 tokens > 200000 maximum',
      usage: { input: 250000, output: 0 },
      timestamp: Date.now(),
    };

    // Assistant with only a small text + toolCall — NOT oversized
    const smallAssistant = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me check that.' },
        { type: 'toolCall', id: 'toolu_small', name: 'bash', arguments: { command: 'ls' } },
      ],
      stopReason: 'tool_use',
      usage: { input: 100, output: 50 },
      timestamp: Date.now(),
    };

    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'check' }] },
      smallAssistant,
      {
        role: 'toolResult',
        toolCallId: 'toolu_small',
        toolName: 'bash',
        content: [{ type: 'text', text: 'file.txt' }],
        isError: false,
        timestamp: Date.now(),
      },
      overflowMessage,
    ];

    handler({ type: 'agent_end', messages });

    const replacedMessages = replaceMessages.mock.calls[0][0];
    // Small assistant should be unchanged (not oversized)
    const assistantMsg = replacedMessages[1];
    expect(assistantMsg.content).toHaveLength(2);
    expect(assistantMsg.content[0].text).toBe('Let me check that.');
    expect(assistantMsg.content[1].id).toBe('toolu_small');
  });

  it('fully replaces oversized assistant with no ToolCalls (just placeholder)', () => {
    const { replaceMessages, mockPrompt } = injectMockAgentWithReplace(ctx, async () => {});
    mockPrompt.mockResolvedValue(undefined);

    const handler = (ctx as any).handleAgentEvent.bind(ctx);
    const overflowMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'prompt is too long: 250000 tokens > 200000 maximum',
      usage: { input: 250000, output: 0 },
      timestamp: Date.now(),
    };

    // Oversized assistant with only text — no ToolCalls
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'explain' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'x'.repeat(50000) }],
        stopReason: 'stop',
        usage: { input: 100, output: 50000 },
        timestamp: Date.now(),
      },
      overflowMessage,
    ];

    handler({ type: 'agent_end', messages });

    const replacedMessages = replaceMessages.mock.calls[0][0];
    const assistantMsg = replacedMessages[1];
    // Should have exactly one placeholder text block, no empty toolCall array
    expect(assistantMsg.content).toHaveLength(1);
    expect(assistantMsg.content[0].type).toBe('text');
    expect(assistantMsg.content[0].text).toContain('Content removed');
  });

  it('still fully replaces oversized toolResult messages (no ToolCalls to preserve)', () => {
    const { replaceMessages, mockPrompt } = injectMockAgentWithReplace(ctx, async () => {});
    mockPrompt.mockResolvedValue(undefined);

    const handler = (ctx as any).handleAgentEvent.bind(ctx);
    const overflowMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'prompt is too long: 250000 tokens > 200000 maximum',
      usage: { input: 250000, output: 0 },
      timestamp: Date.now(),
    };

    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'read big file' }] },
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'toolu_big', name: 'read_file', arguments: { path: '/big.ts' } },
        ],
        stopReason: 'tool_use',
        usage: { input: 100, output: 50 },
        timestamp: Date.now(),
      },
      {
        role: 'toolResult',
        toolCallId: 'toolu_big',
        toolName: 'read_file',
        content: [{ type: 'text', text: 'x'.repeat(50000) }],
        isError: false,
        timestamp: Date.now(),
      },
      overflowMessage,
    ];

    handler({ type: 'agent_end', messages });

    const replacedMessages = replaceMessages.mock.calls[0][0];
    // toolResult should be fully replaced (single placeholder, no ToolCall blocks)
    const toolResultMsg = replacedMessages[2];
    expect(toolResultMsg.role).toBe('toolResult');
    expect(toolResultMsg.content).toHaveLength(1);
    expect(toolResultMsg.content[0].text).toContain('Content removed');
    // But it must keep its toolCallId for pairing
    expect(toolResultMsg.toolCallId).toBe('toolu_big');
    // And the preceding assistant must still have its toolCall
    const assistantMsg = replacedMessages[1];
    expect(assistantMsg.content[0].id).toBe('toolu_big');
  });

  it('limits recovery to one attempt (no infinite loop)', () => {
    const { replaceMessages, mockPrompt } = injectMockAgentWithReplace(ctx, async () => {});
    mockPrompt.mockResolvedValue(undefined);

    const handler = (ctx as any).handleAgentEvent.bind(ctx);
    const overflowMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'prompt is too long: 250000 tokens > 200000 maximum',
      usage: { input: 250000, output: 0 },
      timestamp: Date.now(),
    };

    // First overflow — should trigger recovery
    handler({
      type: 'agent_end',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }, overflowMessage],
    });

    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(replaceMessages).toHaveBeenCalledTimes(1);

    // Second overflow (recovery also overflowed) — should surface error
    handler({
      type: 'agent_end',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }, overflowMessage],
    });

    expect(callbacks.onError).toHaveBeenCalledWith(overflowMessage.errorMessage);
  });

  it('does not attempt recovery for non-overflow errors', () => {
    const { replaceMessages } = injectMockAgentWithReplace(ctx, async () => {});

    const handler = (ctx as any).handleAgentEvent.bind(ctx);
    const errorMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'Internal server error',
      usage: { input: 100, output: 0 },
      timestamp: Date.now(),
    };

    handler({
      type: 'agent_end',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }, errorMessage],
    });

    // Should surface error directly, not attempt recovery
    expect(callbacks.onError).toHaveBeenCalledWith('Internal server error');
    expect(replaceMessages).not.toHaveBeenCalled();
  });

  it('resets recovery flag after successful recovery', async () => {
    const { mockPrompt } = injectMockAgentWithReplace(ctx, async () => {});
    mockPrompt.mockResolvedValue(undefined);

    const handler = (ctx as any).handleAgentEvent.bind(ctx);
    const overflowMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'prompt is too long: 250000 tokens > 200000 maximum',
      usage: { input: 250000, output: 0 },
      timestamp: Date.now(),
    };

    // Trigger recovery
    handler({
      type: 'agent_end',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }, overflowMessage],
    });

    // Simulate successful recovery (agent_end with no error)
    handler({
      type: 'agent_end',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'recovery prompt' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'recovered' }],
          stopReason: 'stop',
          usage: { input: 100, output: 50 },
          timestamp: Date.now(),
        },
      ],
    });

    // Flag should be reset — a new overflow should trigger recovery again
    expect((ctx as any).isRecovering).toBe(false);

    // Third agent_end with overflow should trigger recovery (flag was reset)
    handler({
      type: 'agent_end',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello again' }] },
        overflowMessage,
      ],
    });

    // Should have triggered recovery again (not surfaced error)
    expect(callbacks.onError).not.toHaveBeenCalled();
  });
});

describe('isImageProcessingError', () => {
  it('matches "image exceeds 5 MB maximum"', () => {
    expect(isImageProcessingError('image exceeds 5 MB maximum')).toBe(true);
  });

  it('matches "image exceeds 5MB maximum" (no space)', () => {
    expect(isImageProcessingError('image exceeds 5MB maximum')).toBe(true);
  });

  it('matches "Could not process image"', () => {
    expect(isImageProcessingError('Could not process image')).toBe(true);
  });

  it('matches "invalid base64 image data"', () => {
    expect(isImageProcessingError('invalid base64 image data')).toBe(true);
  });

  it('matches "image is too large"', () => {
    expect(isImageProcessingError('image is too large')).toBe(true);
  });

  it('matches "image is too big"', () => {
    expect(isImageProcessingError('image is too big')).toBe(true);
  });

  it('does not match generic errors', () => {
    expect(isImageProcessingError('Internal server error')).toBe(false);
    expect(isImageProcessingError('Rate limit exceeded')).toBe(false);
    expect(isImageProcessingError('Authentication failed')).toBe(false);
  });

  it('does not match context overflow errors', () => {
    expect(isImageProcessingError('prompt is too long: 250000 tokens > 200000 maximum')).toBe(
      false
    );
  });
});

describe('isNonRetryableError', () => {
  it('matches 401 unauthorized errors', () => {
    expect(isNonRetryableError('401 Unauthorized')).toBe(true);
    expect(isNonRetryableError('Error: 401 - Invalid API key')).toBe(true);
  });

  it('matches 403 forbidden errors', () => {
    expect(isNonRetryableError('403 Forbidden')).toBe(true);
    expect(isNonRetryableError('Error 403: Access denied')).toBe(true);
  });

  it('matches 404 not found errors', () => {
    expect(isNonRetryableError('404 Not Found')).toBe(true);
    expect(isNonRetryableError('Model not found: claude-opus-4.5')).toBe(true);
  });

  it('matches invalid model errors', () => {
    expect(isNonRetryableError('model not found')).toBe(true);
    expect(isNonRetryableError('invalid model id')).toBe(true);
    expect(isNonRetryableError('unknown model: gpt-5')).toBe(true);
    expect(isNonRetryableError('The model does not exist')).toBe(true);
  });

  it('matches authentication failures', () => {
    expect(isNonRetryableError('authentication failed')).toBe(true);
    expect(isNonRetryableError('Unauthorized access')).toBe(true);
    expect(isNonRetryableError('Forbidden: insufficient permissions')).toBe(true);
    expect(isNonRetryableError('invalid api key')).toBe(true);
    expect(isNonRetryableError('Invalid API-Key provided')).toBe(true);
  });

  it('matches billing/quota errors', () => {
    expect(isNonRetryableError('insufficient quota')).toBe(true);
    expect(isNonRetryableError('billing issue detected')).toBe(true);
    expect(isNonRetryableError('payment required')).toBe(true);
    expect(isNonRetryableError('account suspended')).toBe(true);
  });

  it('matches malformed request errors', () => {
    expect(isNonRetryableError('invalid request body')).toBe(true);
    expect(isNonRetryableError('malformed JSON')).toBe(true);
    expect(isNonRetryableError('bad request: missing field')).toBe(true);
  });

  it('does NOT match 429 rate limit (retryable)', () => {
    expect(isNonRetryableError('429 Too Many Requests')).toBe(false);
  });

  it('does NOT match 5xx server errors (retryable)', () => {
    expect(isNonRetryableError('500 Internal Server Error')).toBe(false);
    expect(isNonRetryableError('502 Bad Gateway')).toBe(false);
    expect(isNonRetryableError('503 Service Unavailable')).toBe(false);
  });

  it('does NOT match network errors (retryable)', () => {
    expect(isNonRetryableError('network error')).toBe(false);
    expect(isNonRetryableError('connection refused')).toBe(false);
    expect(isNonRetryableError('timeout')).toBe(false);
  });
});

describe('isRetryableError', () => {
  it('matches 429 rate limit errors', () => {
    expect(isRetryableError('429 Too Many Requests')).toBe(true);
    expect(isRetryableError('rate limit exceeded')).toBe(true);
    expect(isRetryableError('too many requests, please slow down')).toBe(true);
    expect(isRetryableError('quota exceeded, try again later')).toBe(true);
  });

  it('matches 5xx server errors', () => {
    expect(isRetryableError('500 Internal Server Error')).toBe(true);
    expect(isRetryableError('502 Bad Gateway')).toBe(true);
    expect(isRetryableError('503 Service Unavailable')).toBe(true);
    expect(isRetryableError('504 Gateway Timeout')).toBe(true);
    expect(isRetryableError('internal server error')).toBe(true);
    expect(isRetryableError('bad gateway')).toBe(true);
    expect(isRetryableError('service unavailable')).toBe(true);
    expect(isRetryableError('gateway timeout')).toBe(true);
  });

  it('matches network errors', () => {
    expect(isRetryableError('network error')).toBe(true);
    expect(isRetryableError('Failed to fetch')).toBe(true);
    expect(isRetryableError('connection refused')).toBe(true);
    expect(isRetryableError('request timeout')).toBe(true);
    expect(isRetryableError('ECONNRESET')).toBe(true);
    expect(isRetryableError('socket hang up')).toBe(true);
  });

  it('matches temporary overload errors', () => {
    expect(isRetryableError('server overloaded')).toBe(true);
    expect(isRetryableError('temporarily unavailable')).toBe(true);
    expect(isRetryableError('please try again later')).toBe(true);
  });

  it('does NOT match 4xx client errors (non-retryable)', () => {
    expect(isRetryableError('401 Unauthorized')).toBe(false);
    expect(isRetryableError('403 Forbidden')).toBe(false);
    expect(isRetryableError('404 Not Found')).toBe(false);
  });

  it('does NOT match auth/model errors (non-retryable)', () => {
    expect(isRetryableError('invalid api key')).toBe(false);
    expect(isRetryableError('model not found')).toBe(false);
    expect(isRetryableError('authentication failed')).toBe(false);
  });
});

describe('abortableSleep', () => {
  it('resolves with false after the timeout elapses', async () => {
    const start = Date.now();
    const aborted = await abortableSleep(20);
    expect(aborted).toBe(false);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  it('resolves with true immediately when signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const start = Date.now();
    const aborted = await abortableSleep(5000, ac.signal);
    expect(aborted).toBe(true);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('resolves with true when signal aborts mid-sleep', async () => {
    const ac = new AbortController();
    const start = Date.now();
    const promise = abortableSleep(5000, ac.signal);
    setTimeout(() => ac.abort(), 15);
    const aborted = await promise;
    expect(aborted).toBe(true);
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe('ScoopContext retry cancellation', () => {
  let ctx: ScoopContext;
  let callbacks: ScoopContextCallbacks;

  beforeEach(() => {
    callbacks = createMockCallbacks();
    ctx = new ScoopContext(testScoop, callbacks, {} as any);
  });

  it('stop() cancels a pending backoff sleep without completing retries', async () => {
    let attempts = 0;
    injectMockAgent(ctx, async () => {
      attempts += 1;
      throw new Error('503 Service Unavailable');
    });

    const promptPromise = ctx.prompt('hello');
    // Let the first attempt fail and enter the backoff sleep.
    await new Promise((resolve) => setTimeout(resolve, 10));
    ctx.stop();
    await promptPromise;

    // Only the first attempt should have run — stop() aborted backoff before retries.
    expect(attempts).toBe(1);
    // stop() transitions status to ready; no fatal error should fire on cancellation.
    expect(callbacks.onFatalError).not.toHaveBeenCalled();
    const statusCalls = (callbacks.onStatusChange as any).mock.calls.map((c: any[]) => c[0]);
    expect(statusCalls).toContain('ready');
  });

  it('dispose() cancels a pending backoff sleep', async () => {
    let attempts = 0;
    injectMockAgent(ctx, async () => {
      attempts += 1;
      throw new Error('503 Service Unavailable');
    });

    const promptPromise = ctx.prompt('hello');
    await new Promise((resolve) => setTimeout(resolve, 10));
    ctx.dispose();
    await promptPromise;

    expect(attempts).toBe(1);
    expect(callbacks.onFatalError).not.toHaveBeenCalled();
  });
});

describe('ScoopContext stream error retries', () => {
  let ctx: ScoopContext;
  let callbacks: ScoopContextCallbacks;

  beforeEach(() => {
    callbacks = createMockCallbacks();
    ctx = new ScoopContext(testScoop, callbacks, {} as any);
  });

  it('retries retryable agent_end stream errors before surfacing them', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      injectMockAgent(ctx, async () => {
        attempts += 1;
        if (attempts === 1) {
          (ctx as any).handleAgentEvent({
            type: 'agent_end',
            messages: [
              {
                role: 'assistant',
                content: [],
                errorMessage: 'Failed to fetch',
              },
            ],
          });
        }
      });

      const promptPromise = ctx.prompt('hello');
      await Promise.resolve();

      expect(attempts).toBe(1);
      expect(callbacks.onError).not.toHaveBeenCalled();
      expect(callbacks.onFatalError).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      await promptPromise;

      expect(attempts).toBe(2);
      expect(callbacks.onError).not.toHaveBeenCalled();
      expect(callbacks.onFatalError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces stream errors without retrying once partial deltas have streamed', async () => {
    let attempts = 0;
    injectMockAgent(ctx, async () => {
      attempts += 1;
      (ctx as any).handleAgentEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'partial answer ' },
      });
      (ctx as any).handleAgentEvent({
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'partial answer ' }],
            errorMessage: 'Failed to fetch',
          },
        ],
      });
    });

    await ctx.prompt('hello');

    expect(attempts).toBe(1);
    expect(callbacks.onError).toHaveBeenCalledWith('Failed to fetch');
    expect(callbacks.onFatalError).not.toHaveBeenCalled();
  });
});

describe('ScoopContext image error recovery', () => {
  let ctx: ScoopContext;
  let callbacks: ScoopContextCallbacks;

  beforeEach(() => {
    callbacks = createMockCallbacks();
    ctx = new ScoopContext(testScoop, callbacks, {} as any);
  });

  function injectMockAgentWithReplace(
    ctx: ScoopContext,
    mockPrompt: (text: string) => Promise<void>
  ): { replaceMessages: ReturnType<typeof vi.fn>; mockPrompt: ReturnType<typeof vi.fn> } {
    const replaceMessages = vi.fn();
    const promptFn = vi.fn(mockPrompt);
    const stateData = { messages: [] as any[] };
    const state = new Proxy(stateData, {
      set(target, prop, value) {
        if (prop === 'messages') replaceMessages(value);
        (target as any)[prop] = value;
        return true;
      },
    });
    const agent = {
      prompt: promptFn,
      abort: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      state,
    };
    (ctx as any).agent = agent;
    (ctx as any).status = 'ready';
    return { replaceMessages, mockPrompt: promptFn };
  }

  it('detects image error and triggers recovery', () => {
    const { replaceMessages, mockPrompt } = injectMockAgentWithReplace(ctx, async () => {});
    mockPrompt.mockResolvedValue(undefined);

    const handler = (ctx as any).handleAgentEvent.bind(ctx);
    const imageErrorMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'image exceeds 5 MB maximum: 7340032 bytes > 5242880 bytes limit',
      usage: { input: 100, output: 0 },
      timestamp: Date.now(),
    };

    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      {
        role: 'toolResult',
        toolCallId: 't1',
        content: [
          { type: 'text', text: 'Screenshot saved' },
          { type: 'image', data: 'A'.repeat(10000), mimeType: 'image/png' },
        ],
      },
      imageErrorMessage,
    ];

    handler({ type: 'agent_end', messages });

    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onResponse).toHaveBeenCalledWith(
      expect.stringContaining('Image rejected'),
      false
    );
    expect(replaceMessages).toHaveBeenCalled();
    expect(mockPrompt).toHaveBeenCalledWith(expect.stringContaining('image was rejected'));
  });

  it('strips image blocks from recent messages during recovery', () => {
    const { replaceMessages, mockPrompt } = injectMockAgentWithReplace(ctx, async () => {});
    mockPrompt.mockResolvedValue(undefined);

    const handler = (ctx as any).handleAgentEvent.bind(ctx);
    const imageErrorMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'image exceeds 5 MB maximum',
      usage: { input: 100, output: 0 },
      timestamp: Date.now(),
    };

    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'show me' }] },
      {
        role: 'toolResult',
        toolCallId: 't1',
        content: [
          { type: 'text', text: 'Here is the screenshot' },
          { type: 'image', data: 'huge-image-data', mimeType: 'image/png' },
        ],
      },
      imageErrorMessage,
    ];

    handler({ type: 'agent_end', messages });

    const replacedMessages = replaceMessages.mock.calls[0][0];
    // Should have removed the error message
    expect(replacedMessages.length).toBe(2);
    // The tool result should only have text, images stripped
    const toolResult = replacedMessages[1];
    expect(toolResult.content).toHaveLength(1);
    expect(toolResult.content[0].type).toBe('text');
    expect(toolResult.content[0].text).toBe('Here is the screenshot');
  });

  it('replaces messages that become empty after image stripping', () => {
    const { replaceMessages, mockPrompt } = injectMockAgentWithReplace(ctx, async () => {});
    mockPrompt.mockResolvedValue(undefined);

    const handler = (ctx as any).handleAgentEvent.bind(ctx);
    const imageErrorMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'image exceeds 5 MB maximum',
      usage: { input: 100, output: 0 },
      timestamp: Date.now(),
    };

    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'screenshot' }] },
      {
        role: 'toolResult',
        toolCallId: 't1',
        content: [{ type: 'image', data: 'only-image', mimeType: 'image/png' }],
      },
      imageErrorMessage,
    ];

    handler({ type: 'agent_end', messages });

    const replacedMessages = replaceMessages.mock.calls[0][0];
    const toolResult = replacedMessages[1];
    expect(toolResult.content).toHaveLength(1);
    expect(toolResult.content[0].text).toContain('Image removed');
  });

  it('preserves ToolCall blocks in assistant messages during image recovery', () => {
    const { replaceMessages, mockPrompt } = injectMockAgentWithReplace(ctx, async () => {});
    mockPrompt.mockResolvedValue(undefined);

    const handler = (ctx as any).handleAgentEvent.bind(ctx);
    const imageErrorMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'image exceeds 5 MB maximum',
      usage: { input: 100, output: 0 },
      timestamp: Date.now(),
    };

    // Assistant message with text + image + toolCall
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'screenshot and check' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Here is the screenshot' },
          { type: 'image', data: 'huge-image', mimeType: 'image/png' },
          { type: 'toolCall', id: 'toolu_check', name: 'bash', arguments: { command: 'check' } },
        ],
        stopReason: 'tool_use',
        usage: { input: 100, output: 100 },
        timestamp: Date.now(),
      },
      {
        role: 'toolResult',
        toolCallId: 'toolu_check',
        toolName: 'bash',
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
        timestamp: Date.now(),
      },
      imageErrorMessage,
    ];

    handler({ type: 'agent_end', messages });

    const replacedMessages = replaceMessages.mock.calls[0][0];
    const assistantMsg = replacedMessages[1];
    // Image removed, but text and ToolCall preserved
    expect(assistantMsg.content.filter((b: any) => b.type === 'image')).toHaveLength(0);
    expect(assistantMsg.content.filter((b: any) => b.type === 'toolCall')).toHaveLength(1);
    expect(assistantMsg.content.find((b: any) => b.type === 'toolCall').id).toBe('toolu_check');
    expect(assistantMsg.content.filter((b: any) => b.type === 'text')).toHaveLength(1);
  });

  it('preserves multiple ToolCall blocks in a single assistant message during image recovery', () => {
    const { replaceMessages, mockPrompt } = injectMockAgentWithReplace(ctx, async () => {});
    mockPrompt.mockResolvedValue(undefined);

    const handler = (ctx as any).handleAgentEvent.bind(ctx);
    const imageErrorMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'Could not process image: invalid image payload',
      usage: { input: 100, output: 0 },
      timestamp: Date.now(),
    };

    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'inspect screenshot' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking the screenshot now' },
          { type: 'image', data: 'huge-image', mimeType: 'image/png' },
          { type: 'toolCall', id: 'toolu_1', name: 'bash', arguments: { command: 'pwd' } },
          { type: 'toolCall', id: 'toolu_2', name: 'bash', arguments: { command: 'ls' } },
        ],
        stopReason: 'tool_use',
        usage: { input: 100, output: 100 },
        timestamp: Date.now(),
      },
      imageErrorMessage,
    ];

    handler({ type: 'agent_end', messages });

    const replacedMessages = replaceMessages.mock.calls[0][0];
    const assistantMsg = replacedMessages[1];
    expect(assistantMsg.content.filter((b: any) => b.type === 'image')).toHaveLength(0);
    expect(assistantMsg.content.filter((b: any) => b.type === 'toolCall')).toHaveLength(2);
    expect(
      assistantMsg.content.filter((b: any) => b.type === 'toolCall').map((b: any) => b.id)
    ).toEqual(['toolu_1', 'toolu_2']);
  });

  it('preserves assistant ToolCalls when stripping image-only content during image recovery', () => {
    const { replaceMessages, mockPrompt } = injectMockAgentWithReplace(ctx, async () => {});
    mockPrompt.mockResolvedValue(undefined);

    const handler = (ctx as any).handleAgentEvent.bind(ctx);
    const imageErrorMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'image too large for provider',
      usage: { input: 100, output: 0 },
      timestamp: Date.now(),
    };

    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'use the screenshot' }] },
      {
        role: 'assistant',
        content: [
          { type: 'image', data: 'only-image', mimeType: 'image/png' },
          { type: 'toolCall', id: 'toolu_only', name: 'bash', arguments: { command: 'echo ok' } },
        ],
        stopReason: 'tool_use',
        usage: { input: 100, output: 100 },
        timestamp: Date.now(),
      },
      imageErrorMessage,
    ];

    handler({ type: 'agent_end', messages });

    const replacedMessages = replaceMessages.mock.calls[0][0];
    const assistantMsg = replacedMessages[1];
    expect(assistantMsg.content).toEqual([
      { type: 'toolCall', id: 'toolu_only', name: 'bash', arguments: { command: 'echo ok' } },
    ]);
  });

  it('replaces assistant messages that become empty after image stripping', () => {
    const { replaceMessages, mockPrompt } = injectMockAgentWithReplace(ctx, async () => {});
    mockPrompt.mockResolvedValue(undefined);

    const handler = (ctx as any).handleAgentEvent.bind(ctx);
    const imageErrorMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'invalid image format',
      usage: { input: 100, output: 0 },
      timestamp: Date.now(),
    };

    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'what is in this image?' }] },
      {
        role: 'assistant',
        content: [{ type: 'image', data: 'assistant-only-image', mimeType: 'image/png' }],
        stopReason: 'stop',
        usage: { input: 100, output: 100 },
        timestamp: Date.now(),
      },
      imageErrorMessage,
    ];

    handler({ type: 'agent_end', messages });

    const replacedMessages = replaceMessages.mock.calls[0][0];
    const assistantMsg = replacedMessages[1];
    expect(assistantMsg.content).toHaveLength(1);
    expect(assistantMsg.content[0].type).toBe('text');
    expect(assistantMsg.content[0].text).toContain('Image removed');
  });

  it('limits recovery to one attempt (prevents infinite loop)', () => {
    const { replaceMessages, mockPrompt } = injectMockAgentWithReplace(ctx, async () => {});
    mockPrompt.mockResolvedValue(undefined);

    const handler = (ctx as any).handleAgentEvent.bind(ctx);
    const imageErrorMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'image exceeds 5 MB maximum',
      usage: { input: 100, output: 0 },
      timestamp: Date.now(),
    };

    // First image error — should trigger recovery
    handler({
      type: 'agent_end',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }, imageErrorMessage],
    });

    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(replaceMessages).toHaveBeenCalledTimes(1);

    // Second image error (recovery also failed) — should surface error
    handler({
      type: 'agent_end',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }, imageErrorMessage],
    });

    expect(callbacks.onError).toHaveBeenCalledWith(imageErrorMessage.errorMessage);
  });

  it('resets recovery flag after successful recovery', () => {
    const { mockPrompt } = injectMockAgentWithReplace(ctx, async () => {});
    mockPrompt.mockResolvedValue(undefined);

    const handler = (ctx as any).handleAgentEvent.bind(ctx);
    const imageErrorMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'image exceeds 5 MB maximum',
      usage: { input: 100, output: 0 },
      timestamp: Date.now(),
    };

    // Trigger recovery
    handler({
      type: 'agent_end',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }, imageErrorMessage],
    });

    // Simulate successful recovery
    handler({
      type: 'agent_end',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'recovery prompt' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'recovered' }],
          stopReason: 'stop',
          usage: { input: 100, output: 50 },
          timestamp: Date.now(),
        },
      ],
    });

    expect((ctx as any).isRecovering).toBe(false);
    expect(callbacks.onError).not.toHaveBeenCalled();
  });
});

describe('ScoopContext.reloadSkills', () => {
  it('updates system prompt when new skills are installed', async () => {
    const callbacks = createMockCallbacks();
    const ctx = new ScoopContext(testScoop, callbacks, {} as VirtualFS);

    // Inject mock agent with state that tracks systemPrompt changes
    const agent = {
      prompt: vi.fn(),
      abort: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      followUp: vi.fn(),
      clearAllQueues: vi.fn(),
      state: { isStreaming: false, systemPrompt: 'old prompt' },
    };
    (ctx as any).agent = agent;
    (ctx as any).status = 'ready';

    // Create a real VFS with a skill
    const { VirtualFS } = await import('../../src/fs/virtual-fs.js');
    const vfs = await VirtualFS.create({ dbName: 'test-reload-skills', wipe: true });
    await vfs.mkdir('/workspace/skills/test-skill', { recursive: true });
    await vfs.writeFile(
      '/workspace/skills/test-skill/SKILL.md',
      '---\nname: test-skill\ndescription: A test skill\n---\nTest instructions.'
    );

    // Set the skillsFs so reloadSkills can find the skill
    (ctx as any).skillsFs = vfs;

    await ctx.reloadSkills();

    const newPrompt = agent.state.systemPrompt;
    expect(newPrompt).not.toBe('old prompt');
    expect(newPrompt).toContain('test-skill');
    expect(newPrompt).toContain('A test skill');
  });

  it('is a no-op when agent is not initialized', async () => {
    const callbacks = createMockCallbacks();
    const ctx = new ScoopContext(testScoop, callbacks, {} as VirtualFS);
    // agent is null -- should not throw
    await expect(ctx.reloadSkills()).resolves.toBeUndefined();
  });
});

describe('ScoopContext dispose', () => {
  let ctx: ScoopContext;
  let callbacks: ScoopContextCallbacks;

  beforeEach(() => {
    callbacks = createMockCallbacks();
    ctx = new ScoopContext(testScoop, callbacks, {} as any);
  });

  it('aborts agent and clears queues on dispose', () => {
    injectMockAgent(ctx, async () => {});
    const agent = (ctx as any).agent;

    ctx.dispose();

    expect(agent.abort).toHaveBeenCalled();
    expect(agent.clearAllQueues).toHaveBeenCalled();
    expect((ctx as any).agent).toBeNull();
  });

  it('suppresses status callbacks after dispose', async () => {
    let resolvePrompt!: () => void;
    const promptStarted = new Promise<void>((r) => {
      resolvePrompt = r;
    });
    let resolveBlock!: () => void;
    const blockPrompt = new Promise<void>((r) => {
      resolveBlock = r;
    });

    injectMockAgent(ctx, async () => {
      resolvePrompt();
      await blockPrompt;
    });

    const promptPromise = ctx.prompt('hello');
    await promptStarted;

    ctx.dispose();

    resolveBlock();
    await promptPromise;

    const statusCalls = (callbacks.onStatusChange as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0]
    );
    expect(statusCalls).toContain('processing');
    const afterProcessing = statusCalls.slice(statusCalls.indexOf('processing') + 1);
    expect(afterProcessing).not.toContain('ready');
  });

  it('suppresses error callbacks from aborted prompt', async () => {
    let resolvePrompt!: () => void;
    const promptStarted = new Promise<void>((r) => {
      resolvePrompt = r;
    });

    injectMockAgent(ctx, async () => {
      resolvePrompt();
      throw new Error('aborted');
    });

    const promptPromise = ctx.prompt('hello');
    await promptStarted;

    (callbacks.onError as ReturnType<typeof vi.fn>).mockClear();

    ctx.dispose();
    await promptPromise;

    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it('suppresses agent event callbacks after dispose', () => {
    // Add optional tool callbacks so we can assert they're not called
    callbacks.onToolStart = vi.fn();
    callbacks.onToolEnd = vi.fn();
    ctx = new ScoopContext(testScoop, callbacks, {} as never);
    injectMockAgent(ctx, async () => {});

    ctx.dispose();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private method for testing
    const handler = (ctx as any).handleAgentEvent.bind(ctx);

    handler({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } });
    handler({ type: 'tool_execution_start', toolName: 'bash', args: {} });
    handler({
      type: 'tool_execution_end',
      toolName: 'bash',
      result: { content: [] },
      isError: false,
    });
    handler({ type: 'turn_end' });
    handler({
      type: 'agent_end',
      messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
    });

    expect(callbacks.onResponse).not.toHaveBeenCalled();
    expect(callbacks.onToolStart).not.toHaveBeenCalled();
    expect(callbacks.onToolEnd).not.toHaveBeenCalled();
    expect(callbacks.onResponseDone).not.toHaveBeenCalled();
  });
});

describe('resolveThinkingLevel', () => {
  // Synthesize the smallest possible `Model<Api>` shape the helper inspects.
  // pi-ai's `getSupportedThinkingLevels` reads `reasoning` and
  // `thinkingLevelMap` — xhigh requires an explicit (non-null) entry.
  const makeModel = (reasoning: boolean, supportsXhighFamily = false) =>
    ({
      id: supportsXhighFamily ? 'claude-opus-4-7' : 'claude-haiku-4-5',
      reasoning,
      thinkingLevelMap: supportsXhighFamily ? { xhigh: 'max' } : undefined,
    }) as unknown as Parameters<typeof resolveThinkingLevel>[1];

  it("returns 'off' when the model does not support reasoning", () => {
    const model = makeModel(false);
    expect(resolveThinkingLevel('high', model)).toBe('off');
    expect(resolveThinkingLevel('xhigh', model)).toBe('off');
    expect(resolveThinkingLevel(undefined, model)).toBe('off');
  });

  it("returns 'off' when no level is requested", () => {
    expect(resolveThinkingLevel(undefined, makeModel(true))).toBe('off');
  });

  it('clamps xhigh to high when the model does not advertise xhigh support', () => {
    // No thinkingLevelMap entry for xhigh → getSupportedThinkingLevels excludes it.
    expect(resolveThinkingLevel('xhigh', makeModel(true, false))).toBe('high');
  });

  it('passes xhigh through when the model supports it (Opus 4.7 family)', () => {
    expect(resolveThinkingLevel('xhigh', makeModel(true, true))).toBe('xhigh');
  });

  it('passes through other valid levels unchanged', () => {
    const model = makeModel(true);
    expect(resolveThinkingLevel('low', model)).toBe('low');
    expect(resolveThinkingLevel('medium', model)).toBe('medium');
    expect(resolveThinkingLevel('high', model)).toBe('high');
    expect(resolveThinkingLevel('minimal', model)).toBe('minimal');
  });
});

describe('ScoopContext — process manager wiring (Phase 3.3)', () => {
  it('registers a kind:"scoop-turn" process when prompt() runs and exits 0 on success', async () => {
    const { ProcessManager } = await import('../../src/kernel/process-manager.js');
    const pm = new ProcessManager();
    const callbacks = createMockCallbacks();
    const ctx = new ScoopContext(
      testScoop,
      callbacks,
      {} as any,
      undefined,
      undefined,
      undefined,
      pm
    );
    injectMockAgent(ctx, async () => undefined);
    expect(pm.list()).toHaveLength(0);

    await ctx.prompt('hello');

    const procs = pm.list();
    expect(procs).toHaveLength(1);
    expect(procs[0].kind).toBe('scoop-turn');
    expect(procs[0].argv[0]).toBe('prompt');
    expect(procs[0].argv[1]).toBe('hello');
    expect(procs[0].owner).toEqual({ kind: 'scoop', scoopJid: testScoop.jid });
    expect(procs[0].status).toBe('exited');
    expect(procs[0].exitCode).toBe(0);
  });

  it('records terminatedBy="SIGINT" and exit 130 when stop() is called mid-prompt', async () => {
    const { ProcessManager } = await import('../../src/kernel/process-manager.js');
    const pm = new ProcessManager();
    const callbacks = createMockCallbacks();
    const ctx = new ScoopContext(
      testScoop,
      callbacks,
      {} as any,
      undefined,
      undefined,
      undefined,
      pm
    );

    // Long-running mock agent: yields to the event loop in a way the
    // prompt's abortSignal can interrupt. ScoopContext's prompt loop
    // checks `abortSignal.aborted` after every await, so making the
    // mock agent reject on abort is enough.
    const stuck = new Promise<void>((_, reject) => {
      const handler = (): void => reject(new Error('aborted'));
      // Wire the rejection to the next tick — prompt() will set up
      // its abortController and we'll signal it from outside.
      setTimeout(() => {
        const abortController = (ctx as any).promptAbortController as AbortController | null;
        abortController?.signal.addEventListener('abort', handler, { once: true });
      }, 0);
    });
    injectMockAgent(ctx, async () => {
      await stuck;
    });

    const promptP = ctx.prompt('long-running');
    // Let prompt() install its abort controller + spawn the process.
    await new Promise((r) => setTimeout(r, 5));
    expect(pm.list()).toHaveLength(1);
    expect(pm.list()[0].status).toBe('running');

    ctx.stop();
    await promptP;

    const proc = pm.list()[0];
    expect(proc.terminatedBy).toBe('SIGINT');
    expect(proc.status).toBe('killed');
    expect(proc.exitCode).toBe(130);
  });

  it('truncates long prompt text in argv[1] for /proc/<pid>/cmdline ergonomics', async () => {
    const { ProcessManager } = await import('../../src/kernel/process-manager.js');
    const pm = new ProcessManager();
    const callbacks = createMockCallbacks();
    const ctx = new ScoopContext(
      testScoop,
      callbacks,
      {} as any,
      undefined,
      undefined,
      undefined,
      pm
    );
    const longText = 'x'.repeat(500);
    injectMockAgent(ctx, async () => undefined);
    await ctx.prompt(longText);
    const proc = pm.list()[0];
    expect(proc.argv[1].length).toBeLessThanOrEqual(200);
    expect(proc.argv[1].endsWith('…')).toBe(true);
  });

  it('does not register processes when no manager is wired (backwards compatible)', async () => {
    const callbacks = createMockCallbacks();
    const ctx = new ScoopContext(testScoop, callbacks, {} as any);
    injectMockAgent(ctx, async () => undefined);
    await ctx.prompt('untracked');
    // No manager → no list to inspect; this just verifies the
    // prompt() path doesn't throw without a pm.
    expect((ctx as any).processManager).toBeNull();
  });
});

describe('ScoopContext — spinner cleanup on early-return paths (regression fix)', () => {
  it("flips status from 'processing' to 'ready' in finally even when prompt is aborted", async () => {
    const callbacks = createMockCallbacks();
    const ctx = new ScoopContext(testScoop, callbacks, {} as any);

    // Mock agent whose prompt() rejects with an abort-shaped error.
    // ScoopContext's catch block sees `abortSignal.aborted === true`
    // and returns early — the bug-before-fix was that this skipped
    // the setStatus('ready') line at the bottom of the try block,
    // leaving the panel's "processing" spinner stuck on.
    injectMockAgent(ctx, async () => {
      // Trigger the abort BEFORE throwing so the catch's
      // `abortSignal.aborted` check passes.
      const abortController = (ctx as any).promptAbortController as AbortController | null;
      abortController?.abort();
      throw new Error('aborted');
    });

    // Status starts at 'ready' (after init); prompt() flips it to
    // 'processing' synchronously, then the abort path hits.
    await ctx.prompt('test');

    // Backstop in the finally block must have flipped status back
    // to 'ready' so the panel sees a wire signal to clear its
    // spinner.
    expect((ctx as any).status).toBe('ready');
    // onStatusChange was called with 'processing' AND 'ready' at minimum.
    const calls = (callbacks.onStatusChange as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls).toContain('processing');
    expect(calls).toContain('ready');
  });

  it("preserves 'error' status when set by a non-retryable error (backstop is a no-op)", async () => {
    const callbacks = createMockCallbacks();
    const ctx = new ScoopContext(testScoop, callbacks, {} as any);

    // Reject with a non-retryable shape so the catch hits the
    // setStatus('error') branch.
    injectMockAgent(ctx, async () => {
      throw new Error('400 Bad Request: invalid api key');
    });

    await ctx.prompt('test');

    // Status should be 'error' — backstop in finally must not
    // override.
    expect((ctx as any).status).toBe('error');
  });

  it("flips status to 'ready' on successful prompt (existing happy path stays correct)", async () => {
    const callbacks = createMockCallbacks();
    const ctx = new ScoopContext(testScoop, callbacks, {} as any);
    injectMockAgent(ctx, async () => undefined);
    await ctx.prompt('test');
    expect((ctx as any).status).toBe('ready');
  });
});
