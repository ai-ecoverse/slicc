// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import type { BootStageLogger } from '../../../src/ui/boot/types.js';
import type { ChatMessage } from '../../../src/ui/types.js';
import {
  LEADER_LOCAL_MODEL_STATE_CHANGED_EVENT,
  LEADER_MODEL_CATALOG_CHANGED_EVENT,
} from '../../../src/ui/wc/leader-model-events.js';
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
    const { options } = buildFollowerOptions(
      {
        refs: {
          composerMeta,
          switcher,
          composer: document.createElement('div'),
          inputCard: document.createElement('div'),
          dock: document.createElement('div'),
          overlaySurfaces: new Set(),
        },
        browser: {},
        client: { sendSetFollowerForwarding: vi.fn() },
        window: { localStorage: { getItem: vi.fn(() => null) } },
        getController: () => null,
        addSprinkle: vi.fn(),
        removeSprinkle: vi.fn(),
        agentHandle: { sendMessage: vi.fn(), onEvent: () => () => undefined, stop: vi.fn() },
        restoreLocalChrome: vi.fn(),
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
    // the same `toTabDescriptors` over the client roster, so it needs the same selection.
    const composerMeta = document.createElement('div');
    const switcher = document.createElement('div') as unknown as HTMLElement & {
      scoops: Array<{ key: string }>;
    };
    const { options } = buildFollowerOptions(
      {
        refs: {
          composerMeta,
          switcher,
          composer: document.createElement('div'),
          inputCard: document.createElement('div'),
          dock: document.createElement('div'),
          overlaySurfaces: new Set(),
        },
        browser: {},
        client: { sendSetFollowerForwarding: vi.fn() },
        window: { localStorage: { getItem: vi.fn(() => null) } },
        getController: () => null,
        addSprinkle: vi.fn(),
        removeSprinkle: vi.fn(),
        agentHandle: { sendMessage: vi.fn(), onEvent: () => () => undefined, stop: vi.fn() },
        restoreLocalChrome: vi.fn(),
      } as never,
      'https://tray.example/join/token',
      () => ({ selectScoop: vi.fn() }) as never
    );

    options.onScoopsList?.(
      [
        { jid: 'cone-a', name: 'cone', isCone: true, parentId: null },
        { jid: 'cone-b', name: 'research', isCone: true, parentId: null },
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
    const { options } = buildFollowerOptions(
      {
        refs: {
          composerMeta,
          switcher,
          composer: document.createElement('div'),
          inputCard: document.createElement('div'),
          dock: document.createElement('div'),
          overlaySurfaces: new Set(),
        },
        browser: {},
        client: { sendSetFollowerForwarding: vi.fn() },
        window: { localStorage: { getItem: vi.fn(() => null) } },
        getController: () => null,
        addSprinkle: vi.fn(),
        removeSprinkle: vi.fn(),
        agentHandle: { sendMessage: vi.fn(), onEvent: () => () => undefined, stop: vi.fn() },
        restoreLocalChrome: vi.fn(),
      } as never,
      'https://tray.example/join/token',
      () => ({ selectScoop: vi.fn() }) as never
    );

    options.onScoopsList?.(
      [
        { jid: 'cone', name: 'cone', isCone: true, parentId: null },
        { jid: 'research', name: 'research', isCone: false, parentId: 'cone' },
      ] as never,
      'cone'
    );
    switcher.dispatchEvent(new CustomEvent('slicc-scoop-select', { detail: { key: 'research' } }));
    options.onConnectionChange?.(false);
    expect(options.getSelectedScoopJid?.()).toBe('research');

    options.onScoopsList?.(
      [{ jid: 'cone', name: 'cone', isCone: true, parentId: null }] as never,
      'cone'
    );
    expect(options.getSelectedScoopJid?.()).toBe('cone');
    expect(switcher.getAttribute('active')).toBe('cone');
  });
});

describe('role-switch follower status', () => {
  /** The leader-capable float's follower role, with everything it touches. */
  function followerRole(overrides: Record<string, unknown> = {}) {
    const composerMeta = document.createElement('div') as HTMLElement & {
      model?: string;
      models?: unknown[];
    };
    const switcher = document.createElement('div') as HTMLElement & {
      scoops?: Array<{ key: string }>;
    };
    const composer = document.createElement('div');
    const inputCard = document.createElement('div');
    const controller = {
      loadMessages: vi.fn(),
      setProcessing: vi.fn(),
      addUserMessage: vi.fn(),
      addAssistantMessage: vi.fn(),
      setAgent: vi.fn(),
      processing: false,
    };
    const localAgent = { sendMessage: vi.fn(), onEvent: () => () => undefined, stop: vi.fn() };
    const restoreLocalChrome = vi.fn();
    const sync = {
      selectScoop: vi.fn(),
      selectModel: vi.fn(),
      setThinkingLevel: vi.fn(),
      sendMessage: vi.fn(),
      stop: vi.fn(),
      requestModels: vi.fn(),
    };
    const role = buildFollowerOptions(
      {
        refs: {
          composerMeta,
          composer,
          inputCard,
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
        agentHandle: localAgent,
        restoreLocalChrome,
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        ...overrides,
      } as never,
      'https://tray.example/join/token',
      () => sync as never
    );
    return {
      composerMeta,
      controller,
      inputCard,
      localAgent,
      restoreLocalChrome,
      role,
      switcher,
      sync,
    };
  }

  const CONES = [
    {
      jid: 'cone_a',
      name: 'a',
      folder: 'cone',
      parentId: null,
      isCone: true,
      assistantLabel: 'sliccy',
      model: { provider: 'anthropic', id: 'claude-opus-4-6' },
    },
    {
      jid: 'cone_b',
      name: 'b',
      folder: 'cone-b',
      parentId: null,
      isCone: true,
      assistantLabel: 'sliccy',
      model: { provider: 'anthropic', id: 'claude-sonnet-4-6' },
    },
  ] as never;
  const PILL_CATALOG = [
    { providerName: 'A', modelId: 'anthropic:claude-opus-4-6', modelName: 'Opus', reasoning: true },
    {
      providerName: 'A',
      modelId: 'anthropic:claude-sonnet-4-6',
      modelName: 'Sonnet',
      reasoning: true,
    },
  ];

  it('follows the roster’s model on a tab switch with no matching model.state', () => {
    const h = followerRole();
    h.role.options.onScoopsList?.(CONES, 'cone_a');
    h.role.options.onModelsList?.(PILL_CATALOG);
    h.role.options.onModelState?.({
      activeModelId: 'anthropic:claude-opus-4-6',
      scoopJid: 'cone_a',
    });
    expect(h.composerMeta.model).toBe('Opus');

    // The leader answers a selection with a snapshot, not a `model.state`, so
    // the roster is the only answer for the newly shown cone. Before this
    // float had a client it passed an empty roster and stayed on Opus.
    h.switcher.dispatchEvent(new CustomEvent('slicc-scoop-select', { detail: { key: 'cone_b' } }));
    expect(h.composerMeta.model).toBe('Sonnet');
  });

  it('installs the remote agent while following and hands the local one back on leave', () => {
    const h = followerRole();
    const remote = { sendMessage: vi.fn(), onEvent: () => () => undefined, stop: vi.fn() };
    h.role.options.setChatAgent?.(remote as never);
    // Not the sync manager and not the local handle: a handle that names its
    // unit over the client protocol (#2382 PR A).
    expect(h.controller.setAgent).toHaveBeenCalledTimes(1);
    expect(h.controller.setAgent.mock.calls[0]?.[0]).not.toBe(remote);
    expect(h.controller.setAgent.mock.calls[0]?.[0]).not.toBe(h.localAgent);

    h.role.dispose();
    // Leaving the tray hands the leader its own agent back; without this the
    // next composer submit rejects with "not connected to a leader" AFTER the
    // bubble is already on the thread.
    expect(h.controller.setAgent).toHaveBeenLastCalledWith(h.localAgent);
    expect(h.restoreLocalChrome).toHaveBeenCalledTimes(1);
  });

  it('stops the REMOTE turn while following, not the local kernel', () => {
    const h = followerRole();
    h.role.options.onScoopsList?.(CONES, 'cone_a');
    h.controller.processing = true;

    h.inputCard.dispatchEvent(new CustomEvent('stop', { bubbles: true }));
    // The leader mount's own `stop` listener closes over its LOCAL handle, so
    // without a capture listener here a stop aborted this float's own kernel
    // while the remote turn kept running.
    expect(h.sync.stop).toHaveBeenCalledTimes(1);
    expect(h.localAgent.stop).not.toHaveBeenCalled();

    // …and it stops intercepting once the role is gone.
    h.role.dispose();
    h.sync.stop.mockClear();
    h.inputCard.dispatchEvent(new CustomEvent('stop', { bubbles: true }));
    expect(h.sync.stop).not.toHaveBeenCalled();
  });

  it('unmounts the composer for a scoop, as the dedicated follower does (#2312)', () => {
    const h = followerRole();
    h.role.options.onScoopsList?.(
      [
        CONES[0],
        {
          jid: 'scoop_1',
          name: 'helper',
          folder: 'helper',
          parentId: 'cone_a',
          isCone: false,
          assistantLabel: 'sliccy',
        },
      ] as never,
      'cone_a'
    );
    h.switcher.dispatchEvent(new CustomEvent('slicc-scoop-select', { detail: { key: 'scoop_1' } }));
    // A user never talks to a scoop: its asks go to the owning cone. This
    // float used to deliver the prompt straight to the scoop.
    expect(h.role.options.getSelectedScoopJid?.()).toBe('scoop_1');
    expect(h.inputCard.hasAttribute('disabled')).toBe(true);
  });

  it('does not let a disposed role publish an empty strip after a re-join', () => {
    // Both roles live on the SAME shell chrome — that is the whole point: the
    // switcher outlives every join.
    const shared = {
      composerMeta: document.createElement('div'),
      composer: document.createElement('div'),
      inputCard: document.createElement('div'),
      switcher: document.createElement('div') as HTMLElement & { scoops?: Array<{ key: string }> },
      dock: document.createElement('div'),
      overlaySurfaces: new Set(),
    };
    const makeRole = () => {
      const sync = {
        selectScoop: vi.fn(),
        selectModel: vi.fn(),
        setThinkingLevel: vi.fn(),
        stop: vi.fn(),
      };
      const role = buildFollowerOptions(
        {
          refs: shared,
          browser: {},
          client: { sendSetFollowerForwarding: vi.fn() },
          window: { localStorage: { getItem: vi.fn(() => null) } },
          getController: () => null,
          addSprinkle: vi.fn(),
          removeSprinkle: vi.fn(),
          agentHandle: { sendMessage: vi.fn(), onEvent: () => () => undefined, stop: vi.fn() },
          restoreLocalChrome: vi.fn(),
          log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        } as never,
        'https://tray.example/join/token',
        () => sync as never
      );
      return role;
    };

    const first = makeRole();
    first.options.onScoopsList?.(CONES, 'cone_a');
    expect(shared.switcher.scoops?.map((tab) => tab.key)).toEqual(['cone_a', 'cone_b']);

    // Join B. The previous role is disposed; left alive its capture listener
    // still wins the capture phase and publishes from a client whose roster
    // `resetSelection()` cleared — an empty strip on the first click.
    first.dispose();
    const second = makeRole();
    second.options.onScoopsList?.(CONES, 'cone_a');
    shared.switcher.dispatchEvent(
      new CustomEvent('slicc-scoop-select', { detail: { key: 'cone_b' } })
    );
    expect(shared.switcher.scoops?.map((tab) => tab.key)).toEqual(['cone_a', 'cone_b']);
  });

  it('does not re-render the transcript on every roster push', () => {
    const switcher = document.createElement('div') as HTMLElement & { scoops?: unknown[] };
    const controller = { loadMessages: vi.fn(), setProcessing: vi.fn() };
    const { options } = buildFollowerOptions(
      {
        refs: {
          composerMeta: document.createElement('div'),
          composer: document.createElement('div'),
          inputCard: document.createElement('div'),
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
        agentHandle: { sendMessage: vi.fn(), onEvent: () => () => undefined, stop: vi.fn() },
        restoreLocalChrome: vi.fn(),
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      } as never,
      'https://tray.example/join/token',
      () => null
    );
    const roster = [
      { jid: 'research', name: 'research', folder: 'research', parentId: null, isCone: true },
    ] as never;

    options.onScoopsList?.(roster, 'research');
    options.onSnapshot?.(
      [{ id: 'a1', role: 'assistant', content: 'hi', timestamp: 1 }] as never,
      'research'
    );
    expect(controller.loadMessages).toHaveBeenCalledTimes(1);

    // The leader broadcasts `scoops.list` on a 5 s interval. Re-pointing the
    // subscription for the unit already being watched would replay the cached
    // snapshot each time — the thread re-rendering four times a minute, with
    // every dip disposed and rehydrated and the scroll moved.
    controller.loadMessages.mockClear();
    options.onScoopsList?.(roster, 'research');
    options.onScoopsList?.(roster, 'research');
    expect(controller.loadMessages).not.toHaveBeenCalled();
  });

  it('re-establishes snapshot busy state and ignores statuses for another scoop', () => {
    const switcher = document.createElement('div') as HTMLElement & { scoops?: unknown[] };
    const controller = { loadMessages: vi.fn(), setProcessing: vi.fn() };
    const { options } = buildFollowerOptions(
      {
        refs: {
          composerMeta: document.createElement('div'),
          composer: document.createElement('div'),
          inputCard: document.createElement('div'),
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
        agentHandle: { sendMessage: vi.fn(), onEvent: () => () => undefined, stop: vi.fn() },
        restoreLocalChrome: vi.fn(),
      } as never,
      'https://tray.example/join/token',
      () => null
    );
    const streaming: ChatMessage[] = [
      { id: 'a1', role: 'assistant', content: 'working', timestamp: 1, isStreaming: true },
    ];

    options.onSnapshot(streaming, 'research');
    expect(options.getSelectedScoopJid?.()).toBe('research');
    // Through the client protocol now (#2382 PR D), so the queue answer rides
    // along: `undefined` is a follower saying "nobody could answer", which
    // leaves any held pile standing (#2362).
    expect(controller.loadMessages).toHaveBeenCalledWith(streaming, undefined);
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

  it('re-broadcasts when the leader catalog itself becomes available (#2329)', () => {
    const windowTarget = new EventTarget();
    const broadcastModelCatalog = vi.fn();
    installLeaderModelCatalogRefresh({
      window: windowTarget as never,
      getSync: () => ({ broadcastModelCatalog }),
      refreshDynamicCatalogs: async () => false,
      log: { warn: vi.fn() } as unknown as BootStageLogger,
    });

    windowTarget.dispatchEvent(new Event(LEADER_MODEL_CATALOG_CHANGED_EVENT));
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
