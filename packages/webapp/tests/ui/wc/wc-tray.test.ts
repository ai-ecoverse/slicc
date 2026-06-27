/**
 * Regression: in cup (steering) mode the page must NOT auto-start a tray
 * role at boot. The shared default-port Chrome profile can carry a persisted
 * leader session (TRAY_WORKER_STORAGE_KEY) from the user's normal SLICC runs;
 * without this gate `startInitialRole` restores it, bootstrapping a cone and a
 * second CDP authority — exactly the "two-brains" violation cup mode is
 * meant to avoid. Explicit tray control still flows through the runtime
 * `host join` / `host lead` window events, which `wireWcTray` keeps wired.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TRAY_JOIN_STORAGE_KEY,
  TRAY_WORKER_STORAGE_KEY,
} from '../../../src/scoops/tray-runtime-config.js';

vi.mock('../../../src/ui/page-leader-tray.js', () => ({
  startPageLeaderTray: vi.fn(() => ({ stop: vi.fn(), sync: null })),
}));
vi.mock('../../../src/ui/page-follower-tray.js', () => ({
  startPageFollowerTray: vi.fn(() => ({ stop: vi.fn(), currentSync: null })),
}));

import { startPageFollowerTray } from '../../../src/ui/page-follower-tray.js';
import { startPageLeaderTray } from '../../../src/ui/page-leader-tray.js';
import { startInitialRole } from '../../../src/ui/wc/wc-tray.js';

function makeStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
    removeItem: (k: string) => {
      m.delete(k);
    },
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  } as Storage;
}

// startInitialRole only reads runtimeMode / window / log / cup; the rest
// of WcTrayDeps is irrelevant here, so a partial cast keeps the test focused.
function fakeDeps(cup: boolean, storage: Storage): Parameters<typeof startInitialRole>[0] {
  return {
    runtimeMode: 'standalone',
    window: { localStorage: storage } as unknown as Window,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    cup,
  } as unknown as Parameters<typeof startInitialRole>[0];
}

describe('wc-tray startInitialRole — cup gate', () => {
  afterEach(() => vi.clearAllMocks());

  it('cup=true: does NOT auto-start a role despite a stored worker base URL', () => {
    const storage = makeStorage({ [TRAY_WORKER_STORAGE_KEY]: 'https://tray.example' });
    const state = { leader: null, follower: null };
    startInitialRole(fakeDeps(true, storage), state, () => ({}) as never, vi.fn());
    expect(startPageLeaderTray).not.toHaveBeenCalled();
    expect(startPageFollowerTray).not.toHaveBeenCalled();
    expect(state.leader).toBeNull();
  });

  it('cup=true: does NOT auto-join despite a stored join URL', () => {
    const storage = makeStorage({ [TRAY_JOIN_STORAGE_KEY]: 'https://hub.example/tray/abc' });
    const state = { leader: null, follower: null };
    startInitialRole(fakeDeps(true, storage), state, () => ({}) as never, vi.fn());
    expect(startPageFollowerTray).not.toHaveBeenCalled();
    expect(state.follower).toBeNull();
  });

  it('non-cup (control): auto-starts a leader from a stored worker base URL', () => {
    const storage = makeStorage({ [TRAY_WORKER_STORAGE_KEY]: 'https://tray.example' });
    const state = { leader: null, follower: null };
    startInitialRole(fakeDeps(false, storage), state, () => ({}) as never, vi.fn());
    expect(startPageLeaderTray).toHaveBeenCalledOnce();
  });
});
