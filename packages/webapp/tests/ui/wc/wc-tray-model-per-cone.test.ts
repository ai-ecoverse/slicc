// @vitest-environment jsdom

/**
 * Leader-side per-cone model selection over the tray (#2310): a follower
 * changes the model of the cone IT is looking at, and the leader's own
 * selection is untouched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/base/logger.js';
import { BroadcastManager } from '../../../src/scoops/tray-leader/broadcast.js';
import type { LeaderSyncContext } from '../../../src/scoops/tray-leader/context.js';
import {
  type ConnectedFollower,
  FollowerRegistry,
} from '../../../src/scoops/tray-leader/follower-registry.js';
import type { LeaderSyncManagerOptions } from '../../../src/scoops/tray-leader-sync.js';
import type {
  LeaderToFollowerMessage,
  TrayModelCatalogEntry,
} from '../../../src/scoops/tray-sync-protocol.js';
import type { RegisteredScoop } from '../../../src/scoops/types.js';
import { createFollowerModelSurface } from '../../../src/ui/wc/wc-follower-model-surface.js';
import { createLeaderOptionsFactory } from '../../../src/ui/wc/wc-tray.js';

vi.mock('../../../src/ui/provider-settings.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../../src/ui/provider-settings.js'
  );
  return {
    ...actual,
    getAllAvailableModels: () => [
      {
        providerId: 'anthropic',
        providerName: 'Anthropic',
        models: [
          { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', reasoning: true },
          { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', reasoning: true },
        ],
      },
    ],
    resolveCurrentModel: () => ({ id: 'claude-sonnet-4-6', provider: 'anthropic' }),
  };
});

function cone(jid: string, folder: string, model?: RegisteredScoop['model']): RegisteredScoop {
  return {
    jid,
    name: folder,
    folder,
    parentJid: null,
    requiresTrigger: false,
    assistantLabel: folder,
    addedAt: '2026-08-22T00:00:00.000Z',
    ...(model ? { model } : {}),
  };
}

function makeOptions(scoops: RegisteredScoop[], selectedJid: string, applied = true) {
  const setScoopModel = vi.fn().mockResolvedValue(applied);
  const composerMeta = document.createElement('div') as HTMLElement & { model?: string };
  const modelChanges: string[] = [];
  composerMeta.addEventListener('model-change', (event) => {
    modelChanges.push((event as CustomEvent<{ id: string }>).detail.id);
  });
  const deps = {
    refs: { composerMeta, switcher: { scoops: [] }, floatbar: document.createElement('div') },
    client: {
      getScoops: () => scoops,
      getScoop: (jid: string) => scoops.find((s) => s.jid === jid),
      setScoopModel,
    },
    window,
    getSelectedJid: () => selectedJid,
    sprinkleManager: { opened: () => [], available: () => [] },
  } as unknown as Parameters<typeof createLeaderOptionsFactory>[0];
  const state = {
    leader: null,
    follower: null,
    persistenceGuard: { activate: vi.fn(), deactivate: vi.fn() },
    lockRelease: null,
  } as unknown as Parameters<typeof createLeaderOptionsFactory>[1];
  const options = createLeaderOptionsFactory(
    deps,
    state,
    {} as Parameters<typeof createLeaderOptionsFactory>[2]
  )('https://tray.example');
  return { options, setScoopModel, modelChanges, composerMeta };
}

describe('follower model selection is per cone (#2310)', () => {
  const coneA = cone('cone_1', 'cone', { provider: 'anthropic', id: 'claude-sonnet-4-6' });
  const coneB = cone('cone_2', 'cone-research', {
    provider: 'anthropic',
    id: 'claude-sonnet-4-6',
  });

  it('changes cone B while cone A is selected on the leader, and only cone B', async () => {
    const { options, setScoopModel, modelChanges, composerMeta } = makeOptions(
      [coneA, coneB],
      coneA.jid
    );

    await expect(
      options.onFollowerModelSelect?.('anthropic:claude-opus-4-6', coneB.jid)
    ).resolves.toBe(true);

    expect(setScoopModel).toHaveBeenCalledTimes(1);
    expect(setScoopModel).toHaveBeenCalledWith(coneB.jid, {
      provider: 'anthropic',
      id: 'claude-opus-4-6',
    });
    // The leader is on cone A: its pill and picker must not move.
    expect(modelChanges).toEqual([]);
    expect(composerMeta.model).toBeUndefined();
  });

  it('reflects the pick locally when the follower is on the cone the leader has selected', async () => {
    const { options, setScoopModel, modelChanges, composerMeta } = makeOptions(
      [coneA, coneB],
      coneA.jid
    );

    await expect(
      options.onFollowerModelSelect?.('anthropic:claude-opus-4-6', coneA.jid)
    ).resolves.toBe(true);

    expect(setScoopModel).toHaveBeenCalledWith(coneA.jid, {
      provider: 'anthropic',
      id: 'claude-opus-4-6',
    });
    expect(modelChanges).toEqual(['anthropic:claude-opus-4-6']);
    expect(composerMeta.getAttribute('model')).toBe('Claude Opus 4.6');
  });

  it('applies a pick made while viewing a scoop to the cone that owns it', async () => {
    const scoop: RegisteredScoop = {
      ...cone('scoop_1', 'worker'),
      parentJid: coneB.jid,
    };
    const { options, setScoopModel } = makeOptions([coneA, coneB, scoop], coneA.jid);

    await expect(
      options.onFollowerModelSelect?.('anthropic:claude-opus-4-6', scoop.jid)
    ).resolves.toBe(true);

    expect(setScoopModel).toHaveBeenCalledWith(coneB.jid, {
      provider: 'anthropic',
      id: 'claude-opus-4-6',
    });
  });

  it('resolves false and leaves the pill alone when the write does not persist', async () => {
    const { options, modelChanges, composerMeta } = makeOptions([coneA, coneB], coneA.jid, false);

    await expect(
      options.onFollowerModelSelect?.('anthropic:claude-opus-4-6', coneA.jid)
    ).resolves.toBe(false);

    expect(modelChanges).toEqual([]);
    expect(composerMeta.getAttribute('model')).toBeNull();
  });

  it('rejects a model id that is not in the advertised catalogue', () => {
    const { options, setScoopModel } = makeOptions([coneA, coneB], coneA.jid);
    expect(options.onFollowerModelSelect?.('evil:secret-model', coneB.jid)).toBe(false);
    expect(setScoopModel).not.toHaveBeenCalled();
  });

  it('reports each cone’s own model in the state a follower renders', () => {
    const { options } = makeOptions([coneA, coneB], coneA.jid);
    const opusCone = cone('cone_3', 'cone-writing', {
      provider: 'anthropic',
      id: 'claude-opus-4-6',
    });
    const withOpus = makeOptions([coneA, opusCone], coneA.jid);

    expect(options.getModelSelectionState?.(coneB.jid).activeModelId).toBe(
      'anthropic:claude-sonnet-4-6'
    );
    expect(withOpus.options.getModelSelectionState?.(opusCone.jid).activeModelId).toBe(
      'anthropic:claude-opus-4-6'
    );
  });
});

// ── issue #2329: a follower must not latch an empty catalog ────────────────

type FollowerComposerMeta = HTMLElement & {
  model?: string;
  models?: Array<{ id: string; name: string; provider: string }>;
};

const CATALOG: TrayModelCatalogEntry[] = [
  {
    providerName: 'Local',
    modelId: 'local-llm:fake-cone-primary',
    modelName: 'Fake Cone Primary',
    reasoning: false,
  },
];

/** A leader whose catalog starts empty and fills later, plus one follower. */
function createLeaderHarness() {
  let catalog: TrayModelCatalogEntry[] = [];
  const log: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const registry = new FollowerRegistry({ log, onMessage: vi.fn() });
  const sent: LeaderToFollowerMessage[] = [];
  registry.followers.set('follower', {
    bootstrapId: 'follower',
    sync: {
      send: (message: LeaderToFollowerMessage) => {
        sent.push(message);
        return true;
      },
    },
  } as unknown as ConnectedFollower);
  const options: LeaderSyncManagerOptions = {
    getMessages: () => [],
    getScoopJid: () => 'cone_1',
    onFollowerMessage: vi.fn(),
    onFollowerAbort: vi.fn(),
    sendControl: vi.fn(),
    getModelCatalog: () => catalog,
    getModelSelectionState: (scoopJid: string) => ({
      activeModelId: 'local-llm:fake-cone-primary',
      scoopJid,
    }),
  };
  const context: LeaderSyncContext = {
    options,
    followers: registry,
    log,
    sendControl: options.sendControl,
  };
  return {
    broadcast: new BroadcastManager(context),
    sent,
    setCatalog: (next: TrayModelCatalogEntry[]) => {
      catalog = next;
    },
  };
}

/** A follower surface fed exactly the frames the leader put on the wire. */
function createFollowerHarness(overrides: { requestModels?: () => void } = {}) {
  const composerMeta = document.createElement('div') as FollowerComposerMeta;
  const requestModels = vi.fn(overrides.requestModels);
  const sync = {
    selectModel: vi.fn(),
    setThinkingLevel: vi.fn(),
    selectScoop: vi.fn(),
    requestModels,
  } as unknown as NonNullable<
    ReturnType<Parameters<typeof createFollowerModelSurface>[0]['getSync']>
  >;
  const surface = createFollowerModelSurface({
    composerMeta,
    getSync: () => sync,
    // The wc-tray wiring: the pick goes out as the raw frame, unit named.
    setModel: (unitId, model) => sync.selectModel(`${model.provider}:${model.id}`, unitId),
    getSelectedScoopJid: () => 'cone_1',
    catalogRetryDelayMs: 10,
    catalogRetryMaxDelayMs: 40,
    catalogRetryWindowMs: 1000,
  });
  const deliver = (message: LeaderToFollowerMessage): void => {
    if (message.type === 'models.list') surface.onModelsList(message.models);
    if (message.type === 'model.state') surface.onModelState(message.state);
  };
  return { composerMeta, surface, requestModels, deliver };
}

describe('an empty model catalog is warm-up, not an answer (#2329)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the pill on a follower that joined before the leader had any model', () => {
    const leader = createLeaderHarness();
    const follower = createFollowerHarness();

    // Join during provider warm-up: no catalog frame at all, so nothing latches.
    leader.broadcast.sendModelCatalogToFollower('follower');
    for (const message of leader.sent) follower.deliver(message);
    expect(leader.sent.filter((m) => m.type === 'models.list')).toEqual([]);
    expect(follower.composerMeta.style.display).toBe('none');

    // The catalog lands: the leader re-broadcasts and the pill appears.
    leader.sent.length = 0;
    leader.setCatalog(CATALOG);
    leader.broadcast.broadcastModelCatalog();
    for (const message of leader.sent) follower.deliver(message);
    expect(leader.sent).toContainEqual({ type: 'models.list', models: CATALOG });
    expect(follower.composerMeta.style.display).toBe('');
    expect(follower.composerMeta.model).toBe('Fake Cone Primary');
  });

  it('delivers a late catalog on the next model-state broadcast too', () => {
    const leader = createLeaderHarness();
    const follower = createFollowerHarness();

    leader.broadcast.sendModelCatalogToFollower('follower');
    leader.sent.length = 0;
    leader.setCatalog(CATALOG);
    leader.broadcast.broadcastModelState();
    for (const message of leader.sent) follower.deliver(message);

    expect(leader.sent[0]).toEqual({ type: 'models.list', models: CATALOG });
    expect(follower.composerMeta.style.display).toBe('');
  });

  it('still reports an emptied catalog to a follower that already had one', () => {
    const leader = createLeaderHarness();
    leader.setCatalog(CATALOG);
    leader.broadcast.broadcastModelCatalog();
    leader.sent.length = 0;

    // The last account was removed: this follower has seen a real catalog, so
    // `[]` is news rather than warm-up and goes out.
    leader.setCatalog([]);
    leader.broadcast.broadcastModelCatalog();
    expect(leader.sent).toContainEqual({ type: 'models.list', models: [] });
  });

  it('recovers a follower that latched an empty catalog from an older leader', () => {
    const follower = createFollowerHarness();

    // Older leader: advertises `[]` as a valid frame, then the active model.
    follower.deliver({ type: 'models.list', models: [] });
    follower.deliver({
      type: 'model.state',
      state: { activeModelId: 'local-llm:fake-cone-primary', scoopJid: 'cone_1' },
    });
    expect(follower.composerMeta.style.display).toBe('none');

    vi.advanceTimersByTime(10);
    expect(follower.requestModels).toHaveBeenCalledTimes(1);

    follower.deliver({ type: 'models.list', models: CATALOG });
    expect(follower.composerMeta.style.display).toBe('');
    expect(follower.composerMeta.model).toBe('Fake Cone Primary');
  });

  it('keeps asking past the old three-try limit while the pill is unresolved', () => {
    // The regression this replaces: three tries at a flat delay gave up after
    // six seconds, so a leader whose catalog landed later was never asked
    // again and the picker stayed hidden for the session (~1 in 7 cold starts
    // of the two-instance e2e, even after the rest of #2329 was fixed).
    const follower = createFollowerHarness();
    follower.deliver({
      type: 'model.state',
      state: { activeModelId: 'local-llm:fake-cone-primary', scoopJid: 'cone_1' },
    });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      vi.advanceTimersByTime(40);
      follower.deliver({ type: 'models.list', models: [] });
    }
    expect(follower.requestModels.mock.calls.length).toBeGreaterThan(3);
  });

  it('backs off rather than polling at a flat interval', () => {
    const follower = createFollowerHarness();
    follower.deliver({
      type: 'model.state',
      state: { activeModelId: 'local-llm:fake-cone-primary', scoopJid: 'cone_1' },
    });
    // First gap is the base delay…
    vi.advanceTimersByTime(10);
    expect(follower.requestModels).toHaveBeenCalledTimes(1);
    follower.deliver({ type: 'models.list', models: [] });
    // …the second is longer, so the same 10 ms is no longer enough.
    vi.advanceTimersByTime(10);
    expect(follower.requestModels).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10);
    expect(follower.requestModels).toHaveBeenCalledTimes(2);
  });

  it('still stops eventually, so a leader with no models is not polled forever', () => {
    const follower = createFollowerHarness();
    follower.deliver({
      type: 'model.state',
      state: { activeModelId: 'local-llm:fake-cone-primary', scoopJid: 'cone_1' },
    });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      vi.advanceTimersByTime(40);
      follower.deliver({ type: 'models.list', models: [] });
    }
    const afterWindow = follower.requestModels.mock.calls.length;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      vi.advanceTimersByTime(40);
      follower.deliver({ type: 'models.list', models: [] });
    }
    expect(follower.requestModels.mock.calls.length).toBe(afterWindow);
  });

  it('stops asking as soon as the catalog resolves', () => {
    const follower = createFollowerHarness();
    follower.deliver({
      type: 'model.state',
      state: { activeModelId: 'local-llm:fake-cone-primary', scoopJid: 'cone_1' },
    });
    vi.advanceTimersByTime(40);
    follower.deliver({ type: 'models.list', models: CATALOG });
    expect(follower.composerMeta.style.display).toBe('');
    const resolved = follower.requestModels.mock.calls.length;
    vi.advanceTimersByTime(500);
    expect(follower.requestModels.mock.calls.length).toBe(resolved);
  });
});
