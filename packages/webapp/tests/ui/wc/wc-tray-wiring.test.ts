/**
 * Regression: the cup gate in `wireWcTray` must be ONLY the boot-time
 * `startInitialRole` early-return — it must NOT skip `installRoleSwitchListeners`.
 * The isolated `startInitialRole` test (wc-tray.test.ts) can't catch a refactor
 * that accidentally moves the `if (deps.cup) return` up into `wireWcTray`
 * itself; this end-to-end test does.
 *
 * It drives the real `wireWcTray({ cup: true })` (tray primitives + panel
 * RPC + status subscription mocked) and asserts:
 *   1. boot does NOT auto-start a follower (cup gate held), and
 *   2. a runtime `slicc:tray-join` window event STILL starts a follower — i.e.
 *      the `host join` / `host lead` / `host leave` runtime surface stays wired.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/ui/page-leader-tray.js', () => ({
  startPageLeaderTray: vi.fn(() => ({ stop: vi.fn(), sync: null })),
}));
vi.mock('../../../src/ui/page-follower-tray.js', () => ({
  startPageFollowerTray: vi.fn(() => ({ stop: vi.fn(), currentSync: null })),
  CHERRY_RUNTIME_TAG: 'cherry',
}));
vi.mock('../../../src/ui/boot/setup-standalone-panel-rpc.js', () => ({
  setupStandalonePanelRpc: vi.fn(async () => {}),
}));
vi.mock('../../../src/ui/boot/setup-standalone-tray-init-hosted.js', () => ({
  runHostedBootstrap: vi.fn(async () => {}),
}));
vi.mock('../../../src/scoops/tray-leader.js', () => ({
  getLeaderTrayRuntimeStatus: vi.fn(() => ({})),
  subscribeToLeaderTrayRuntimeStatus: vi.fn(),
}));
vi.mock('../../../src/ui/remote-cdp-page-bridge.js', () => ({
  createRemoteCdpPageBridge: vi.fn(() => ({ disposeAll: vi.fn() })),
}));
vi.mock('../../../src/shell/supplemental-commands/host-command.js', () => ({
  getConnectedFollowers: vi.fn(() => []),
  setConnectedFollowersGetter: vi.fn(),
  setTrayResetter: vi.fn(),
  writeConnectedFollowersToShim: vi.fn(),
}));

import {
  FOLLOWER_STATUS_STORAGE_KEY,
  type FollowerTrayRuntimeStatus,
  setFollowerTrayRuntimeStatus,
} from '../../../src/scoops/tray-follower-status.js';
import { startPageFollowerTray } from '../../../src/ui/page-follower-tray.js';
import { createLeaderOptionsFactory, wireWcTray } from '../../../src/ui/wc/wc-tray.js';

function followerStatus(
  overrides: Partial<FollowerTrayRuntimeStatus> = {}
): FollowerTrayRuntimeStatus {
  return {
    state: 'inactive',
    joinUrl: null,
    trayId: null,
    error: null,
    lastPingTime: null,
    reconnectAttempts: 0,
    attachAttempts: 0,
    lastAttachCode: null,
    connectingSince: null,
    lastError: null,
    ...overrides,
  };
}

function makeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      m.set(k, v);
    },
    removeItem: (k) => {
      m.delete(k);
    },
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  } as Storage;
}

// A minimal Window backed by a real EventTarget so addEventListener +
// dispatchEvent + CustomEvent.detail behave like the browser.
function makeWindow(storage: Storage): Window {
  const target = new EventTarget();
  return {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    localStorage: storage,
  } as unknown as Window;
}

function makeDeps(cup: boolean): Parameters<typeof wireWcTray>[0] {
  const storage = makeStorage();
  return {
    refs: {},
    client: { setForwardLickHandler: vi.fn(), getScoops: vi.fn(() => []) },
    browser: {},
    realCdpTransport: {},
    instanceId: 'test-instance',
    runtimeMode: 'standalone',
    sprinkleManager: {
      opened: () => [],
      available: () => [],
      setSendToSprinkleHook: vi.fn(),
      setReloadHook: vi.fn(),
    },
    addSprinkle: vi.fn(),
    removeSprinkle: vi.fn(),
    getController: () => null,
    getSelectedJid: () => '',
    agentHandle: { sendMessage: vi.fn() },
    openFs: vi.fn(),
    window: makeWindow(storage),
    cup,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as Parameters<typeof wireWcTray>[0];
}

describe('wireWcTray — cup gate is boot-only, runtime wiring intact', () => {
  afterEach(() => vi.clearAllMocks());

  it('cup=true: boot does not auto-start a follower, but slicc:tray-join still does', async () => {
    const deps = makeDeps(true);
    await wireWcTray(deps);

    // Gate held at boot.
    expect(startPageFollowerTray).not.toHaveBeenCalled();

    // Runtime tray-join (the `host join` path) must still wire through.
    deps.window.dispatchEvent(
      new CustomEvent('slicc:tray-join', { detail: { joinUrl: 'https://hub.example/tray/xyz' } })
    );
    expect(startPageFollowerTray).toHaveBeenCalledOnce();
    expect((startPageFollowerTray as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      joinUrl: 'https://hub.example/tray/xyz',
    });
  });
});

describe('wireWcTray — follower-status shim mirror (worker-visible host)', () => {
  // The standalone kernel worker runs `host` but the FollowerSyncManager lives
  // on the page. wireWcTray must mirror the page-side follower status into the
  // `slicc.followerTrayStatus` localStorage shim (seeded on boot + on every
  // change) so `getFollowerStatusWithFallback` in the worker reports a live
  // follower instead of `status: inactive` (the b268 bug).
  afterEach(() => {
    vi.clearAllMocks();
    setFollowerTrayRuntimeStatus(followerStatus()); // reset shared module global
  });

  it('seeds the follower shim on boot and mirrors later status changes', async () => {
    setFollowerTrayRuntimeStatus(followerStatus()); // ensure inactive baseline
    const deps = makeDeps(false);
    const storage = deps.window.localStorage;
    await wireWcTray(deps);

    // Seeded on boot so a stale prior-session value can't fake a connection.
    const seeded = storage.getItem(FOLLOWER_STATUS_STORAGE_KEY);
    expect(seeded).not.toBeNull();
    expect(JSON.parse(seeded as string).state).toBe('inactive');

    // A live follower-status change is mirrored into the shim.
    setFollowerTrayRuntimeStatus(
      followerStatus({
        state: 'connected',
        joinUrl: 'https://www.sliccy.ai/join/abc.def',
        trayId: 'tray-1',
      })
    );
    const mirrored = JSON.parse(storage.getItem(FOLLOWER_STATUS_STORAGE_KEY) as string);
    expect(mirrored.state).toBe('connected');
    expect(mirrored.joinUrl).toBe('https://www.sliccy.ai/join/abc.def');
  });
});

describe('createLeaderOptionsFactory — onFollowerMessage echo is throw-safe', () => {
  afterEach(() => vi.clearAllMocks());

  // Regression: a follower's own message vanished from the follower it was typed in
  // because a throw in the agent send (the cone-less default handle dead-ending at
  // "No scoop selected" in cup mode) skipped the very next line —
  // state.leader.sync.broadcastUserMessage (the leader→follower echo). The send and the
  // echo must be independent: a send throw is logged and swallowed, the echo STILL fires.
  it('still broadcasts the echo (and logs) when agentHandle.sendMessage throws', () => {
    const addUserMessage = vi.fn();
    const broadcastUserMessage = vi.fn();
    const error = vi.fn();
    const deps = {
      client: { getScoops: vi.fn(() => []), sendSprinkleLick: vi.fn() },
      refs: {},
      getController: () => ({ addUserMessage, getMessages: () => [] }),
      getSelectedJid: () => 'cone',
      sprinkleManager: { opened: () => [], available: () => [] },
      openFs: vi.fn(),
      agentHandle: {
        sendMessage: vi.fn(() => {
          throw new Error('No scoop selected');
        }),
      },
      log: { error },
    } as unknown as Parameters<typeof createLeaderOptionsFactory>[0];
    const state = { leader: { sync: { broadcastUserMessage } } } as unknown as Parameters<
      typeof createLeaderOptionsFactory
    >[1];
    const bridge = {} as unknown as Parameters<typeof createLeaderOptionsFactory>[2];

    const options = createLeaderOptionsFactory(deps, state, bridge)('https://worker.example');
    // Must not throw despite the send blowing up.
    expect(() => options.onFollowerMessage('what is the time', 'msg-1', undefined)).not.toThrow();

    expect(addUserMessage).toHaveBeenCalledWith('what is the time', undefined);
    expect(error).toHaveBeenCalledTimes(1); // the throw was logged, not propagated
    // The echo to the other followers STILL fired — the vanished-message bug is guarded.
    expect(broadcastUserMessage).toHaveBeenCalledWith('what is the time', 'msg-1', undefined);
  });
});
