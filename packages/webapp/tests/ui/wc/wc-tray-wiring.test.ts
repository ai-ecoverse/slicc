/**
 * Regression: the substrate gate in `wireWcTray` must be ONLY the boot-time
 * `startInitialRole` early-return — it must NOT skip `installRoleSwitchListeners`.
 * The isolated `startInitialRole` test (wc-tray.test.ts) can't catch a refactor
 * that accidentally moves the `if (deps.substrate) return` up into `wireWcTray`
 * itself; this end-to-end test does.
 *
 * It drives the real `wireWcTray({ substrate: true })` (tray primitives + panel
 * RPC + status subscription mocked) and asserts:
 *   1. boot does NOT auto-start a follower (substrate gate held), and
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

import { startPageFollowerTray } from '../../../src/ui/page-follower-tray.js';
import { wireWcTray } from '../../../src/ui/wc/wc-tray.js';

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

function makeDeps(substrate: boolean): Parameters<typeof wireWcTray>[0] {
  const storage = makeStorage();
  return {
    refs: {},
    client: { setForwardLickHandler: vi.fn(), getScoops: vi.fn(() => []) },
    browser: {},
    realCdpTransport: {},
    instanceId: 'test-instance',
    runtimeMode: 'standalone',
    sprinkleManager: { opened: () => [], available: () => [], setSendToSprinkleHook: vi.fn() },
    addSprinkle: vi.fn(),
    removeSprinkle: vi.fn(),
    getController: () => null,
    getSelectedJid: () => '',
    agentHandle: { sendMessage: vi.fn() },
    openFs: vi.fn(),
    window: makeWindow(storage),
    substrate,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as Parameters<typeof wireWcTray>[0];
}

describe('wireWcTray — substrate gate is boot-only, runtime wiring intact', () => {
  afterEach(() => vi.clearAllMocks());

  it('substrate=true: boot does not auto-start a follower, but slicc:tray-join still does', async () => {
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
