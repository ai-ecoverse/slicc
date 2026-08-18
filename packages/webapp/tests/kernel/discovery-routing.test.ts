import { describe, expect, it, vi } from 'vitest';
import { defaultLickEventHandler } from '../../src/kernel/host.js';

function scoop(allowedCommands: string[]) {
  return {
    jid: 'scoop-jid',
    name: 'restricted',
    folder: 'restricted',
    isCone: false,
    type: 'scoop',
    requiresTrigger: false,
    assistantLabel: 'restricted',
    addedAt: 't',
    config: { allowedCommands },
  } as const;
}

describe('discovery lick routing', () => {
  it('drops discovery for a non-browsing sub-agent before minting a lick', () => {
    const registerDiscoveryLick = vi.fn(() => 'lick-1');
    const handleMessage = vi.fn();
    defaultLickEventHandler(
      {
        type: 'discovery',
        targetScoop: 'restricted',
        discoveryOrigin: 'https://example.com',
        discoveryKind: 'llms-txt',
        discoveryUrl: 'https://example.com/llms.txt',
        discoverySource: 'live-navigation',
        timestamp: 't',
        body: {},
      },
      {
        orchestrator: {
          getScoops: () => [scoop(['git', 'grep'])],
          registerDiscoveryLick,
          handleMessage,
        } as never,
        lickManager: {} as never,
        log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      }
    );
    expect(registerDiscoveryLick).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('routes discovery to a browsing-capable sub-agent', () => {
    const registerDiscoveryLick = vi.fn(() => 'lick-1');
    const handleMessage = vi.fn(async () => undefined);
    defaultLickEventHandler(
      {
        type: 'discovery',
        targetScoop: 'restricted',
        discoveryOrigin: 'https://example.com',
        discoveryKind: 'llms-txt',
        discoveryUrl: 'https://example.com/llms.txt',
        discoverySource: 'live-navigation',
        timestamp: 't',
        body: {},
      },
      {
        orchestrator: {
          getScoops: () => [scoop(['curl'])],
          registerDiscoveryLick,
          handleMessage,
        } as never,
        lickManager: {} as never,
        log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      }
    );
    expect(registerDiscoveryLick).toHaveBeenCalledOnce();
    expect(handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatJid: 'scoop-jid', lickId: 'lick-1' })
    );
  });
});
