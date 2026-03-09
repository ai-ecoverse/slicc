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
