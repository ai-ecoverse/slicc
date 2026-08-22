// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import type { BootStageLogger } from '../../../src/ui/boot/types.js';
import type { ChatMessage } from '../../../src/ui/types.js';
import { LEADER_LOCAL_MODEL_STATE_CHANGED_EVENT } from '../../../src/ui/wc/leader-model-events.js';
import {
  buildFollowerOptions,
  installLeaderModelCatalogRefresh,
  installLeaderModelStateBridge,
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
        refs: {
          composerMeta,
          switcher,
          dock: document.createElement('div'),
          overlaySurfaces: new Set(),
        },
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
    expect((switcher as HTMLElement & { connection?: string }).connection).toBe('disconnected');
    options.onConnectionChange?.(true);
    expect((switcher as HTMLElement & { connection?: string }).connection).toBe('connected');
    options.onConnectionChange?.(false);
    expect((switcher as HTMLElement & { connection?: string }).connection).toBe('disconnected');

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

    expect(selectModel).toHaveBeenCalledWith('anthropic:claude-sonnet-4-6', 'cone');
    expect(setThinkingLevel).toHaveBeenCalledWith('cone', 'xhigh', 'max');
    expect(selectScoop).toHaveBeenCalledWith('research');
  });

  it('re-orders the strip when this leader-capable follower selects a cone (Codex P2)', () => {
    // Third follower wiring path, after wc-live (leader) and wc-follower: a
    // standalone float that joined someone else's tray. It publishes through
    // the same `toFollowerSwitcherScoops`, so it needs the same selection.
    const composerMeta = document.createElement('div');
    const switcher = document.createElement('div') as unknown as HTMLElement & {
      scoops: Array<{ key: string }>;
    };
    const options = buildFollowerOptions(
      {
        refs: {
          composerMeta,
          switcher,
          dock: document.createElement('div'),
          overlaySurfaces: new Set(),
        },
        browser: {},
        client: { sendSetFollowerForwarding: vi.fn() },
        window: { localStorage: { getItem: vi.fn(() => null) } },
        getController: () => null,
        addSprinkle: vi.fn(),
        removeSprinkle: vi.fn(),
      } as never,
      'https://tray.example/join/token',
      () => ({ selectScoop: vi.fn() }) as never
    );

    options.onScoopsList?.(
      [
        { jid: 'cone-a', name: 'cone', isCone: true },
        { jid: 'cone-b', name: 'research', isCone: true },
        { jid: 'scoop-a', name: 'helper-a', isCone: false, parentId: 'cone-a' },
        { jid: 'scoop-b', name: 'helper-b', isCone: false, parentId: 'cone-b' },
      ] as never,
      'cone-a'
    );
    const orderFor = () => switcher.scoops.map((entry) => entry.key);
    expect(orderFor()).toEqual(['cone-a', 'cone-b', 'scoop-a', 'scoop-b']);

    switcher.dispatchEvent(new CustomEvent('slicc-scoop-select', { detail: { key: 'cone-b' } }));
    expect(orderFor()).toEqual(['cone-a', 'cone-b', 'scoop-b', 'scoop-a']);
  });

  it('preserves the viewed scoop across transient disconnect and falls back when it disappears', () => {
    const composerMeta = document.createElement('div');
    const switcher = document.createElement('div') as HTMLElement & { scoops?: unknown[] };
    const options = buildFollowerOptions(
      {
        refs: {
          composerMeta,
          switcher,
          dock: document.createElement('div'),
          overlaySurfaces: new Set(),
        },
        browser: {},
        client: { sendSetFollowerForwarding: vi.fn() },
        window: { localStorage: { getItem: vi.fn(() => null) } },
        getController: () => null,
        addSprinkle: vi.fn(),
        removeSprinkle: vi.fn(),
      } as never,
      'https://tray.example/join/token',
      () => ({ selectScoop: vi.fn() }) as never
    );

    options.onScoopsList?.(
      [
        { jid: 'cone', name: 'cone', isCone: true },
        { jid: 'research', name: 'research', isCone: false },
      ] as never,
      'cone'
    );
    switcher.dispatchEvent(new CustomEvent('slicc-scoop-select', { detail: { key: 'research' } }));
    options.onConnectionChange?.(false);
    expect(options.getSelectedScoopJid?.()).toBe('research');

    options.onScoopsList?.([{ jid: 'cone', name: 'cone', isCone: true }] as never, 'cone');
    expect(options.getSelectedScoopJid?.()).toBe('cone');
    expect(switcher.getAttribute('active')).toBe('cone');
  });
});

describe('role-switch follower status', () => {
  it('re-establishes snapshot busy state and ignores statuses for another scoop', () => {
    const switcher = document.createElement('div') as HTMLElement & { scoops?: unknown[] };
    const controller = { loadMessages: vi.fn(), setProcessing: vi.fn() };
    const options = buildFollowerOptions(
      {
        refs: {
          composerMeta: document.createElement('div'),
          switcher,
          dock: document.createElement('div'),
          overlaySurfaces: new Set(),
        },
        browser: {},
        client: { sendSetFollowerForwarding: vi.fn() },
        window: { localStorage: { getItem: vi.fn(() => null) } },
        getController: () => controller,
        addSprinkle: vi.fn(),
        removeSprinkle: vi.fn(),
      } as never,
      'https://tray.example/join/token',
      () => null
    );
    const streaming: ChatMessage[] = [
      { id: 'a1', role: 'assistant', content: 'working', timestamp: 1, isStreaming: true },
    ];

    options.onSnapshot(streaming, 'research');
    expect(options.getSelectedScoopJid?.()).toBe('research');
    expect(controller.loadMessages).toHaveBeenCalledWith(streaming);
    expect(controller.setProcessing).toHaveBeenLastCalledWith(true);

    controller.setProcessing.mockClear();
    options.onStatus('ready', 'cone');
    expect(controller.setProcessing).not.toHaveBeenCalled();

    options.onStatus('ready', 'research');
    expect(controller.setProcessing).toHaveBeenLastCalledWith(false);

    options.onStatus('processing');
    expect(controller.setProcessing).toHaveBeenLastCalledWith(true);
  });
});

describe('leader-local model state bridge', () => {
  it('broadcasts local model and post-ack thinking changes but not follower model picks', () => {
    const windowTarget = new EventTarget();
    const broadcastModelState = vi.fn();
    installLeaderModelStateBridge({
      window: windowTarget as never,
      getSync: () => ({ broadcastModelState }),
    });

    windowTarget.dispatchEvent(new Event(LEADER_LOCAL_MODEL_STATE_CHANGED_EVENT));
    windowTarget.dispatchEvent(new CustomEvent('model-change'));
    windowTarget.dispatchEvent(new CustomEvent('model-change', { detail: { source: 'follower' } }));
    expect(broadcastModelState).toHaveBeenCalledTimes(2);
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
