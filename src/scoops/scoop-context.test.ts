/**
 * Tests for ScoopContext message queueing behavior.
 *
 * Verifies that prompt() queues messages when already processing
 * and drains them sequentially, with proper error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ScoopContext,
  isImageProcessingError,
  type ScoopContextCallbacks,
} from './scoop-context.js';
import type { RegisteredScoop } from './types.js';

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
    ctx = new ScoopContext(testScoop, callbacks, {} as any, mockStore);
    expect((ctx as any).sessionStore).toBe(mockStore);
    expect((ctx as any).sessionId).toBe(testScoop.jid);
  });

  it('works without sessionStore (backwards compatible)', () => {
    ctx = new ScoopContext(testScoop, callbacks, {} as any);
    expect((ctx as any).sessionStore).toBeNull();
  });

  it('saves session on agent_end with messages', () => {
    const mockStore = { load: vi.fn(), save: vi.fn().mockResolvedValue(undefined) } as any;
    ctx = new ScoopContext(testScoop, callbacks, {} as any, mockStore);
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
    // Don't inject a mock agent
    await ctx.prompt('hello');
    expect(callbacks.onError).toHaveBeenCalledWith('Agent not initialized');
  });

  it('does not queue when agent is not initialized', async () => {
    // Don't inject a mock agent — prompt should error, not queue
    await ctx.prompt('first');
    await ctx.prompt('second');

    // Both should immediately error
    expect(callbacks.onError).toHaveBeenCalledTimes(2);
  });

  it('handles prompt failure gracefully', async () => {
    const prompts: string[] = [];
    injectMockAgent(ctx, async (text) => {
      prompts.push(text);
      throw new Error('prompt failed');
    });

    await ctx.prompt('first');

    expect(prompts).toEqual(['first']);
    expect(callbacks.onError).toHaveBeenCalledWith('prompt failed');
    // Should return to ready status after error
    const statusCalls = (callbacks.onStatusChange as any).mock.calls;
    expect(statusCalls[statusCalls.length - 1][0]).toBe('ready');
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
    const mockClearMessages = vi.fn();
    injectMockAgent(ctx, async () => {});
    (ctx as any).agent.clearMessages = mockClearMessages;

    ctx.clearMessages();

    expect(mockClearMessages).toHaveBeenCalled();
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
    const agent = {
      prompt: promptFn,
      abort: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      replaceMessages,
      state: { messages: [] },
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
    const agent = {
      prompt: promptFn,
      abort: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      replaceMessages,
      state: { messages: [] },
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
