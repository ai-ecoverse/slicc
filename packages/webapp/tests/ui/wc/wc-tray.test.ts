// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://www.sliccy.ai/" }
import { beforeEach, describe, expect, it, vi } from 'vitest';

const guardMocks = vi.hoisted(() => ({
  instances: [] as Array<{
    activate: ReturnType<typeof vi.fn>;
    deactivate: ReturnType<typeof vi.fn>;
  }>,
}));
const trayMocks = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  stop: vi.fn(),
}));
const lockMocks = vi.hoisted(() => ({
  fatalCleanup: null as (() => void) | null,
  acquireLeaderRole: vi.fn(),
}));

vi.mock('../../../src/scoops/tab-persistence-guard.js', () => ({
  TabPersistenceGuard: class {
    activate = vi.fn();
    deactivate = vi.fn();

    constructor() {
      guardMocks.instances.push(this);
    }
  },
}));

vi.mock('../../../src/ui/page-leader-tray.js', () => ({
  getLeaderFollowerStates: () => [],
  startPageLeaderTray: (options: Record<string, unknown>) => {
    trayMocks.options = options;
    return {
      ready: Promise.resolve(),
      stop: trayMocks.stop,
      reset: vi.fn(),
      scheduleScoopsListBroadcast: vi.fn(),
      peers: { getPeers: () => [] },
      sync: {
        broadcastSnapshot: vi.fn(),
        broadcastSprinkleUpdate: vi.fn(),
        broadcastSprinkleReloaded: vi.fn(),
        broadcastUserMessage: vi.fn(),
        broadcastStatus: vi.fn(),
        broadcastTheme: vi.fn(),
        getSprinkleInstances: () => [],
        getExecCapableBootstrapIds: () => new Set(),
        getComputerCapableBootstrapIds: () => new Set(),
        getAbsorbedBootstrapIds: () => new Set(),
        getBrowserCapableBootstrapIds: () => new Set(),
        getTeleportEligibleBootstrapIds: () => new Set(),
        getFollowerMotds: () => new Map(),
      },
    };
  },
}));

vi.mock('../../../src/ui/page-follower-tray.js', () => ({
  startPageFollowerTray: vi.fn(),
}));
vi.mock('../../../src/ui/legacy-styles.js', () => ({
  loadSprinkleStyles: vi.fn(async () => {}),
}));
vi.mock('../../../src/ui/boot/setup-standalone-panel-rpc.js', () => ({
  setupStandalonePanelRpc: vi.fn(async () => {}),
}));
vi.mock('../../../src/ui/boot/setup-standalone-tray-init-hosted.js', () => ({
  runHostedBootstrap: vi.fn(async () => {}),
}));
vi.mock('../../../src/ui/remote-cdp-page-bridge.js', () => ({
  createRemoteCdpPageBridge: () => ({
    cleanupRuntime: vi.fn(),
    disposeAll: vi.fn(),
  }),
}));
vi.mock('../../../src/ui/tray-leader-lock.js', () => ({
  acquireLeaderRole: (...args: unknown[]) => lockMocks.acquireLeaderRole(...args),
  getDefaultLockManager: () => null,
  isTrayLeaderBootAborted: () => false,
  registerTrayLeaderFatalCleanup: (cleanup: () => void) => {
    lockMocks.fatalCleanup = cleanup;
  },
  requestLeaderLock: vi.fn(),
}));
vi.mock('../../../src/shell/supplemental-commands/host-command.js', () => ({
  getConnectedFollowers: () => [],
  setConnectedFollowersGetter: vi.fn(),
  setTrayResetter: vi.fn(),
  writeConnectedFollowersToShim: vi.fn(),
}));
vi.mock('../../../src/scoops/tray-leader.js', () => ({
  getLeaderTrayRuntimeStatus: () => ({ state: 'inactive' }),
  subscribeToLeaderTrayRuntimeStatus: vi.fn(),
}));
vi.mock('../../../src/scoops/tray-follower-status.js', () => ({
  FOLLOWER_STATUS_STORAGE_KEY: 'slicc.followerTrayStatus',
  getFollowerTrayRuntimeStatus: () => ({ state: 'inactive' }),
  subscribeToFollowerTrayRuntimeStatus: vi.fn(),
}));
vi.mock('../../../src/ui/theme-engine.js', () => ({
  getActiveThemeId: () => 'default',
  getActiveThemeJson: () => ({}),
  setThemeChangeListener: vi.fn(),
}));

import { TRAY_WORKER_STORAGE_KEY } from '../../../src/scoops/tray-runtime-config.js';
import { wireWcTray } from '../../../src/ui/wc/wc-tray.js';

function makeDeps() {
  const floatbar = document.createElement('div');
  const data = new Map([[TRAY_WORKER_STORAGE_KEY, 'https://tray.example.com']]);
  const testWindow = Object.assign(new EventTarget(), {
    localStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
      removeItem: (key: string) => data.delete(key),
    },
  });
  const deps = {
    refs: { floatbar, switcher: { scoops: [] } },
    client: {
      setForwardLickHandler: vi.fn(),
      getScoops: () => [],
    },
    browser: {},
    realCdpTransport: {},
    instanceId: 'test-instance',
    runtimeMode: 'hosted-leader',
    sprinkleManager: {
      opened: () => [],
      available: () => [],
      setSendToSprinkleHook: vi.fn(),
      setReloadHook: vi.fn(),
    },
    addSprinkle: vi.fn(),
    removeSprinkle: vi.fn(),
    getController: () => null,
    getSelectedJid: () => 'cone',
    agentHandle: { sendMessage: vi.fn(), stop: vi.fn(), onEvent: vi.fn() },
    workUnits: { subscribeList: () => () => undefined, send: vi.fn(), signal: vi.fn() },
    openFs: vi.fn(),
    openWriter: vi.fn(),
    window: testWindow,
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), stage: vi.fn() },
  };
  return { deps, testWindow };
}

describe('wireWcTray tab persistence guard', () => {
  beforeEach(() => {
    guardMocks.instances.length = 0;
    trayMocks.options = null;
    trayMocks.stop.mockClear();
  });

  it('uses one guard for follower transitions and deactivates it when the leader stops', async () => {
    const { deps, testWindow } = makeDeps();
    await wireWcTray(deps as never);

    expect(guardMocks.instances).toHaveLength(1);
    const guard = guardMocks.instances[0];
    const onFollowerCountChanged = trayMocks.options?.onFollowerCountChanged as (
      count: number
    ) => void;

    onFollowerCountChanged(1);
    expect(guard.activate).toHaveBeenCalledTimes(1);
    onFollowerCountChanged(0);
    expect(guard.deactivate).toHaveBeenCalledTimes(1);

    onFollowerCountChanged(1);
    testWindow.dispatchEvent(new Event('beforeunload'));
    expect(guard.deactivate).toHaveBeenCalledTimes(2);
    expect(trayMocks.stop).toHaveBeenCalledTimes(1);
  });
});

describe('wireWcTray fatal boot', () => {
  beforeEach(() => {
    guardMocks.instances.length = 0;
    trayMocks.options = null;
    trayMocks.stop.mockClear();
    lockMocks.fatalCleanup = null;
    lockMocks.acquireLeaderRole.mockReset();
  });

  it('stops the leader tray and releases the lock when boot fails', async () => {
    const release = vi.fn();
    lockMocks.acquireLeaderRole.mockImplementation(
      async (opts: { onGranted: (release: () => void) => void }) => {
        opts.onGranted(release);
      }
    );
    const { deps } = makeDeps();
    (deps as { runtimeMode: string }).runtimeMode = 'standalone';

    await wireWcTray(deps as never);

    expect(lockMocks.fatalCleanup).toEqual(expect.any(Function));
    expect(trayMocks.stop).not.toHaveBeenCalled();
    lockMocks.fatalCleanup?.();

    expect(trayMocks.stop).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(guardMocks.instances[0]?.deactivate).toHaveBeenCalled();
  });
});

describe('wireWcTray follower sprinkle lick origin (#3089)', () => {
  beforeEach(() => {
    trayMocks.options = null;
  });

  async function wireWithPanels(owners: Record<string, string | undefined>) {
    const { deps } = makeDeps();
    const sendSprinkleLick = vi.fn();
    Object.assign(deps.client, { sendSprinkleLick });
    Object.assign(deps.sprinkleManager, {
      opened: () => Object.keys(owners),
      lickOriginUnitIdOf: (name: string) => owners[name],
    });
    await wireWcTray(deps as never);
    const onSprinkleLick = trayMocks.options?.onSprinkleLick as (
      name: string,
      body: unknown,
      targetScoop?: string,
      originLabel?: string,
      originUnitJid?: string
    ) => void;
    return { onSprinkleLick, sendSprinkleLick };
  }

  it("stamps an open panel's opening cone, not the follower's selection", async () => {
    const { onSprinkleLick, sendSprinkleLick } = await wireWithPanels({ review: 'cone-b' });

    onSprinkleLick('review', { action: 'publish' }, undefined, 'follower', 'cone-c');

    expect(sendSprinkleLick).toHaveBeenCalledWith('review', { action: 'publish' }, undefined, {
      label: 'follower',
      unitJid: 'cone-b',
    });
  });

  it('keeps an explicit target and still stamps the opening cone as fallback', async () => {
    const { onSprinkleLick, sendSprinkleLick } = await wireWithPanels({ review: 'cone-b' });

    onSprinkleLick('review', { action: 'publish' }, 'cone-a', 'follower', 'cone-c');

    expect(sendSprinkleLick).toHaveBeenCalledWith('review', { action: 'publish' }, 'cone-a', {
      label: 'follower',
      unitJid: 'cone-b',
    });
  });

  it('gives an owner-less open panel no origin, matching a click on the leader', async () => {
    const { onSprinkleLick, sendSprinkleLick } = await wireWithPanels({ review: undefined });

    onSprinkleLick('review', { action: 'publish' }, undefined, 'follower', 'cone-c');

    expect(sendSprinkleLick).toHaveBeenCalledWith('review', { action: 'publish' }, undefined, {
      label: 'follower',
      unitJid: undefined,
    });
  });

  it("keeps the follower's selection for an inline dip lick (#2312)", async () => {
    // Even with a user panel that is itself named `inline` open on the leader.
    const { onSprinkleLick, sendSprinkleLick } = await wireWithPanels({ inline: 'cone-b' });

    onSprinkleLick('inline', { action: 'ok' }, undefined, 'follower', 'cone-c');

    expect(sendSprinkleLick).toHaveBeenCalledWith('inline', { action: 'ok' }, undefined, {
      label: 'follower',
      unitJid: 'cone-c',
    });
  });
});
