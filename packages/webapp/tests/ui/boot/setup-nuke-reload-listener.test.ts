import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NUKE_CONTROL_CHANNEL } from '../../../src/shell/supplemental-commands/nuke-channel.js';
import {
  __resetNukeReloadListenerForTest,
  setupNukeReloadListener,
} from '../../../src/ui/boot/setup-nuke-reload-listener.js';

function installBroadcastChannelPolyfill(): { cleanup: () => void; listenerCount: () => number } {
  const channels = new Map<string, Set<FakeChannel>>();
  let listeners = 0;
  class FakeChannel {
    name: string;
    private bound = new Set<(ev: { data: unknown }) => void>();
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    constructor(name: string) {
      this.name = name;
      let group = channels.get(name);
      if (!group) {
        group = new Set();
        channels.set(name, group);
      }
      group.add(this);
    }
    postMessage(data: unknown): void {
      const peers = channels.get(this.name);
      if (!peers) return;
      for (const peer of peers) {
        if (peer === this) continue;
        peer.bound.forEach((cb) => {
          cb({ data });
        });
        peer.onmessage?.({ data });
      }
    }
    addEventListener(_type: 'message', cb: (ev: { data: unknown }) => void): void {
      this.bound.add(cb);
      listeners++;
    }
    removeEventListener(_type: 'message', cb: (ev: { data: unknown }) => void): void {
      if (this.bound.delete(cb)) listeners--;
    }
    close(): void {
      listeners -= this.bound.size;
      this.bound.clear();
      channels.get(this.name)?.delete(this);
    }
  }
  vi.stubGlobal('BroadcastChannel', FakeChannel);
  return {
    cleanup: () => {
      channels.clear();
      vi.unstubAllGlobals();
    },
    listenerCount: () => listeners,
  };
}

describe('setupNukeReloadListener', () => {
  let bc: ReturnType<typeof installBroadcastChannelPolyfill> | null = null;

  beforeEach(() => {
    bc = installBroadcastChannelPolyfill();
    vi.stubGlobal('location', { reload: vi.fn() });
    vi.stubGlobal('localStorage', { removeItem: vi.fn() });
  });

  afterEach(() => {
    __resetNukeReloadListenerForTest();
    bc?.cleanup();
    bc = null;
  });

  it('installs the page-side listener so a nuke-reload broadcast triggers location.reload()', () => {
    setupNukeReloadListener();
    const sender = new BroadcastChannel(NUKE_CONTROL_CHANNEL);
    sender.postMessage({ type: 'nuke-reload' });
    sender.close();
    expect((location.reload as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('is idempotent: repeat calls do not stack listeners or double-fire the reload', () => {
    setupNukeReloadListener();
    setupNukeReloadListener();
    setupNukeReloadListener();

    expect(bc?.listenerCount()).toBe(1);
    const sender = new BroadcastChannel(NUKE_CONTROL_CHANNEL);
    sender.postMessage({ type: 'nuke-reload' });
    sender.close();
    expect((location.reload as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('returns the same dispose handle across repeat calls', () => {
    const first = setupNukeReloadListener();
    const second = setupNukeReloadListener();
    expect(second).toBe(first);
  });
});
