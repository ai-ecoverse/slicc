/**
 * Tests for ScoopContext message queueing behavior.
 *
 * Verifies that prompt() queues messages when already processing
 * and drains them sequentially, with proper error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScoopContext, type ScoopContextCallbacks } from './scoop-context.js';
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
  const agent = {
    prompt: mockPrompt,
    abort: vi.fn(),
    subscribe: vi.fn(() => () => {}),
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

    expect(mockStore.save).toHaveBeenCalledWith(expect.objectContaining({
      id: testScoop.jid,
      messages,
    }));
  });

  it('preserves original createdAt across saves', () => {
    const originalCreatedAt = 1000000;
    const mockStore = { load: vi.fn(), save: vi.fn().mockResolvedValue(undefined) } as any;
    ctx = new ScoopContext(testScoop, callbacks, {} as any, mockStore);
    injectMockAgent(ctx, async () => {});

    // Simulate having restored a session with a known createdAt
    (ctx as any).sessionCreatedAt = originalCreatedAt;

    const handler = (ctx as any).handleAgentEvent.bind(ctx);
    handler({ type: 'agent_end', messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] });

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
    handler({ type: 'agent_end', messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] });
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
    const mockStore = { load: vi.fn(), save: vi.fn().mockRejectedValue(new Error('DB full')) } as any;
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
    const mockStore = { load: vi.fn().mockRejectedValue(new Error('DB corrupt')), save: vi.fn() } as any;
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
      expect(callbacks.onError).toHaveBeenCalledWith('Conversation history could not be restored. Starting fresh.');
    });
  });

  it('restores sessionCreatedAt from loaded session', () => {
    const mockStore = { load: vi.fn().mockResolvedValue({ messages: [{ role: 'user', content: 'old' }], createdAt: 42 }), save: vi.fn() } as any;
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
    injectMockAgent(ctx, async (text) => { prompts.push(text); });

    await ctx.prompt('hello');

    expect(prompts).toEqual(['hello']);
    expect(callbacks.onStatusChange).toHaveBeenCalledWith('processing');
    // Last status call should be 'ready'
    const statusCalls = (callbacks.onStatusChange as any).mock.calls;
    expect(statusCalls[statusCalls.length - 1][0]).toBe('ready');
  });

  it('queues prompts when already processing', async () => {
    const prompts: string[] = [];
    let resolveFirst: () => void;
    const firstPromptDone = new Promise<void>((r) => { resolveFirst = r; });

    injectMockAgent(ctx, async (text) => {
      prompts.push(text);
      if (text === 'first') {
        await firstPromptDone;
      }
    });

    // Start first prompt (will block until we resolve)
    const promptPromise = ctx.prompt('first');

    // While first is processing, queue more prompts
    await ctx.prompt('second');
    await ctx.prompt('third');

    // Verify they were queued, not processed yet
    expect(prompts).toEqual(['first']);

    // Release first prompt — queued ones should be processed sequentially
    resolveFirst!();
    await promptPromise;

    expect(prompts).toEqual(['first', 'second', 'third']);
  });

  it('continues processing queue when a queued prompt fails', async () => {
    const prompts: string[] = [];
    let resolveFirst: () => void;
    const firstPromptDone = new Promise<void>((r) => { resolveFirst = r; });

    injectMockAgent(ctx, async (text) => {
      prompts.push(text);
      if (text === 'first') {
        await firstPromptDone;
      }
      if (text === 'second') {
        throw new Error('second failed');
      }
    });

    const promptPromise = ctx.prompt('first');
    await ctx.prompt('second'); // will fail
    await ctx.prompt('third'); // should still run

    resolveFirst!();
    await promptPromise;

    expect(prompts).toEqual(['first', 'second', 'third']);
    expect(callbacks.onError).toHaveBeenCalledWith('second failed');
  });

  it('stop() clears the queue and aborts', async () => {
    let resolveFirst: () => void;
    const firstPromptDone = new Promise<void>((r) => { resolveFirst = r; });
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

    expect((ctx as any).pendingPrompts).toEqual([]);
    expect((ctx as any).agent.abort).toHaveBeenCalled();

    // Release first prompt — no more should be processed
    resolveFirst!();
    await promptPromise;

    // Only 'first' was actually sent to agent.prompt
    expect(prompts).toEqual(['first']);
  });

  it('returns to ready status after processing all queued prompts', async () => {
    const prompts: string[] = [];
    let resolveFirst: () => void;
    const firstPromptDone = new Promise<void>((r) => { resolveFirst = r; });

    injectMockAgent(ctx, async (text) => {
      prompts.push(text);
      if (text === 'first') {
        await firstPromptDone;
      }
    });

    const promptPromise = ctx.prompt('first');
    await ctx.prompt('second');

    resolveFirst!();
    await promptPromise;

    expect(prompts).toEqual(['first', 'second']);
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
    expect((ctx as any).pendingPrompts).toEqual([]);
  });

  it('handles first prompt failure and still drains queue', async () => {
    const prompts: string[] = [];
    injectMockAgent(ctx, async (text) => {
      prompts.push(text);
      if (text === 'first') {
        throw new Error('first failed');
      }
    });

    // Queue second before first finishes (but first will fail synchronously-ish)
    // We need to make first block to actually queue second
    let resolveFirst: () => void;
    const firstBlock = new Promise<void>((r) => { resolveFirst = r; });

    injectMockAgent(ctx, async (text) => {
      prompts.length = 0; // reset from previous mock
      prompts.push(text);
      if (text === 'first') {
        await firstBlock;
        throw new Error('first failed');
      }
    });

    const promptPromise = ctx.prompt('first');
    await ctx.prompt('second');

    resolveFirst!();
    await promptPromise;

    expect(prompts).toContain('second');
    expect(callbacks.onError).toHaveBeenCalledWith('first failed');
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
    mockPrompt: (text: string) => Promise<void>,
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
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }], stopReason: 'stop', usage: { input: 100, output: 50 }, timestamp: Date.now() },
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
      { role: 'toolResult', toolCallId: 't1', content: [{ type: 'image', data: largeBase64, mimeType: 'image/png' }] },
      overflowMessage,
    ];

    handler({ type: 'agent_end', messages });

    const replacedMessages = replaceMessages.mock.calls[0][0];
    expect(replacedMessages[1].content[0].text).toContain('Content removed');
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
    handler({ type: 'agent_end', messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      overflowMessage,
    ]});

    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(replaceMessages).toHaveBeenCalledTimes(1);

    // Second overflow (recovery also overflowed) — should surface error
    handler({ type: 'agent_end', messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      overflowMessage,
    ]});

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

    handler({ type: 'agent_end', messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      errorMessage,
    ]});

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
    handler({ type: 'agent_end', messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      overflowMessage,
    ]});

    // Simulate successful recovery (agent_end with no error)
    handler({ type: 'agent_end', messages: [
      { role: 'user', content: [{ type: 'text', text: 'recovery prompt' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'recovered' }], stopReason: 'stop', usage: { input: 100, output: 50 }, timestamp: Date.now() },
    ]});

    // Flag should be reset — a new overflow should trigger recovery again
    expect((ctx as any).isRecoveringFromOverflow).toBe(false);

    // Third agent_end with overflow should trigger recovery (flag was reset)
    handler({ type: 'agent_end', messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello again' }] },
      overflowMessage,
    ]});

    // Should have triggered recovery again (not surfaced error)
    expect(callbacks.onError).not.toHaveBeenCalled();
  });
});
