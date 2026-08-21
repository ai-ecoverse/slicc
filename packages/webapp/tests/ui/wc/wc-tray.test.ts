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
  acquireLeaderRole: vi.fn(),
  getDefaultLockManager: () => null,
  requestLeaderLock: vi.fn(),
}));
vi.mock('../../../src/ui/wc/wc-floatbar-online.js', () => ({
  installFloatbarOnline: vi.fn(),
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
