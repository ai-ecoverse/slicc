import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IFileSystem } from 'just-bash';
import {
  createNukeCommand,
  installNukeReloadListener,
  NUKE_CONTROL_CHANNEL,
} from '../../../src/shell/supplemental-commands/nuke-command.js';

function createMockCtx() {
  const fs: Partial<IFileSystem> = {
    resolvePath: (base: string, path: string) => (path.startsWith('/') ? path : `${base}/${path}`),
  };
  return {
    fs: fs as IFileSystem,
    cwd: '/',
    env: new Map<string, string>(),
    stdin: '',
  };
}

/**
 * Minimal in-memory BroadcastChannel polyfill scoped to a single test.
 * `happy-dom` ships one but the shell tests run in `node` env. Only
 * the methods nuke-command + installNukeReloadListener call are
 * implemented.
 */
function installBroadcastChannelPolyfill(): { cleanup: () => void } {
  const channels = new Map<string, Set<FakeChannel>>();
  class FakeChannel {
    name: string;
    private listeners = new Set<(ev: { data: unknown }) => void>();
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
        peer.listeners.forEach((cb) => cb({ data }));
        peer.onmessage?.({ data });
      }
    }
    addEventListener(_type: 'message', cb: (ev: { data: unknown }) => void): void {
      this.listeners.add(cb);
    }
    removeEventListener(_type: 'message', cb: (ev: { data: unknown }) => void): void {
      this.listeners.delete(cb);
    }
    close(): void {
      this.listeners.clear();
      channels.get(this.name)?.delete(this);
    }
  }
  vi.stubGlobal('BroadcastChannel', FakeChannel);
  return {
    cleanup: () => {
      channels.clear();
      vi.unstubAllGlobals();
    },
  };
}

describe('nuke command', () => {
  let bc: { cleanup: () => void } | null = null;

  beforeEach(() => {
    bc = installBroadcastChannelPolyfill();
    // A minimal indexedDB stub: dbs() returns nothing so the wipe loop is a no-op.
    vi.stubGlobal('indexedDB', {
      databases: async () => [],
      deleteDatabase: () => ({
        onsuccess: null,
        onerror: null,
        onblocked: null,
      }),
    });
    vi.stubGlobal('navigator', { serviceWorker: { getRegistrations: async () => [] } });
    vi.stubGlobal('localStorage', {
      removeItem: vi.fn(),
      getItem: () => null,
      setItem: vi.fn(),
    });
  });

  afterEach(() => {
    bc?.cleanup();
    bc = null;
  });

  it('shows help with --help', async () => {
    const cmd = createNukeCommand();
    const result = await cmd.execute(['--help'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: nuke');
  });

  it('refuses without the launch code', async () => {
    const cmd = createNukeCommand();
    const result = await cmd.execute([], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('WARNING');
  });

  it('broadcasts a nuke-reload request when run with the launch code', async () => {
    const received: unknown[] = [];
    const dispose = installNukeReloadListener(() => received.push('reload-fired'));

    const cmd = createNukeCommand();
    const result = await cmd.execute(['1234'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Nuking');

    // The wipe + broadcast happens in a fire-and-forget async IIFE.
    // Wait for microtasks + the indexedDB.databases() promise to settle.
    await new Promise((r) => setTimeout(r, 10));

    expect(received).toEqual(['reload-fired']);
    dispose();
  });

  it('exposes the channel name as a constant', () => {
    expect(NUKE_CONTROL_CHANNEL).toBe('slicc-nuke-control');
  });
});

describe('installNukeReloadListener', () => {
  let bc: { cleanup: () => void } | null = null;

  beforeEach(() => {
    bc = installBroadcastChannelPolyfill();
  });

  afterEach(() => {
    bc?.cleanup();
    bc = null;
  });

  it('invokes the callback when a nuke-reload message arrives', () => {
    const cb = vi.fn();
    const dispose = installNukeReloadListener(cb);
    const sender = new BroadcastChannel(NUKE_CONTROL_CHANNEL);
    sender.postMessage({ type: 'nuke-reload' });
    sender.close();
    expect(cb).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('ignores unrelated messages', () => {
    const cb = vi.fn();
    const dispose = installNukeReloadListener(cb);
    const sender = new BroadcastChannel(NUKE_CONTROL_CHANNEL);
    sender.postMessage({ type: 'something-else' });
    sender.close();
    expect(cb).not.toHaveBeenCalled();
    dispose();
  });

  it('returns a no-op disposer when BroadcastChannel is unavailable', () => {
    bc?.cleanup();
    bc = null;
    vi.stubGlobal('BroadcastChannel', undefined);
    const cb = vi.fn();
    const dispose = installNukeReloadListener(cb);
    expect(() => dispose()).not.toThrow();
    vi.unstubAllGlobals();
  });
});
