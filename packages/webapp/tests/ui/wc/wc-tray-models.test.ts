// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import type { BootStageLogger } from '../../../src/ui/boot/types.js';
import {
  buildFollowerOptions,
  installLeaderModelCatalogRefresh,
} from '../../../src/ui/wc/wc-tray.js';

describe('role-switch follower model controls', () => {
  it('wires leader model state and forwards remote model, thinking, and scoop selections', () => {
    const composerMeta = document.createElement('div') as HTMLElement & {
      model?: string;
      models?: Array<{ id: string; name: string; provider: string }>;
    };
    const switcher = document.createElement('div') as HTMLElement & { scoops?: unknown[] };
    const selectModel = vi.fn();
    const setThinkingLevel = vi.fn();
    const selectScoop = vi.fn();
    const sync = { selectModel, setThinkingLevel, selectScoop };
    const options = buildFollowerOptions(
      {
        refs: { composerMeta, switcher },
        browser: {},
        client: { sendSetFollowerForwarding: vi.fn() },
        window: { localStorage: { getItem: vi.fn(() => null) } },
        getController: () => null,
        addSprinkle: vi.fn(),
        removeSprinkle: vi.fn(),
      } as never,
      'https://tray.example/join/token',
      () => sync as never
    );

    options.onModelsList?.([
      {
        providerName: 'Anthropic',
        modelId: 'anthropic:claude-sonnet-4-6',
        modelName: 'Claude Sonnet 4.6',
        reasoning: true,
      },
    ]);
    options.onModelState?.({
      activeModelId: 'anthropic:claude-sonnet-4-6',
      scoopJid: 'cone',
      thinkingLevel: 'medium',
    });
    options.onScoopsList?.([], 'cone');

    expect(composerMeta.models).toEqual([
      {
        id: 'anthropic:claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        provider: 'Anthropic',
      },
    ]);
    expect(composerMeta.style.display).toBe('');
    expect(composerMeta.model).toBe('Claude Sonnet 4.6');
    expect(composerMeta.getAttribute('thinking')).toBe('medium');

    composerMeta.dispatchEvent(
      new CustomEvent('model-change', { detail: { id: 'anthropic:claude-sonnet-4-6' } })
    );
    composerMeta.dispatchEvent(new CustomEvent('thinking-change', { detail: { thinking: 'max' } }));
    switcher.dispatchEvent(new CustomEvent('slicc-scoop-select', { detail: { key: 'research' } }));

    expect(selectModel).toHaveBeenCalledWith('anthropic:claude-sonnet-4-6');
    expect(setThinkingLevel).toHaveBeenCalledWith('cone', 'xhigh', 'max');
    expect(selectScoop).toHaveBeenCalledWith('research');
  });
});

describe('leader tray model catalog refresh', () => {
  it('broadcasts on accounts-changed and again when a dynamic catalog lands', async () => {
    const windowTarget = new EventTarget();
    const broadcastModelCatalog = vi.fn();
    let resolveRefresh!: (refreshed: boolean) => void;
    const refreshDynamicCatalogs = vi.fn(
      () => new Promise<boolean>((resolve) => (resolveRefresh = resolve))
    );
    installLeaderModelCatalogRefresh({
      window: windowTarget as never,
      getSync: () => ({ broadcastModelCatalog }),
      refreshDynamicCatalogs,
      log: { warn: vi.fn() } as unknown as BootStageLogger,
    });

    windowTarget.dispatchEvent(new Event('slicc:accounts-changed'));
    expect(broadcastModelCatalog).toHaveBeenCalledOnce();
    expect(refreshDynamicCatalogs).toHaveBeenCalledOnce();

    resolveRefresh(true);
    await vi.waitFor(() => expect(broadcastModelCatalog).toHaveBeenCalledTimes(2));
  });

  it('does not emit a second broadcast when no dynamic catalog exists', async () => {
    const windowTarget = new EventTarget();
    const broadcastModelCatalog = vi.fn();
    installLeaderModelCatalogRefresh({
      window: windowTarget as never,
      getSync: () => ({ broadcastModelCatalog }),
      refreshDynamicCatalogs: async () => false,
      log: { warn: vi.fn() } as unknown as BootStageLogger,
    });

    windowTarget.dispatchEvent(new Event('slicc:accounts-changed'));
    await Promise.resolve();
    expect(broadcastModelCatalog).toHaveBeenCalledOnce();
  });

  it('keeps the immediate catalog and logs when dynamic refresh fails', async () => {
    const windowTarget = new EventTarget();
    const broadcastModelCatalog = vi.fn();
    const warn = vi.fn();
    installLeaderModelCatalogRefresh({
      window: windowTarget as never,
      getSync: () => ({ broadcastModelCatalog }),
      refreshDynamicCatalogs: async () => {
        throw new Error('catalog unavailable');
      },
      log: { warn } as unknown as BootStageLogger,
    });

    windowTarget.dispatchEvent(new Event('slicc:accounts-changed'));

    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    expect(broadcastModelCatalog).toHaveBeenCalledOnce();
  });

  it('bounds a hung dynamic catalog refresh', async () => {
    vi.useFakeTimers();
    try {
      const windowTarget = new EventTarget();
      const broadcastModelCatalog = vi.fn();
      const warn = vi.fn();
      installLeaderModelCatalogRefresh({
        window: windowTarget as never,
        getSync: () => ({ broadcastModelCatalog }),
        refreshDynamicCatalogs: () => new Promise<boolean>(() => {}),
        refreshTimeoutMs: 25,
        log: { warn } as unknown as BootStageLogger,
      });

      windowTarget.dispatchEvent(new Event('slicc:accounts-changed'));
      await vi.advanceTimersByTimeAsync(25);

      expect(broadcastModelCatalog).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        'dynamic model catalog refresh failed',
        expect.objectContaining({ message: 'dynamic model catalog refresh timed out' })
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
