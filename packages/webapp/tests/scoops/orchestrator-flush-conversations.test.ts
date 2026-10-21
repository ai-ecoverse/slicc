import { describe, expect, it, vi } from 'vitest';
import { Orchestrator } from '../../src/scoops/orchestrator.js';

describe('Orchestrator.flushConversations', () => {
  it('flushes every live context and waits for all of them', async () => {
    let finishSlow!: () => void;
    const slow = new Promise<void>((resolve) => {
      finishSlow = resolve;
    });
    const contexts = new Map([
      ['a', { flushConversation: vi.fn(() => slow.then(() => true)) }],
      ['b', { flushConversation: vi.fn(async () => true) }],
      ['c', { flushConversation: vi.fn(async () => Promise.reject(new Error('quota'))) }],
    ]);
    const self = { lifecycle: { getContexts: () => contexts } };
    let done = false;
    let result: boolean | undefined;
    const flushing = Orchestrator.prototype.flushConversations.call(self as never).then((ok) => {
      done = true;
      result = ok;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const context of contexts.values()) expect(context.flushConversation).toHaveBeenCalled();
    expect(done).toBe(false);
    finishSlow();
    await flushing;
    expect(done).toBe(true);

    expect(result).toBe(false);
  });

  it('confirms only when every write landed', async () => {
    const ok = {
      lifecycle: { getContexts: () => new Map([['a', { flushConversation: async () => true }]]) },
    };
    expect(await Orchestrator.prototype.flushConversations.call(ok as never)).toBe(true);
    const refused = {
      lifecycle: { getContexts: () => new Map([['a', { flushConversation: async () => false }]]) },
    };
    expect(await Orchestrator.prototype.flushConversations.call(refused as never)).toBe(false);
  });
});
