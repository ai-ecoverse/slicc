import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  broadcastLeaderGone,
  getPanelState,
  handleCherryPanelConnect,
  resetCherryPanelState,
  setCherryPanelJoinUrl,
} from '../src/cherry-panel-sw.js';

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

  it('on connect: does NOT post before hello; replies with current state (booting) after hello', async () => {
    const ensureLeaderTab = vi.fn(async () => {});
    const p = fakePort();
    await handleCherryPanelConnect(p as never, { ensureLeaderTab });
    expect(p._sent).toEqual([]); // race-safe: nothing posted before the panel's hello
    p._rx({ kind: 'hello', windowId: 3 });
    expect(ensureLeaderTab).toHaveBeenCalledTimes(1);
    expect(p._sent).toContainEqual({ kind: 'join-url', state: 'booting' });
  });

  it('setCherryPanelJoinUrl(string) broadcasts ready to connected panels', async () => {
    const p = fakePort();
    await handleCherryPanelConnect(p as never, { ensureLeaderTab: vi.fn(async () => {}) });
    p._rx({ kind: 'hello', windowId: 3 });
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
    p._rx({ kind: 'hello', windowId: 3 });
    setCherryPanelJoinUrl(null); // leader still coming up, never had a joinUrl
    expect(getPanelState()).toEqual({ kind: 'join-url', state: 'booting' });
    expect(p._sent).not.toContainEqual({ kind: 'join-url', state: 'disconnected' });
  });

  it('setCherryPanelJoinUrl(null) AFTER a ready → disconnected', async () => {
    const p = fakePort();
    await handleCherryPanelConnect(p as never, { ensureLeaderTab: vi.fn(async () => {}) });
    p._rx({ kind: 'hello', windowId: 3 });
    setCherryPanelJoinUrl('https://tray/join/t.s');
    setCherryPanelJoinUrl(null);
    expect(p._sent).toContainEqual({ kind: 'join-url', state: 'disconnected' });
  });

  it('broadcastLeaderGone → disconnected', async () => {
    const p = fakePort();
    await handleCherryPanelConnect(p as never, { ensureLeaderTab: vi.fn(async () => {}) });
    p._rx({ kind: 'hello', windowId: 3 });
    broadcastLeaderGone();
    expect(p._sent).toContainEqual({ kind: 'join-url', state: 'disconnected' });
  });

  it('a late-connecting panel gets the latest state (ready) after its hello', async () => {
    setCherryPanelJoinUrl('https://tray/join/late.9');
    const p = fakePort();
    await handleCherryPanelConnect(p as never, { ensureLeaderTab: vi.fn(async () => {}) });
    expect(p._sent).toEqual([]); // nothing before hello
    p._rx({ kind: 'hello', windowId: 1 });
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
    broadcastLeaderGone(); // global state = disconnected
    const p = fakePort();
    await handleCherryPanelConnect(p as never, { ensureLeaderTab: vi.fn(async () => {}) });
    // connect moved the global state disconnected → booting
    expect(getPanelState()).toEqual({ kind: 'join-url', state: 'booting' });
    // the freshly connected panel receives booting via its hello replay (not disconnected)
    p._rx({ kind: 'hello', windowId: 1 });
    expect(p._sent).toContainEqual({ kind: 'join-url', state: 'booting' });
    expect(p._sent).not.toContainEqual({ kind: 'join-url', state: 'disconnected' });
  });

  it('records the panel windowId from hello (used by the fallback toggle path)', async () => {
    const ensureLeaderTab = vi.fn(async () => {});
    const p = fakePort();
    await handleCherryPanelConnect(p as never, { ensureLeaderTab });
    p._rx({ kind: 'hello', windowId: 42 });
    // A later broadcast still reaches the (windowId-tagged) port without throwing.
    expect(() => setCherryPanelJoinUrl('https://tray/join/y.2')).not.toThrow();
    expect(p._sent).toContainEqual({
      kind: 'join-url',
      state: 'ready',
      joinUrl: 'https://tray/join/y.2',
    });
  });

  it('tray-gave-up disconnected: reloads the existing leader once (bounded)', async () => {
    setCherryPanelJoinUrl('https://tray/join/t.s'); // establish (hasSeenReady = true)
    setCherryPanelJoinUrl(null); // tray reconnect gave up while the tab still exists → disconnected
    const ensureLeaderTab = vi.fn(async () => {}); // no-op: tab exists
    const reloadLeaderTabIfExists = vi.fn(async () => true);
    const p1 = fakePort();
    await handleCherryPanelConnect(p1 as never, { ensureLeaderTab, reloadLeaderTabIfExists });
    expect(reloadLeaderTabIfExists).toHaveBeenCalledTimes(1); // forced a fresh tray join
    const p2 = fakePort(); // second connect in the same episode does NOT reload again
    await handleCherryPanelConnect(p2 as never, { ensureLeaderTab, reloadLeaderTabIfExists });
    expect(reloadLeaderTabIfExists).toHaveBeenCalledTimes(1);
  });

  it('tab-removed disconnected: recreates via ensureLeaderTab, does NOT reload', async () => {
    broadcastLeaderGone(); // leader tab was closed
    const ensureLeaderTab = vi.fn(async () => {}); // creates a fresh leader tab
    const reloadLeaderTabIfExists = vi.fn(async () => true);
    const p = fakePort();
    await handleCherryPanelConnect(p as never, { ensureLeaderTab, reloadLeaderTabIfExists });
    expect(ensureLeaderTab).toHaveBeenCalledTimes(1);
    expect(reloadLeaderTabIfExists).not.toHaveBeenCalled(); // don't reload a brand-new tab
  });
});
