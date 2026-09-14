import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  broadcastLeaderGone,
  getPanelState,
  handleCherryPanelConnect,
  resetCherryPanelState,
  setCherryPanelJoinUrl,
  setCherryPanelRecoveryDeps,
} from '../src/cherry-panel-sw.js';

function mockStorageSession(): Record<string, unknown> {
  const store: Record<string, unknown> = {};
  (globalThis as any).chrome = {
    storage: {
      session: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (obj: Record<string, unknown>) => {
          Object.assign(store, obj);
        },
      },
    },
  };
  return store;
}

function fakePort() {
  const msgs: unknown[] = [];
  let onMsg: ((m: unknown) => void) | undefined;
  let onDisc: (() => void) | undefined;
  return {
    _sent: msgs,
    _rx: (m: unknown) => onMsg?.(m),
    _drop: () => onDisc?.(),
    postMessage: (m: unknown) => msgs.push(m),
    disconnect: vi.fn(),
    onMessage: { addListener: (cb: (m: unknown) => void) => (onMsg = cb), removeListener: vi.fn() },
    onDisconnect: { addListener: (cb: () => void) => (onDisc = cb) },
  };
}

describe('cherry-panel-sw', () => {
  beforeEach(() => resetCherryPanelState());
  afterEach(() => {
    (globalThis as any).chrome = undefined;
  });

  it('on connect: does NOT post before hello; replies with current state (booting) after hello', async () => {
    const ensureLeaderTab = vi.fn(async () => {});
    const p = fakePort();
    await handleCherryPanelConnect(p as never, { ensureLeaderTab });
    expect(p._sent).toEqual([]);
    p._rx({ kind: 'hello' });
    expect(ensureLeaderTab).toHaveBeenCalledTimes(1);
    expect(p._sent).toContainEqual({ kind: 'join-url', state: 'booting' });
  });

  it('a focus-leader message focuses the leader tab AND opens its Settings dialog', async () => {
    const focusLeaderTab = vi.fn(async () => {});
    const openSettingsOnLeader = vi.fn();
    const p = fakePort();
    await handleCherryPanelConnect(p as never, {
      ensureLeaderTab: vi.fn(async () => {}),
      focusLeaderTab,
      openSettingsOnLeader,
    });
    p._rx({ kind: 'focus-leader' });
    expect(focusLeaderTab).toHaveBeenCalledTimes(1);

    expect(openSettingsOnLeader).toHaveBeenCalledTimes(1);

    expect(p._sent).toEqual([]);
  });

  it('a focus-leader message with openSettings:false focuses WITHOUT opening Settings', async () => {
    const focusLeaderTab = vi.fn(async () => {});
    const openSettingsOnLeader = vi.fn();
    const p = fakePort();
    await handleCherryPanelConnect(p as never, {
      ensureLeaderTab: vi.fn(async () => {}),
      focusLeaderTab,
      openSettingsOnLeader,
    });

    p._rx({ kind: 'focus-leader', openSettings: false });
    expect(focusLeaderTab).toHaveBeenCalledTimes(1);
    expect(openSettingsOnLeader).not.toHaveBeenCalled();
  });

  it('a focus-leader message swallows a focusLeaderTab rejection (fire-and-forget, no unhandled rejection)', async () => {
    const focusLeaderTab = vi.fn(async () => {
      throw new Error('tab gone');
    });
    const openSettingsOnLeader = vi.fn();
    const p = fakePort();
    await handleCherryPanelConnect(p as never, {
      ensureLeaderTab: vi.fn(async () => {}),
      focusLeaderTab,
      openSettingsOnLeader,
    });
    expect(() => p._rx({ kind: 'focus-leader' })).not.toThrow();
    expect(focusLeaderTab).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('a focus-leader message with no openSettingsOnLeader dep still focuses (no throw)', async () => {
    const focusLeaderTab = vi.fn(async () => {});
    const p = fakePort();
    await handleCherryPanelConnect(p as never, {
      ensureLeaderTab: vi.fn(async () => {}),
      focusLeaderTab,
    });
    expect(() => p._rx({ kind: 'focus-leader' })).not.toThrow();
    expect(focusLeaderTab).toHaveBeenCalledTimes(1);
  });

  it('setCherryPanelJoinUrl(string) broadcasts ready to connected panels', async () => {
    const p = fakePort();
    await handleCherryPanelConnect(p as never, { ensureLeaderTab: vi.fn(async () => {}) });
    p._rx({ kind: 'hello' });
    setCherryPanelJoinUrl('https://tray/join/t.s');
    expect(p._sent).toContainEqual({
      kind: 'join-url',
      state: 'ready',
      joinUrl: 'https://tray/join/t.s',
    });
    expect(getPanelState()).toEqual({
      kind: 'join-url',
      state: 'ready',
      joinUrl: 'https://tray/join/t.s',
    });
  });

  it('setCherryPanelJoinUrl(null) BEFORE any ready → stays booting (no joinUrl yet)', async () => {
    const p = fakePort();
    await handleCherryPanelConnect(p as never, { ensureLeaderTab: vi.fn(async () => {}) });
    p._rx({ kind: 'hello' });
    setCherryPanelJoinUrl(null);
    expect(getPanelState()).toEqual({ kind: 'join-url', state: 'booting' });
    expect(p._sent).not.toContainEqual({ kind: 'join-url', state: 'disconnected' });
  });

  it('setCherryPanelJoinUrl(null) AFTER a ready → disconnected', async () => {
    const p = fakePort();
    await handleCherryPanelConnect(p as never, { ensureLeaderTab: vi.fn(async () => {}) });
    p._rx({ kind: 'hello' });
    setCherryPanelJoinUrl('https://tray/join/t.s');
    setCherryPanelJoinUrl(null);
    expect(p._sent).toContainEqual({ kind: 'join-url', state: 'disconnected' });
  });

  it('broadcastLeaderGone → disconnected', async () => {
    const p = fakePort();
    await handleCherryPanelConnect(p as never, { ensureLeaderTab: vi.fn(async () => {}) });
    p._rx({ kind: 'hello' });
    broadcastLeaderGone();
    expect(p._sent).toContainEqual({ kind: 'join-url', state: 'disconnected' });
  });

  it('a late-connecting panel gets the latest state (ready) after its hello', async () => {
    setCherryPanelJoinUrl('https://tray/join/late.9');
    const p = fakePort();
    await handleCherryPanelConnect(p as never, { ensureLeaderTab: vi.fn(async () => {}) });
    expect(p._sent).toEqual([]);
    p._rx({ kind: 'hello' });
    expect(p._sent).toContainEqual({
      kind: 'join-url',
      state: 'ready',
      joinUrl: 'https://tray/join/late.9',
    });
  });

  it('drops the port from the set on disconnect (no throw on later broadcast)', async () => {
    const p = fakePort();
    await handleCherryPanelConnect(p as never, { ensureLeaderTab: vi.fn(async () => {}) });
    p._drop();
    expect(() => setCherryPanelJoinUrl('https://tray/join/x.1')).not.toThrow();
  });

  it('reconnect after disconnected transitions back to booting (not stuck disconnected)', async () => {
    broadcastLeaderGone();
    const p = fakePort();
    await handleCherryPanelConnect(p as never, { ensureLeaderTab: vi.fn(async () => {}) });

    expect(getPanelState()).toEqual({ kind: 'join-url', state: 'booting' });

    p._rx({ kind: 'hello' });
    expect(p._sent).toContainEqual({ kind: 'join-url', state: 'booting' });
    expect(p._sent).not.toContainEqual({ kind: 'join-url', state: 'disconnected' });
  });

  it('adds the port to the broadcast set on hello (later broadcasts reach it)', async () => {
    const ensureLeaderTab = vi.fn(async () => {});
    const p = fakePort();
    await handleCherryPanelConnect(p as never, { ensureLeaderTab });
    p._rx({ kind: 'hello' });
    expect(() => setCherryPanelJoinUrl('https://tray/join/y.2')).not.toThrow();
    expect(p._sent).toContainEqual({
      kind: 'join-url',
      state: 'ready',
      joinUrl: 'https://tray/join/y.2',
    });
  });

  it('tray-gave-up disconnected: reloads the existing leader once (bounded)', async () => {
    setCherryPanelJoinUrl('https://tray/join/t.s');
    setCherryPanelJoinUrl(null);
    const ensureLeaderTab = vi.fn(async () => {});
    const reloadLeaderTabIfExists = vi.fn(async () => true);
    const p1 = fakePort();
    await handleCherryPanelConnect(p1 as never, { ensureLeaderTab, reloadLeaderTabIfExists });
    expect(reloadLeaderTabIfExists).toHaveBeenCalledTimes(1);
    const p2 = fakePort();
    await handleCherryPanelConnect(p2 as never, { ensureLeaderTab, reloadLeaderTabIfExists });
    expect(reloadLeaderTabIfExists).toHaveBeenCalledTimes(1);
  });

  it('tab-removed disconnected: recreates via ensureLeaderTab, does NOT reload', async () => {
    broadcastLeaderGone();
    const ensureLeaderTab = vi.fn(async () => {});
    const reloadLeaderTabIfExists = vi.fn(async () => true);
    const p = fakePort();
    await handleCherryPanelConnect(p as never, { ensureLeaderTab, reloadLeaderTabIfExists });
    expect(ensureLeaderTab).toHaveBeenCalledTimes(1);
    expect(reloadLeaderTabIfExists).not.toHaveBeenCalled();
  });

  it('tray-gave-up reloads the leader with NO panel open (panel-independent recovery)', async () => {
    const reloadLeaderTabIfExists = vi.fn(async () => true);
    setCherryPanelRecoveryDeps({ reloadLeaderTabIfExists });

    setCherryPanelJoinUrl('https://tray/join/bg.1');
    setCherryPanelJoinUrl(null);

    expect(reloadLeaderTabIfExists).toHaveBeenCalledTimes(1);

    setCherryPanelJoinUrl('https://tray/join/bg.2');
    setCherryPanelJoinUrl(null);
    expect(reloadLeaderTabIfExists).toHaveBeenCalledTimes(1);
  });

  it('restores a ready state after an SW eviction (does NOT reset to booting)', async () => {
    mockStorageSession();
    setCherryPanelJoinUrl('https://tray/join/persist.1');

    resetCherryPanelState();
    const p = fakePort();
    await handleCherryPanelConnect(p as never, { ensureLeaderTab: vi.fn(async () => {}) });
    p._rx({ kind: 'hello' });

    expect(p._sent).toContainEqual({
      kind: 'join-url',
      state: 'ready',
      joinUrl: 'https://tray/join/persist.1',
    });
    expect(p._sent).not.toContainEqual({ kind: 'join-url', state: 'booting' });
  });

  it('restores a disconnected(tray-gave-up) state after eviction so recovery can fire', async () => {
    const store = mockStorageSession();
    setCherryPanelJoinUrl('https://tray/join/gone.1');
    setCherryPanelJoinUrl(null);
    expect((store.cherryPanelState as any).hasSeenReady).toBe(true);

    resetCherryPanelState();
    const reloadLeaderTabIfExists = vi.fn(async () => true);
    const p = fakePort();
    await handleCherryPanelConnect(p as never, {
      ensureLeaderTab: vi.fn(async () => {}),
      reloadLeaderTabIfExists,
    });
    expect(reloadLeaderTabIfExists).toHaveBeenCalledTimes(1);
  });
});
