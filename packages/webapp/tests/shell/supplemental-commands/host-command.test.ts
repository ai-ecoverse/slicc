import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FollowerTrayRuntimeStatus } from '../../../src/scoops/tray-follower-status.js';
import {
  createHostCommand,
  formatDuration,
  formatFollowerOutput,
  formatLeaderOutput,
  getConnectedFollowersWithFallback,
  setConnectedFollowersGetter,
  writeConnectedFollowersToShim,
} from '../../../src/shell/supplemental-commands/host-command.js';

/** Helper to build a FollowerTrayRuntimeStatus with sensible defaults for the new diagnostic fields. */
function followerStatus(
  overrides: Partial<FollowerTrayRuntimeStatus> & Pick<FollowerTrayRuntimeStatus, 'state'>
): FollowerTrayRuntimeStatus {
  return {
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

describe('host command', () => {
  it('has the correct name', () => {
    expect(createHostCommand().name).toBe('host');
  });

  it('shows help with --help', async () => {
    const result = await createHostCommand().execute(['--help'], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('display or manage the current tray host status');
  });

  it('prints the leader status and join URL', async () => {
    const cmd = createHostCommand({
      getStatus: () => ({
        state: 'leader',
        session: {
          workerBaseUrl: 'https://tray.example.com/base',
          trayId: 'tray-123',
          createdAt: '2026-03-12T00:00:00.000Z',
          controllerId: 'controller-1',
          controllerUrl: 'https://tray.example.com/controller/controller-1',
          joinUrl: 'https://tray.example.com/join/tray-123',
          webhookUrl: 'https://tray.example.com/webhooks/tray-123',
          leaderKey: 'leader-key',
          leaderWebSocketUrl: 'wss://tray.example.com/ws',
          runtime: 'slicc-standalone',
        },
        error: null,
      }),
      getFollowers: () => [],
    });

    const result = await cmd.execute([], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('status: leader');
    expect(result.stdout).toContain('join_url: https://tray.example.com/join/tray-123');
    expect(result.stdout).not.toContain('launch_url');
    expect(result.stdout).not.toContain('webhook_url');
    expect(result.stdout).not.toContain('worker_base_url');
    expect(result.stdout).not.toContain('tray_id');
  });

  it('shows followers when connected', async () => {
    const cmd = createHostCommand({
      getStatus: () => ({
        state: 'leader',
        session: {
          workerBaseUrl: 'https://tray.example.com/base',
          trayId: 'tray-123',
          createdAt: '2026-03-12T00:00:00.000Z',
          controllerId: 'controller-1',
          controllerUrl: 'https://tray.example.com/controller/controller-1',
          joinUrl: 'https://tray.example.com/join/tray-123',
          webhookUrl: 'https://tray.example.com/webhooks/tray-123',
          leaderKey: 'leader-key',
          leaderWebSocketUrl: 'wss://tray.example.com/ws',
          runtime: 'slicc-standalone',
        },
        error: null,
      }),
      getFollowers: () => [{ runtimeId: 'follower-abc123' }, { runtimeId: 'follower-def456' }],
    });

    const result = await cmd.execute([], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('followers:');
    expect(result.stdout).toContain('  - follower-abc123');
    expect(result.stdout).toContain('  - follower-def456');
  });

  it('does not list stale followers when there is no active session (inactive)', async () => {
    // The followers shim persists across sessions; once the leader is inactive
    // (no tray session), a leftover entry must not be shown as if connected.
    const cmd = createHostCommand({
      getStatus: () => ({ state: 'inactive', session: null, error: null }),
      getFollowers: () => [
        { runtimeId: 'follower-stale', connectedAt: '2026-06-22T07:00:00.000Z' },
      ],
    });

    const result = await cmd.execute([], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('status: inactive');
    expect(result.stdout).not.toContain('followers:');
    expect(result.stdout).not.toContain('follower-stale');
  });

  it('mirrors connected followers to the shim so a worker-side host reads them', () => {
    // Kernel-worker thread: no live getter, only the page→worker
    // localStorage shim is available. Before the page-side writer was
    // restored, nothing populated this key, so worker-side `host` never
    // showed live followers.
    setConnectedFollowersGetter(null);
    const store = new Map<string, string>();
    const fakeLs = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    } as unknown as Storage;
    const original = (globalThis as { localStorage?: Storage }).localStorage;
    (globalThis as { localStorage?: Storage }).localStorage = fakeLs;
    try {
      const followers = [
        {
          runtimeId: 'follower-abc123',
          runtime: 'slicc-extension-offscreen',
          connectedAt: '2026-06-16T00:00:00.000Z',
        },
      ];
      // Page side mirrors the live list into the shim.
      writeConnectedFollowersToShim(followers);
      // Worker side reads it back via the shim fallback.
      expect(getConnectedFollowersWithFallback()).toEqual(followers);
    } finally {
      if (original === undefined) delete (globalThis as { localStorage?: Storage }).localStorage;
      else (globalThis as { localStorage?: Storage }).localStorage = original;
    }
  });

  it('writing an empty follower list clears a stale shim value', () => {
    setConnectedFollowersGetter(null);
    const store = new Map<string, string>([
      [
        'slicc.leaderTrayFollowers',
        JSON.stringify([{ runtimeId: 'stale-follower', connectedAt: '2026-06-14T00:00:00.000Z' }]),
      ],
    ]);
    const fakeLs = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    } as unknown as Storage;
    const original = (globalThis as { localStorage?: Storage }).localStorage;
    (globalThis as { localStorage?: Storage }).localStorage = fakeLs;
    try {
      writeConnectedFollowersToShim([]);
      expect(getConnectedFollowersWithFallback()).toEqual([]);
    } finally {
      if (original === undefined) delete (globalThis as { localStorage?: Storage }).localStorage;
      else (globalThis as { localStorage?: Storage }).localStorage = original;
    }
  });

  it('prints error details when leader startup failed', async () => {
    const result = await createHostCommand({
      getStatus: () => ({ state: 'error', session: null, error: 'boom' }),
      getFollowers: () => [],
    }).execute([], {} as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('status: error\njoin_url: unavailable\nerror: boom\n');
  });

  it('still rejects unknown arguments', async () => {
    const result = await createHostCommand().execute(['nope'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('host: unsupported arguments\n');
  });

  it('host reset calls resetTray and prints new status', async () => {
    const newSession = {
      workerBaseUrl: 'https://tray.example.com/base',
      trayId: 'tray-new-456',
      createdAt: '2026-03-16T00:00:00.000Z',
      controllerId: 'controller-2',
      controllerUrl: 'https://tray.example.com/controller/controller-2',
      joinUrl: 'https://tray.example.com/join/new-token',
      webhookUrl: 'https://tray.example.com/webhooks/tray-new-456',
      leaderKey: 'new-leader-key',
      leaderWebSocketUrl: 'wss://tray.example.com/ws-new',
      runtime: 'slicc-standalone',
    };
    let resetCalled = false;
    const cmd = createHostCommand({
      getStatus: () => ({ state: 'leader', session: newSession, error: null }),
      getFollowerStatus: () => followerStatus({ state: 'inactive' }),
      getFollowers: () => [],
      resetTray: async () => {
        resetCalled = true;
        return { state: 'leader', session: newSession, error: null };
      },
    });

    const result = await cmd.execute(['reset'], {} as never);
    expect(resetCalled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Tray session reset. All followers disconnected.');
    expect(result.stdout).toContain('join_url: https://tray.example.com/join/new-token');
    expect(result.stdout).toContain('status: leader');
  });

  it('host reset errors when follower is active', async () => {
    const cmd = createHostCommand({
      getFollowerStatus: () =>
        followerStatus({
          state: 'connected',
          joinUrl: 'https://tray.example.com/join/token',
        }),
      resetTray: async () => ({ state: 'leader', session: null, error: null }),
    });

    const result = await cmd.execute(['reset'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('only the leader can reset');
  });

  it('host reset errors when no active tray session', async () => {
    const cmd = createHostCommand({
      getStatus: () => ({ state: 'inactive', session: null, error: null }),
      getFollowerStatus: () => followerStatus({ state: 'inactive' }),
      resetTray: async () => ({ state: 'leader', session: null, error: null }),
    });

    const result = await cmd.execute(['reset'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no active tray session to reset');
  });

  it('host reset errors when resetTray is not wired', async () => {
    const cmd = createHostCommand({
      getStatus: () => ({ state: 'leader', session: null, error: null }),
      getFollowerStatus: () => followerStatus({ state: 'inactive' }),
      // resetTray not provided
    });

    const result = await cmd.execute(['reset'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not available in this environment');
  });

  it('host reset handles errors from resetTray gracefully', async () => {
    const cmd = createHostCommand({
      getStatus: () => ({ state: 'leader', session: null, error: null }),
      getFollowerStatus: () => followerStatus({ state: 'inactive' }),
      resetTray: async () => {
        throw new Error('POST /tray failed');
      },
    });

    const result = await cmd.execute(['reset'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('POST /tray failed');
  });

  it('shows follower status when follower is connected', async () => {
    const result = await createHostCommand({
      getFollowerStatus: () =>
        followerStatus({
          state: 'connected',
          joinUrl: 'https://tray.example.com/join/token',
          trayId: 'tray-456',
        }),
    }).execute([], {} as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('status: follower (connected)');
    expect(result.stdout).toContain('join_url: https://tray.example.com/join/token');
    expect(result.stdout).not.toContain('tray_id');
  });

  it('shows follower connecting status', async () => {
    const result = await createHostCommand({
      getFollowerStatus: () =>
        followerStatus({
          state: 'connecting',
          joinUrl: 'https://tray.example.com/join/token',
        }),
    }).execute([], {} as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('status: follower (connecting)');
    expect(result.stdout).toContain('join_url: https://tray.example.com/join/token');
    expect(result.stdout).not.toContain('tray_id');
  });

  it('shows follower connecting diagnostics', async () => {
    const now = Date.now();
    const result = await createHostCommand({
      getFollowerStatus: () =>
        followerStatus({
          state: 'connecting',
          joinUrl: 'https://tray.example.com/join/token',
          connectingSince: now - 15000,
          attachAttempts: 7,
          lastAttachCode: 'LEADER_NOT_CONNECTED',
        }),
    }).execute([], {} as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('status: follower (connecting)');
    expect(result.stdout).toContain('connecting_for: 15s');
    expect(result.stdout).toContain('attach_attempts: 7');
    expect(result.stdout).toContain('last_code: LEADER_NOT_CONNECTED');
  });

  it('shows follower error status', async () => {
    const result = await createHostCommand({
      getFollowerStatus: () =>
        followerStatus({
          state: 'error',
          joinUrl: 'https://tray.example.com/join/token',
          error: 'WebRTC failed',
        }),
    }).execute([], {} as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('status: follower (error)');
    expect(result.stdout).toContain('error: WebRTC failed');
  });

  it('falls back to leader status when follower is inactive', async () => {
    const result = await createHostCommand({
      getFollowerStatus: () => followerStatus({ state: 'inactive' }),
      getStatus: () => ({ state: 'inactive', session: null, error: null }),
      getFollowers: () => [],
    }).execute([], {} as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('status: inactive');
    expect(result.stdout).not.toContain('follower');
  });

  it('shows last_ping when follower is connected with lastPingTime', async () => {
    const now = Date.now();
    const result = await createHostCommand({
      getFollowerStatus: () =>
        followerStatus({
          state: 'connected',
          joinUrl: 'https://tray.example.com/join/token',
          trayId: 'tray-456',
          lastPingTime: now - 5000,
        }),
    }).execute([], {} as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('last_ping:');
    expect(result.stdout).toContain('s ago');
  });

  it('shows reconnect_attempts when follower is reconnecting', async () => {
    const result = await createHostCommand({
      getFollowerStatus: () =>
        followerStatus({
          state: 'reconnecting',
          joinUrl: 'https://tray.example.com/join/token',
          trayId: 'tray-456',
          lastPingTime: Date.now() - 30000,
          reconnectAttempts: 3,
        }),
    }).execute([], {} as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('status: follower (reconnecting)');
    expect(result.stdout).toContain('reconnect_attempts: 3');
  });

  describe('localStorage fallback (standalone-worker path)', () => {
    // Install a Map-backed localStorage shim matching the kernel worker's shim
    // so fallback reads work in the Node test environment (no real localStorage).
    beforeEach(() => {
      const store = new Map<string, string>();
      const shim: Storage = {
        get length() {
          return store.size;
        },
        key: (i) => Array.from(store.keys())[i] ?? null,
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => {
          store.set(k, v);
        },
        removeItem: (k) => {
          store.delete(k);
        },
        clear: () => {
          store.clear();
        },
      };
      Object.defineProperty(globalThis, 'localStorage', {
        value: shim,
        configurable: true,
        writable: true,
      });
    });

    afterEach(() => {
      delete (globalThis as Record<string, unknown>).localStorage;
    });

    it('reads leader status from localStorage when module global is inactive', async () => {
      (globalThis as { localStorage?: Storage }).localStorage?.setItem(
        'slicc.leaderTrayStatus',
        JSON.stringify({
          state: 'leader',
          session: {
            workerBaseUrl: 'https://tray.example.com',
            trayId: 'tray-ls-1',
            createdAt: '2026-01-01T00:00:00.000Z',
            controllerId: 'ctrl-1',
            controllerUrl: 'https://tray.example.com/ctrl/ctrl-1',
            joinUrl: 'https://tray.example.com/join/tray-ls-1',
            webhookUrl: 'https://tray.example.com/webhooks/tray-ls-1',
            leaderKey: 'lk',
            leaderWebSocketUrl: 'wss://tray.example.com/ws',
            runtime: 'slicc-standalone',
          },
          error: null,
        })
      );

      // createHostCommand with no options → uses getLeaderStatusWithFallback
      const result = await createHostCommand().execute([], {} as never);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('status: leader');
      expect(result.stdout).toContain('join_url: https://tray.example.com/join/tray-ls-1');
    });

    it('reads followers from localStorage when module getter is not set', async () => {
      (globalThis as { localStorage?: Storage }).localStorage?.setItem(
        'slicc.leaderTrayStatus',
        JSON.stringify({
          state: 'leader',
          session: {
            workerBaseUrl: 'https://tray.example.com',
            trayId: 'tray-ls-2',
            createdAt: '2026-01-01T00:00:00.000Z',
            controllerId: 'ctrl-2',
            controllerUrl: 'https://tray.example.com/ctrl/ctrl-2',
            joinUrl: 'https://tray.example.com/join/tray-ls-2',
            webhookUrl: 'https://tray.example.com/webhooks/tray-ls-2',
            leaderKey: 'lk',
            leaderWebSocketUrl: 'wss://tray.example.com/ws',
            runtime: 'slicc-standalone',
          },
          error: null,
        })
      );
      (globalThis as { localStorage?: Storage }).localStorage?.setItem(
        'slicc.leaderTrayFollowers',
        JSON.stringify([{ runtimeId: 'peer-from-storage' }])
      );

      const result = await createHostCommand().execute([], {} as never);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('followers:');
      expect(result.stdout).toContain('  - peer-from-storage');
    });

    it('returns inactive output when localStorage key is also inactive', async () => {
      (globalThis as { localStorage?: Storage }).localStorage?.setItem(
        'slicc.leaderTrayStatus',
        JSON.stringify({ state: 'inactive', session: null, error: null })
      );

      const result = await createHostCommand().execute([], {} as never);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('status: inactive');
    });

    it('reads follower status from localStorage when the module global is inactive', async () => {
      // The b268 bug: a connected follower's status lives in the page-side
      // module global, mirrored to `slicc.followerTrayStatus`. The worker-side
      // `host` (default reader) must consult that shim, otherwise it falls
      // through to the leader path and prints `status: inactive` while the
      // follower is genuinely connected (chat synced, screenshot worked).
      (globalThis as { localStorage?: Storage }).localStorage?.setItem(
        'slicc.followerTrayStatus',
        JSON.stringify({
          state: 'connected',
          joinUrl: 'https://www.sliccy.ai/join/abc.def',
          trayId: 'tray-follow-1',
          error: null,
          lastPingTime: null,
          reconnectAttempts: 0,
          attachAttempts: 0,
          lastAttachCode: null,
          connectingSince: null,
          lastError: null,
        })
      );

      // No getFollowerStatus override → must default to the fallback reader.
      const result = await createHostCommand().execute([], {} as never);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('status: follower (connected)');
      expect(result.stdout).toContain('join_url: https://www.sliccy.ai/join/abc.def');
    });
  });

  describe('host reset — panel-RPC bridge fallback (standalone-worker path)', () => {
    // The kernel worker's AlmostBashShell executes `host reset`. The worker's
    // module-level trayResetter is null (the page is the only side that
    // calls setTrayResetter). `getPanelRpcClient()` returns the bridge
    // client published as `globalThis.__slicc_panelRpc` by kernel-worker.ts;
    // we stub that here to assert the bridge fallback is used.

    function leaderStatusForBridge() {
      return {
        state: 'leader' as const,
        session: {
          workerBaseUrl: 'https://tray.example.com',
          trayId: 'tray-bridge-new',
          createdAt: '2026-05-17T00:00:00.000Z',
          controllerId: 'controller-1',
          controllerUrl: 'https://tray.example.com/controller/controller-1',
          joinUrl: 'https://tray.example.com/join/tray-bridge-new',
          webhookUrl: 'https://tray.example.com/webhooks/tray-bridge-new',
          leaderKey: 'leader-key',
          leaderWebSocketUrl: 'wss://tray.example.com/ws',
          runtime: 'slicc-standalone',
        },
        error: null,
      };
    }

    afterEach(() => {
      delete (globalThis as Record<string, unknown>).__slicc_panelRpc;
    });

    it('routes host reset through the panel-RPC client when no trayResetter is set', async () => {
      // No options.resetTray and no setTrayResetter() call — both the
      // explicit override and the module-level getter return undefined.
      // Bridge client is the only path left.
      const calls: Array<{ op: string; payload: unknown }> = [];
      (globalThis as Record<string, unknown>).__slicc_panelRpc = {
        call: async (op: string, payload: unknown) => {
          calls.push({ op, payload });
          return leaderStatusForBridge();
        },
        dispose: () => {},
      };

      const cmd = createHostCommand({
        // getStatus / getFollowerStatus stubbed so the precondition checks
        // (leader/follower state) pass and reset is actually attempted.
        getStatus: () => leaderStatusForBridge(),
        getFollowerStatus: () => ({
          state: 'inactive' as const,
          joinUrl: null,
          trayId: null,
          error: null,
          lastPingTime: null,
          reconnectAttempts: 0,
          attachAttempts: 0,
          lastAttachCode: null,
          connectingSince: null,
          lastError: null,
        }),
        getFollowers: () => [],
      });

      const result = await cmd.execute(['reset'], {} as never);
      expect(calls).toEqual([{ op: 'tray-reset', payload: undefined }]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Tray session reset. All followers disconnected.');
      expect(result.stdout).toContain('join_url: https://tray.example.com/join/tray-bridge-new');
    });

    it('surfaces panel-RPC errors as host reset failures', async () => {
      (globalThis as Record<string, unknown>).__slicc_panelRpc = {
        call: async () => {
          throw new Error('no active tray session to reset');
        },
        dispose: () => {},
      };

      const cmd = createHostCommand({
        getStatus: () => leaderStatusForBridge(),
        getFollowerStatus: () => ({
          state: 'inactive' as const,
          joinUrl: null,
          trayId: null,
          error: null,
          lastPingTime: null,
          reconnectAttempts: 0,
          attachAttempts: 0,
          lastAttachCode: null,
          connectingSince: null,
          lastError: null,
        }),
        getFollowers: () => [],
      });

      const result = await cmd.execute(['reset'], {} as never);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('host reset:');
      expect(result.stderr).toContain('no active tray session to reset');
    });

    it('still reports "not available in this environment" when neither resetter nor bridge is present', async () => {
      // No setTrayResetter() AND no panel-RPC client → resetter resolves
      // to undefined → existing error message stands.
      delete (globalThis as Record<string, unknown>).__slicc_panelRpc;
      const cmd = createHostCommand({
        getStatus: () => leaderStatusForBridge(),
        getFollowerStatus: () => ({
          state: 'inactive' as const,
          joinUrl: null,
          trayId: null,
          error: null,
          lastPingTime: null,
          reconnectAttempts: 0,
          attachAttempts: 0,
          lastAttachCode: null,
          connectingSince: null,
          lastError: null,
        }),
        getFollowers: () => [],
      });
      const result = await cmd.execute(['reset'], {} as never);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not available in this environment');
    });
  });

  describe('host leave', () => {
    it('calls leaveTray with workerBaseUrl=null and reports follower disconnect', async () => {
      const calls: Array<{ workerBaseUrl: string | null }> = [];
      const cmd = createHostCommand({
        getStatus: () => ({ state: 'inactive', session: null, error: null }),
        getFollowerStatus: () =>
          followerStatus({
            state: 'connected',
            joinUrl: 'https://tray.example.com/join/abc',
          }),
        leaveTray: async (opts) => {
          calls.push({ workerBaseUrl: opts.workerBaseUrl });
          return { kind: 'left', previousMode: 'follower' };
        },
      });
      const result = await cmd.execute(['leave'], {} as never);
      expect(calls).toEqual([{ workerBaseUrl: null }]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Disconnected from leader.');
      expect(result.stdout).toContain('Tray runtime is now dormant.');
    });

    it('calls leaveTray with workerBaseUrl and reports the new leader URL', async () => {
      const calls: Array<{ workerBaseUrl: string | null }> = [];
      const cmd = createHostCommand({
        getStatus: () => ({ state: 'inactive', session: null, error: null }),
        getFollowerStatus: () =>
          followerStatus({
            state: 'connected',
            joinUrl: 'https://tray.example.com/join/abc',
          }),
        leaveTray: async (opts) => {
          calls.push({ workerBaseUrl: opts.workerBaseUrl });
          return {
            kind: 'switched',
            previousMode: 'follower',
            workerBaseUrl: 'https://leader.example.com',
          };
        },
      });
      const result = await cmd.execute(
        ['leave', '--leader', 'https://leader.example.com'],
        {} as never
      );
      expect(calls).toEqual([{ workerBaseUrl: 'https://leader.example.com' }]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Disconnected from leader.');
      expect(result.stdout).toContain('Now leader on https://leader.example.com');
    });

    it('reports "Stopped leader." when previous mode was leader', async () => {
      const cmd = createHostCommand({
        getStatus: () => ({
          state: 'leader',
          session: {
            workerBaseUrl: 'https://x',
            trayId: 't',
            createdAt: 'now',
            controllerId: 'c',
            controllerUrl: 'https://x/c',
            joinUrl: 'https://x/join/t',
            webhookUrl: 'https://x/w/t',
            runtime: 'slicc-standalone',
          },
          error: null,
        }),
        getFollowerStatus: () => followerStatus({ state: 'inactive' }),
        leaveTray: async () => ({ kind: 'left', previousMode: 'leader' }),
      });
      const result = await cmd.execute(['leave'], {} as never);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Stopped leader.');
    });

    it('reports "Stopped leader. Now leader on …" on a leader→leader role switch', async () => {
      // The sixth of six `formatLeaveResult` branches — closes the
      // discriminated-union exhaustiveness table.
      const cmd = createHostCommand({
        getStatus: () => ({
          state: 'leader',
          session: {
            workerBaseUrl: 'https://old',
            trayId: 't',
            createdAt: 'now',
            controllerId: 'c',
            controllerUrl: 'https://old/c',
            joinUrl: 'https://old/join/t',
            webhookUrl: 'https://old/w/t',
            runtime: 'slicc-standalone',
          },
          error: null,
        }),
        getFollowerStatus: () => followerStatus({ state: 'inactive' }),
        leaveTray: async () => ({
          kind: 'switched',
          previousMode: 'leader',
          workerBaseUrl: 'https://new.example',
        }),
      });
      const result = await cmd.execute(['leave', '--leader', 'https://new.example'], {} as never);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Stopped leader. Now leader on https://new.example');
    });

    it('exits 0 with informational stderr when nothing is active and no leader requested', async () => {
      const cmd = createHostCommand({
        getStatus: () => ({ state: 'inactive', session: null, error: null }),
        getFollowerStatus: () => followerStatus({ state: 'inactive' }),
        leaveTray: async () => {
          throw new Error('should not be called');
        },
      });
      const result = await cmd.execute(['leave'], {} as never);
      // Exit 0 so `host leave || something` doesn't trip on a dormant
      // runtime; stderr keeps the noop visible to interactive users.
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('no active tray session');
      expect(result.stdout).toBe('');
    });

    it('still runs when nothing is active but --leader is provided (role-create)', async () => {
      const calls: Array<{ workerBaseUrl: string | null }> = [];
      const cmd = createHostCommand({
        getStatus: () => ({ state: 'inactive', session: null, error: null }),
        getFollowerStatus: () => followerStatus({ state: 'inactive' }),
        leaveTray: async (opts) => {
          calls.push({ workerBaseUrl: opts.workerBaseUrl });
          return {
            kind: 'switched',
            previousMode: 'inactive',
            workerBaseUrl: 'https://leader.example.com',
          };
        },
      });
      const result = await cmd.execute(
        ['leave', '--leader', 'https://leader.example.com'],
        {} as never
      );
      expect(calls).toEqual([{ workerBaseUrl: 'https://leader.example.com' }]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Now leader on https://leader.example.com');
    });

    it('rejects --leader without a URL argument', async () => {
      const cmd = createHostCommand({
        leaveTray: async () => ({ kind: 'noop' }),
      });
      const result = await cmd.execute(['leave', '--leader'], {} as never);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--leader requires a worker base URL');
    });

    it('rejects an invalid worker base URL', async () => {
      const cmd = createHostCommand({
        leaveTray: async () => ({ kind: 'noop' }),
      });
      const result = await cmd.execute(['leave', '--leader', 'not a url'], {} as never);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('invalid worker base URL');
    });

    it('rejects unknown subarguments', async () => {
      const cmd = createHostCommand({
        leaveTray: async () => ({ kind: 'noop' }),
      });
      const result = await cmd.execute(['leave', 'foo'], {} as never);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('unexpected argument: foo');
    });

    it('surfaces errors from the leave implementation (leave-entirely path)', async () => {
      const cmd = createHostCommand({
        getStatus: () => ({ state: 'inactive', session: null, error: null }),
        getFollowerStatus: () =>
          followerStatus({ state: 'connected', joinUrl: 'https://x/join/abc' }),
        leaveTray: async () => {
          throw new Error('stop refused');
        },
      });
      const result = await cmd.execute(['leave'], {} as never);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('stop refused');
    });

    it('distinguishes "left but failed to become leader" on the --leader failure path', async () => {
      // Mirrors the page-side contract: `performTrayLeave` only throws
      // when `startLeader` rejects, at which point the previous tray is
      // already stopped + storage rolled back. The shell formatter
      // surfaces this distinct half-failure to the user.
      const cmd = createHostCommand({
        getStatus: () => ({ state: 'inactive', session: null, error: null }),
        getFollowerStatus: () =>
          followerStatus({ state: 'connected', joinUrl: 'https://x/join/abc' }),
        leaveTray: async () => {
          throw new Error('worker unreachable');
        },
      });
      const result = await cmd.execute(
        ['leave', '--leader', 'https://leader.example.com'],
        {} as never
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('left the tray');
      expect(result.stderr).toContain('failed to become leader on https://leader.example.com');
      expect(result.stderr).toContain('worker unreachable');
      expect(result.stderr).toContain('Tray runtime is now dormant.');
    });

    it('renders kind:"noop" with a clear "No active tray session" message', async () => {
      // Direct check of the formatter — reachable from the role-create
      // branch when the page is also dormant and the inactive→leader
      // switch went through.
      const cmd = createHostCommand({
        getStatus: () => ({ state: 'inactive', session: null, error: null }),
        getFollowerStatus: () => followerStatus({ state: 'inactive' }),
        leaveTray: async () => ({ kind: 'noop' }),
      });
      const result = await cmd.execute(
        ['leave', '--leader', 'https://leader.example.com'],
        {} as never
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No active tray session');
    });

    it('help text mentions the leave subcommand', async () => {
      const result = await createHostCommand().execute(['--help'], {} as never);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('leave');
      expect(result.stdout).toContain('--leader');
    });
  });

  describe('host leave — panel-RPC bridge (worker path)', () => {
    // Mirrors the `host reset` panel-RPC tests. When the shell runs in
    // the kernel worker (no `window`, no `chrome.runtime`), the default
    // leaver routes through `globalThis.__slicc_panelRpc`.

    afterEach(() => {
      delete (globalThis as Record<string, unknown>).__slicc_panelRpc;
    });

    it('routes host leave through the panel-RPC client', async () => {
      const calls: Array<{ op: string; payload: unknown }> = [];
      (globalThis as Record<string, unknown>).__slicc_panelRpc = {
        call: async (op: string, payload: unknown) => {
          calls.push({ op, payload });
          return { kind: 'left', previousMode: 'leader' };
        },
        dispose: () => {},
      };

      // No options.leaveTray override → buildDefaultLeaver runs → in a
      // Node test environment with no `chrome.runtime`, `isNodeRuntime()
      // && !isExtensionRuntime()` is true → panel-RPC path engaged.
      const cmd = createHostCommand({
        getStatus: () => ({
          state: 'leader',
          session: {
            workerBaseUrl: 'https://x',
            trayId: 't',
            createdAt: '2026-01-01T00:00:00.000Z',
            controllerId: 'c',
            controllerUrl: 'https://x/c',
            joinUrl: 'https://x/join/t',
            webhookUrl: 'https://x/w/t',
            runtime: 'slicc-standalone',
          },
          error: null,
        }),
        getFollowerStatus: () => followerStatus({ state: 'inactive' }),
        getFollowers: () => [],
      });

      const result = await cmd.execute(['leave'], {} as never);
      expect(calls).toHaveLength(1);
      expect(calls[0].op).toBe('tray-leave');
      // Payload includes a generated requestId for failure correlation.
      const payload = calls[0].payload as { workerBaseUrl: string | null; requestId?: string };
      expect(payload.workerBaseUrl).toBeNull();
      expect(payload.requestId).toMatch(/^host-leave-/);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Stopped leader.');
    });

    it('forwards --leader URL through the panel-RPC payload', async () => {
      const calls: Array<unknown> = [];
      (globalThis as Record<string, unknown>).__slicc_panelRpc = {
        call: async (_op: string, payload: unknown) => {
          calls.push(payload);
          return {
            kind: 'switched',
            previousMode: 'follower',
            workerBaseUrl: 'https://leader.example.com',
          };
        },
        dispose: () => {},
      };

      const cmd = createHostCommand({
        getStatus: () => ({ state: 'inactive', session: null, error: null }),
        getFollowerStatus: () =>
          followerStatus({
            state: 'connected',
            joinUrl: 'https://x/join/abc',
          }),
        getFollowers: () => [],
      });

      const result = await cmd.execute(
        ['leave', '--leader', 'https://leader.example.com'],
        {} as never
      );
      expect(calls).toHaveLength(1);
      expect((calls[0] as { workerBaseUrl: string }).workerBaseUrl).toBe(
        'https://leader.example.com'
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Now leader on https://leader.example.com');
    });
  });

  describe('host join', () => {
    it('rejects a missing join URL', async () => {
      const cmd = createHostCommand({
        joinTray: async () => {
          throw new Error('should not be called');
        },
      });
      const result = await cmd.execute(['join'], {} as never);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('host join: missing join URL');
    });

    it('rejects a URL that is not a /join/ link', async () => {
      const cmd = createHostCommand({
        joinTray: async () => {
          throw new Error('should not be called');
        },
      });
      const result = await cmd.execute(['join', 'https://www.sliccy.ai/not-a-join'], {} as never);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('invalid join URL');
    });

    it('rejects a /join/ link whose token lacks the trayId.secret form', async () => {
      const cmd = createHostCommand({
        joinTray: async () => {
          throw new Error('should not be called');
        },
      });
      const result = await cmd.execute(['join', 'https://www.sliccy.ai/join/abc'], {} as never);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('invalid join URL');
    });

    it('rejects an unexpected extra argument', async () => {
      const cmd = createHostCommand({
        joinTray: async () => {
          throw new Error('should not be called');
        },
      });
      const result = await cmd.execute(
        ['join', 'https://www.sliccy.ai/join/tray123.s3cr3t', 'extra'],
        {} as never
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('unexpected argument');
    });

    it('rejects an unknown flag instead of silently dropping it', async () => {
      const cmd = createHostCommand({
        joinTray: async () => {
          throw new Error('should not be called');
        },
      });
      const result = await cmd.execute(
        ['join', '--typo', 'https://www.sliccy.ai/join/tray123.s3cr3t'],
        {} as never
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('unexpected argument: --typo');
    });

    it('calls joinTray with the normalized join URL and reports connecting', async () => {
      const calls: Array<{ joinUrl: string; requestId?: string }> = [];
      const cmd = createHostCommand({
        joinTray: async (opts) => {
          calls.push(opts);
        },
      });
      const result = await cmd.execute(
        ['join', 'https://www.sliccy.ai/join/tray123.s3cr3t'],
        {} as never
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].joinUrl).toBe('https://www.sliccy.ai/join/tray123.s3cr3t');
      expect(calls[0].requestId).toMatch(/^host-join-/);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Joining tray as follower');
      expect(result.stdout).toContain('https://www.sliccy.ai/join/tray123.s3cr3t');
    });

    it('surfaces a joinTray failure on stderr with exit 1', async () => {
      const cmd = createHostCommand({
        joinTray: async () => {
          throw new Error('boom');
        },
      });
      const result = await cmd.execute(
        ['join', 'https://www.sliccy.ai/join/tray123.s3cr3t'],
        {} as never
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('host join: boom');
    });
  });

  describe('host join — panel-RPC bridge (worker path)', () => {
    // Mirrors the `host leave` panel-RPC test. In the standalone kernel
    // worker (no `window`, no `chrome.runtime`) the default joiner routes
    // through `globalThis.__slicc_panelRpc` as the `tray-join` op.

    afterEach(() => {
      delete (globalThis as Record<string, unknown>).__slicc_panelRpc;
    });

    it('routes host join through the panel-RPC client as tray-join', async () => {
      const calls: Array<{ op: string; payload: unknown }> = [];
      (globalThis as Record<string, unknown>).__slicc_panelRpc = {
        call: async (op: string, payload: unknown) => {
          calls.push({ op, payload });
          return { joinUrl: 'https://www.sliccy.ai/join/tray123.s3cr3t' };
        },
        dispose: () => {},
      };

      const cmd = createHostCommand({});
      const result = await cmd.execute(
        ['join', 'https://www.sliccy.ai/join/tray123.s3cr3t'],
        {} as never
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].op).toBe('tray-join');
      const payload = calls[0].payload as { joinUrl: string; requestId?: string };
      expect(payload.joinUrl).toBe('https://www.sliccy.ai/join/tray123.s3cr3t');
      expect(payload.requestId).toMatch(/^host-join-/);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Joining tray as follower');
    });
  });
});

describe('formatLeaderOutput', () => {
  it('formats leader with session and no followers', () => {
    const output = formatLeaderOutput(
      {
        state: 'leader',
        session: {
          workerBaseUrl: 'https://tray.example.com/base',
          trayId: 'tray-123',
          createdAt: '2026-03-12T00:00:00.000Z',
          controllerId: 'controller-1',
          controllerUrl: 'https://tray.example.com/controller/controller-1',
          joinUrl: 'https://tray.example.com/join/tray-123',
          webhookUrl: 'https://tray.example.com/webhooks/tray-123',
          leaderKey: 'leader-key',
          leaderWebSocketUrl: 'wss://tray.example.com/ws',
          runtime: 'slicc-standalone',
        },
        error: null,
      },
      []
    );
    expect(output).toBe('status: leader\njoin_url: https://tray.example.com/join/tray-123\n');
  });

  it('formats leader with followers', () => {
    const output = formatLeaderOutput(
      {
        state: 'leader',
        session: {
          workerBaseUrl: 'https://tray.example.com/base',
          trayId: 'tray-123',
          createdAt: '2026-03-12T00:00:00.000Z',
          controllerId: 'controller-1',
          controllerUrl: 'https://tray.example.com/controller/controller-1',
          joinUrl: 'https://tray.example.com/join/tray-123',
          webhookUrl: 'https://tray.example.com/webhooks/tray-123',
          leaderKey: 'leader-key',
          leaderWebSocketUrl: 'wss://tray.example.com/ws',
          runtime: 'slicc-standalone',
        },
        error: null,
      },
      [{ runtimeId: 'follower-abc' }]
    );
    expect(output).toContain('followers:');
    expect(output).toContain('  - follower-abc');
  });

  it('formats leader with follower metadata (runtime + connectedAt)', () => {
    const connectedAt = new Date(Date.now() - 125_000).toISOString(); // 2m 5s ago
    const output = formatLeaderOutput(
      {
        state: 'leader',
        session: {
          workerBaseUrl: 'https://tray.example.com/base',
          trayId: 'tray-123',
          createdAt: '2026-03-12T00:00:00.000Z',
          controllerId: 'controller-1',
          controllerUrl: 'https://tray.example.com/controller/controller-1',
          joinUrl: 'https://tray.example.com/join/tray-123',
          webhookUrl: 'https://tray.example.com/webhooks/tray-123',
          leaderKey: 'leader-key',
          leaderWebSocketUrl: 'wss://tray.example.com/ws',
          runtime: 'slicc-standalone',
        },
        error: null,
      },
      [{ runtimeId: 'follower-abc', runtime: 'slicc-electron', connectedAt }]
    );
    expect(output).toContain('followers:');
    expect(output).toContain('  - follower-abc (slicc-electron) connected 2m ago');
  });

  it('formats leader with error and no session', () => {
    const output = formatLeaderOutput({ state: 'error', session: null, error: 'boom' }, []);
    expect(output).toBe('status: error\njoin_url: unavailable\nerror: boom\n');
  });
});

describe('formatFollowerOutput', () => {
  it('formats connected follower without tray_id', () => {
    const output = formatFollowerOutput(
      followerStatus({
        state: 'connected',
        joinUrl: 'https://tray.example.com/join/token',
        trayId: 'tray-789',
      })
    );
    expect(output).toBe(
      'status: follower (connected)\njoin_url: https://tray.example.com/join/token\n'
    );
    expect(output).not.toContain('tray_id');
  });

  it('omits join_url when null', () => {
    const output = formatFollowerOutput(
      followerStatus({
        state: 'connecting',
      })
    );
    expect(output).toBe('status: follower (connecting)\n');
  });

  it('includes error when present', () => {
    const output = formatFollowerOutput(
      followerStatus({
        state: 'error',
        error: 'something broke',
      })
    );
    expect(output).toContain('error: something broke');
  });

  it('shows last_ping for connected follower with lastPingTime', () => {
    const now = Date.now();
    const output = formatFollowerOutput(
      followerStatus({
        state: 'connected',
        joinUrl: 'https://tray.example.com/join/token',
        trayId: 'tray-789',
        lastPingTime: now - 10000,
      })
    );
    expect(output).toContain('last_ping: 10s ago');
  });

  it('omits last_ping when lastPingTime is null', () => {
    const output = formatFollowerOutput(
      followerStatus({
        state: 'connected',
        joinUrl: 'https://tray.example.com/join/token',
        trayId: 'tray-789',
      })
    );
    expect(output).not.toContain('last_ping');
  });

  it('shows reconnect_attempts for reconnecting follower', () => {
    const output = formatFollowerOutput(
      followerStatus({
        state: 'reconnecting',
        joinUrl: 'https://tray.example.com/join/token',
        trayId: 'tray-789',
        lastPingTime: Date.now() - 30000,
        reconnectAttempts: 5,
      })
    );
    expect(output).toContain('status: follower (reconnecting)');
    expect(output).toContain('reconnect_attempts: 5');
    expect(output).not.toContain('last_ping');
  });

  it('omits reconnect_attempts when 0', () => {
    const output = formatFollowerOutput(
      followerStatus({
        state: 'reconnecting',
        joinUrl: 'https://tray.example.com/join/token',
      })
    );
    expect(output).not.toContain('reconnect_attempts');
  });

  it('shows connecting diagnostics when available', () => {
    const now = Date.now();
    const output = formatFollowerOutput(
      followerStatus({
        state: 'connecting',
        joinUrl: 'https://tray.example.com/join/token',
        connectingSince: now - 30000,
        attachAttempts: 15,
        lastAttachCode: 'LEADER_NOT_ELECTED',
      })
    );
    expect(output).toContain('status: follower (connecting)');
    expect(output).toContain('connecting_for: 30s');
    expect(output).toContain('attach_attempts: 15');
    expect(output).toContain('last_code: LEADER_NOT_ELECTED');
  });

  it('shows last_error when present', () => {
    const output = formatFollowerOutput(
      followerStatus({
        state: 'connecting',
        joinUrl: 'https://tray.example.com/join/token',
        lastError: 'Tray follower attach returned an invalid response (502): Bad Gateway',
      })
    );
    expect(output).toContain(
      'last_error: Tray follower attach returned an invalid response (502): Bad Gateway'
    );
  });

  it('omits connecting diagnostics when not in connecting state', () => {
    const output = formatFollowerOutput(
      followerStatus({
        state: 'connected',
        joinUrl: 'https://tray.example.com/join/token',
        attachAttempts: 5,
        lastAttachCode: 'LEADER_CONNECTED',
        connectingSince: Date.now() - 10000,
      })
    );
    expect(output).not.toContain('attach_attempts');
    expect(output).not.toContain('last_code');
    expect(output).not.toContain('connecting_for');
  });
});

describe('formatDuration', () => {
  it('formats seconds', () => {
    expect(formatDuration(30)).toBe('30s ago');
  });

  it('formats minutes', () => {
    expect(formatDuration(120)).toBe('2m ago');
    expect(formatDuration(90)).toBe('1m ago');
  });

  it('formats hours', () => {
    expect(formatDuration(3600)).toBe('1h ago');
    expect(formatDuration(7200)).toBe('2h ago');
  });

  it('formats hours and minutes', () => {
    expect(formatDuration(3660)).toBe('1h 1m ago');
    expect(formatDuration(5400)).toBe('1h 30m ago');
  });

  it('formats zero seconds', () => {
    expect(formatDuration(0)).toBe('0s ago');
  });
});
