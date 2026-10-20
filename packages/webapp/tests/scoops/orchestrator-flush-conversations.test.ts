/**
 * `Orchestrator.flushConversations` is the kernel's durability barrier for
 * seven's in-place upgrade (slicc#4051): every live context's conversation is
 * written before the page lets the exporter read, and one failing context
 * doesn't stop the others.
 */
import { describe, expect, it, vi } from 'vitest';
import { Orchestrator } from '../../src/scoops/orchestrator.js';

describe('Orchestrator.flushConversations', () => {
  it('flushes every live context and waits for all of them', async () => {
    let finishSlow!: () => void;
    const slow = new Promise<void>((resolve) => {
      finishSlow = resolve;
    });
    const contexts = new Map([
      ['a', { flushConversation: vi.fn(() => slow) }],
      ['b', { flushConversation: vi.fn(async () => {}) }],
      ['c', { flushConversation: vi.fn(async () => Promise.reject(new Error('quota'))) }],
    ]);
    const self = { lifecycle: { getContexts: () => contexts } };
    let done = false;
    const flushing = Orchestrator.prototype.flushConversations.call(self as never).then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const context of contexts.values()) expect(context.flushConversation).toHaveBeenCalled();
    expect(done).toBe(false);
    finishSlow();
    await flushing;
    expect(done).toBe(true);
  });
});
