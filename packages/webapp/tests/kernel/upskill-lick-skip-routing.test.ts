import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultLickEventHandler } from '../../src/kernel/host.js';

const skip = vi.hoisted(() => ({
  shouldSkipNavigateUpskill: vi.fn(async (_event?: unknown, _getConeFs?: unknown) => false),
}));

vi.mock('../../src/scoops/upskill-lick-skip.js', () => ({
  shouldSkipNavigateUpskill: (event: unknown, getConeFs: unknown) =>
    skip.shouldSkipNavigateUpskill(event, getConeFs),
}));

function navigateUpskill() {
  return {
    type: 'navigate' as const,
    timestamp: 't',
    navigateUrl: 'https://www.sliccy.com/use-cases/creative?cb=1',
    body: {
      verb: 'upskill',
      target: 'https://github.com/ai-ecoverse/skills',
      path: 'skills/firefly',
    },
  };
}

const cone = {
  jid: 'cone-jid',
  name: 'Cone',
  folder: 'cone',
  isCone: true,
  parentJid: null,
  type: 'cone',
  requiresTrigger: false,
  assistantLabel: 'sliccy',
  addedAt: '2026-01-01T00:00:00.000Z',
} as const;

describe('navigate·upskill card skip at route time', () => {
  beforeEach(() => {
    skip.shouldSkipNavigateUpskill.mockReset();
    skip.shouldSkipNavigateUpskill.mockResolvedValue(false);
  });

  it('does not raise a card when the skip check returns true', async () => {
    skip.shouldSkipNavigateUpskill.mockResolvedValue(true);
    const handleMessage = vi.fn(async () => undefined);
    const registerNavigateLick = vi.fn(() => 'lick-should-not-mint');
    const ctx = {
      orchestrator: {
        getScoops: () => [cone],
        getDefaultConeFs: () => null,
        registerNavigateLick,
        handleMessage,
      } as never,
      lickManager: {} as never,
      log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };

    defaultLickEventHandler(navigateUpskill(), ctx);
    await vi.waitFor(() => {
      expect(skip.shouldSkipNavigateUpskill).toHaveBeenCalled();
    });
    expect(registerNavigateLick).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('raises a card when the advertised sha differs', async () => {
    const handleMessage = vi.fn(async () => undefined);
    const registerNavigateLick = vi.fn(() => 'lick-1');
    const ctx = {
      orchestrator: {
        getScoops: () => [cone],
        getDefaultConeFs: () => null,
        registerNavigateLick,
        handleMessage,
      } as never,
      lickManager: {} as never,
      log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };

    defaultLickEventHandler(navigateUpskill(), ctx);
    await vi.waitFor(() => {
      expect(handleMessage).toHaveBeenCalled();
    });
    expect(registerNavigateLick).toHaveBeenCalled();
    expect(handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'navigate', lickId: 'lick-1' })
    );
  });

  it('does not skip handoff licks', async () => {
    const handleMessage = vi.fn(async () => undefined);
    const registerNavigateLick = vi.fn(() => 'lick-handoff');
    const ctx = {
      orchestrator: {
        getScoops: () => [cone],
        getDefaultConeFs: () => null,
        registerNavigateLick,
        handleMessage,
      } as never,
      lickManager: {} as never,
      log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };

    defaultLickEventHandler(
      {
        type: 'navigate',
        timestamp: 't',
        navigateUrl: 'https://example.com',
        body: { verb: 'handoff', target: 'https://example.com', instruction: 'do x' },
      },
      ctx
    );
    await vi.waitFor(() => {
      expect(handleMessage).toHaveBeenCalled();
    });
    expect(registerNavigateLick).toHaveBeenCalled();
  });
});
