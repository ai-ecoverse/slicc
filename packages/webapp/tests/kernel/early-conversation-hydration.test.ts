import { describe, expect, it, vi } from 'vitest';
import { wireEarlyConversationHydration } from '../../src/kernel/early-conversation-hydration.js';

describe('wireEarlyConversationHydration', () => {
  it('hydrates from the conversation store and then publishes, in that order', async () => {
    const order: string[] = [];
    let hook: (() => Promise<void>) | undefined;
    const orchestrator = {
      setOnConversationsReady(next: () => Promise<void>) {
        hook = next;
      },
    };
    const bridge = {
      hydrateBuffersFromRecords: vi.fn(async () => {
        order.push('hydrate');
      }),
      publishHydratedTranscripts: vi.fn(() => {
        order.push('publish');
      }),
    };

    wireEarlyConversationHydration(orchestrator, bridge);
    await hook?.();

    expect(order).toEqual(['hydrate', 'publish']);
  });

  it('swallows a hydrate failure so boot can still publish on the later pass', async () => {
    const warn = vi.fn();
    let hook: (() => Promise<void>) | undefined;
    const publish = vi.fn();
    wireEarlyConversationHydration(
      {
        setOnConversationsReady(next: () => Promise<void>) {
          hook = next;
        },
      },
      {
        hydrateBuffersFromRecords: vi.fn(async () => {
          throw new Error('idb locked');
        }),
        publishHydratedTranscripts: publish,
      },
      warn
    );

    await expect(hook?.()).resolves.toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });
});
