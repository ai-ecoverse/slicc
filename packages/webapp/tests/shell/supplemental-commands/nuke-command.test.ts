import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createNukeCommand,
  installNukeReloadListener,
  NUKE_CONTROL_CHANNEL,
  NUKE_LOCAL_STORAGE_KEYS,
} from '../../../src/shell/supplemental-commands/nuke-command.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

const createMockCtx = () => mockCommandContext({ cwd: '/' });

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
        peer.listeners.forEach((cb) => {
          cb({ data });
        });
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
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistrations: async () => [] },
      storage: {
        // Default to "no OPFS in this env": tests that exercise the
        // OPFS-wipe path install their own stub via vi.stubGlobal.
        getDirectory: undefined,
      },
    });
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

  it('forwards localStorage keys to clear in the broadcast (worker→page propagation)', async () => {
    // The shell side does NOT itself clear localStorage — the worker's
    // shim wouldn't propagate to the page. Instead it publishes the
    // keys via the broadcast and the page-side listener applies them.
    // See the doc comment on `NukeReloadMsg` for the full rationale.
    const lsRemove = vi.fn();
    vi.stubGlobal('localStorage', {
      removeItem: lsRemove,
      getItem: () => null,
      setItem: vi.fn(),
    });

    const onReload = vi.fn();
    const dispose = installNukeReloadListener(onReload);

    const cmd = createNukeCommand();
    await cmd.execute(['1234'], createMockCtx());
    await new Promise((r) => setTimeout(r, 10));

    // The listener should have removed each declared key and then
    // fired the reload callback exactly once.
    for (const key of NUKE_LOCAL_STORAGE_KEYS) {
      expect(lsRemove).toHaveBeenCalledWith(key);
    }
    expect(onReload).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('exposes the channel name as a constant', () => {
    expect(NUKE_CONTROL_CHANNEL).toBe('slicc-nuke-control');
  });

  it('declares the keys that gate the welcome flow on next boot', () => {
    // The welcome wiring in `mainStandaloneWorker` /` mainExtension`
    // skips first-run detection when a tray-join URL is stored
    // (`if (!hasStoredTrayJoinUrl(...))`). After nuke wipes IDB the
    // stale URL would point at a peer this tab can no longer follow,
    // AND would suppress welcome — both keys must be in the list.
    expect(NUKE_LOCAL_STORAGE_KEYS).toContain('slicc:welcome-flow-fired');
    expect(NUKE_LOCAL_STORAGE_KEYS).toContain('slicc.trayJoinUrl');
    expect(NUKE_LOCAL_STORAGE_KEYS).toContain('slicc.trayWorkerBaseUrl');
  });

  it('recursively removes every OPFS root entry on the launch-code path', async () => {
    // Post-ZenFS/OPFS migration the bulk of local state lives in OPFS
    // (workspace files, scoops, mounts). Without this wipe a nuke
    // would leave the prior workspace on disk and the user would
    // boot back into stale state.
    const removeEntry = vi.fn(async (_name: string, _opts?: { recursive: boolean }) => undefined);
    const entries = ['slicc-fs', 'slicc-fs-global', 'leftover-mount'];
    async function* keys(): AsyncIterableIterator<string> {
      for (const name of entries) yield name;
    }
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistrations: async () => [] },
      storage: {
        getDirectory: async () => ({ keys, removeEntry }),
      },
    });

    const dispose = installNukeReloadListener(() => {});
    const cmd = createNukeCommand();
    await cmd.execute(['1234'], createMockCtx());
    await new Promise((r) => setTimeout(r, 10));

    expect(removeEntry).toHaveBeenCalledTimes(entries.length);
    for (const name of entries) {
      expect(removeEntry).toHaveBeenCalledWith(name, { recursive: true });
    }
    dispose();
  });

  it('still reloads cleanly when OPFS is unavailable', async () => {
    // No `navigator.storage.getDirectory` (older browsers / some test
    // envs). The wipe block must be best-effort and never block the
    // reload broadcast — otherwise the user is stranded on a half-
    // nuked instance.
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistrations: async () => [] },
      storage: {},
    });

    const onReload = vi.fn();
    const dispose = installNukeReloadListener(onReload);
    const cmd = createNukeCommand();
    const result = await cmd.execute(['1234'], createMockCtx());
    await new Promise((r) => setTimeout(r, 10));

    expect(result.exitCode).toBe(0);
    expect(onReload).toHaveBeenCalledTimes(1);
    dispose();
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
