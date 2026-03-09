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
