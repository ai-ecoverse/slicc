import { afterEach, describe, expect, it } from 'vitest';
import {
  FOLLOWER_STATUS_STORAGE_KEY,
  LEADER_STATUS_STORAGE_KEY,
} from '../../../src/base/tray-role.js';
import {
  type FollowerTrayRuntimeStatus,
  setFollowerTrayRuntimeStatus,
} from '../../../src/scoops/tray-follower-status.js';
import {
  type LeaderTrayRuntimeStatus,
  type LeaderTraySession,
  setLeaderTrayRuntimeStatus,
} from '../../../src/scoops/tray-leader.js';
import {
  TRAY_JOIN_STORAGE_KEY,
  TRAY_WORKER_STORAGE_KEY,
} from '../../../src/scoops/tray-runtime-config.js';
import {
  createHostCommand,
  setConnectedFollowersGetter,
  setTrayResetter,
  writeConnectedFollowersToShim,
} from '../../../src/shell/supplemental-commands/host-command.js';

const LEADER_FOLLOWERS_STORAGE_KEY = 'slicc.leaderTrayFollowers';

const INACTIVE_LEADER: LeaderTrayRuntimeStatus = { state: 'inactive', session: null, error: null };

const INACTIVE_FOLLOWER: FollowerTrayRuntimeStatus = {
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
};

function leaderSession(trayId: string): LeaderTraySession {
  return {
    workerBaseUrl: 'https://tray.example.com',
    trayId,
    createdAt: '2026-08-28T00:00:00.000Z',
    controllerId: `ctrl-${trayId}`,
    controllerUrl: `https://tray.example.com/controller/ctrl-${trayId}`,
    joinUrl: `https://tray.example.com/join/${trayId}.secret`,
    webhookUrl: `https://tray.example.com/webhooks/${trayId}`,
    runtime: 'slicc-standalone',
  };
}

function activeLeader(trayId: string): LeaderTrayRuntimeStatus {
  return { state: 'leader', session: leaderSession(trayId), error: null };
}

function connectedFollower(trayId: string): FollowerTrayRuntimeStatus {
  return {
    ...INACTIVE_FOLLOWER,
    state: 'connected',
    trayId,
    joinUrl: `https://tray.example.com/join/${trayId}.secret`,
  };
}

type FloatKind = 'standalone-worker' | 'standalone-page' | 'extension-offscreen' | 'dormant';

interface FloatHandle {
  rpcCalls: Array<{ op: string; payload: unknown }>;

  events: Array<{ type: string; detail: unknown }>;

  rpcResult: unknown;
  storage: Storage;
  dispose(): void;
}

function installFloat(kind: FloatKind): FloatHandle {
  const store = new Map<string, string>();
  const storage: Storage = {
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
    value: storage,
    configurable: true,
    writable: true,
  });

  const handle: FloatHandle = {
    rpcCalls: [],
    events: [],
    rpcResult: undefined,
    storage,
    dispose() {
      delete (globalThis as Record<string, unknown>).__slicc_panelRpc;
      delete (globalThis as Record<string, unknown>).window;
      delete (globalThis as Record<string, unknown>).localStorage;
    },
  };

  if (kind === 'standalone-worker') {
    (globalThis as Record<string, unknown>).__slicc_panelRpc = {
      call: async (op: string, payload: unknown) => {
        handle.rpcCalls.push({ op, payload });
        return handle.rpcResult;
      },
      dispose: () => {},
    };
  }

  if (kind === 'standalone-page' || kind === 'extension-offscreen') {
    (globalThis as Record<string, unknown>).window = {
      dispatchEvent: (event: Event) => {
        handle.events.push({
          type: event.type,
          detail: (event as CustomEvent<unknown>).detail,
        });
        return true;
      },
    };
  }

  return handle;
}

function resetTrayModuleState(): void {
  setLeaderTrayRuntimeStatus(INACTIVE_LEADER);
  setFollowerTrayRuntimeStatus(INACTIVE_FOLLOWER);
  setConnectedFollowersGetter(null);
  setTrayResetter(null);
}

async function runHost(
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return await createHostCommand().execute(args, {} as never);
}

describe('host — multi-float integration (real defaults, no injected options)', () => {
  afterEach(() => {
    resetTrayModuleState();
    delete (globalThis as Record<string, unknown>).__slicc_panelRpc;
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  describe('standalone-worker float (shell in the kernel worker)', () => {
    it('reads leader status + followers from the shims when the globals are inactive', async () => {
      const float = installFloat('standalone-worker');

      float.storage.setItem(LEADER_STATUS_STORAGE_KEY, JSON.stringify(activeLeader('tray-w1')));
      writeConnectedFollowersToShim([{ runtimeId: 'cli-peer', exec: true, motd: 'laptop' }]);

      const result = await runHost([]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('status: leader');
      expect(result.stdout).toContain('join_url: https://tray.example.com/join/tray-w1.secret');
      expect(result.stdout).toContain('- cli-peer [ssh]');
      expect(result.stdout).toContain('laptop');
      float.dispose();
    });

    it('reports a connected follower from the shim instead of falling through to leader (b268)', async () => {
      const float = installFloat('standalone-worker');
      float.storage.setItem(
        FOLLOWER_STATUS_STORAGE_KEY,
        JSON.stringify(connectedFollower('tray-w2'))
      );

      const result = await runHost([]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('status: follower (connected)');
      expect(result.stdout).not.toContain('status: inactive');
      float.dispose();
    });

    it('prefers the follower shim over a simultaneously-populated leader shim', async () => {
      const float = installFloat('standalone-worker');
      float.storage.setItem(LEADER_STATUS_STORAGE_KEY, JSON.stringify(activeLeader('tray-w3')));
      float.storage.setItem(
        FOLLOWER_STATUS_STORAGE_KEY,
        JSON.stringify(connectedFollower('tray-w3-follow'))
      );

      const result = await runHost([]);

      expect(result.stdout).toContain('status: follower (connected)');
      float.dispose();
    });

    it('swallows a corrupt leader shim instead of throwing out of `host`', async () => {
      const float = installFloat('standalone-worker');
      float.storage.setItem(LEADER_STATUS_STORAGE_KEY, '{not json');

      const result = await runHost([]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('status: inactive');
      expect(result.stdout).toContain('join_url: unavailable');
      float.dispose();
    });

    it('swallows a corrupt follower shim and falls through to the leader path', async () => {
      const float = installFloat('standalone-worker');
      float.storage.setItem(FOLLOWER_STATUS_STORAGE_KEY, '{not json');
      float.storage.setItem(LEADER_STATUS_STORAGE_KEY, JSON.stringify(activeLeader('tray-w5')));

      const result = await runHost([]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('status: leader');
      expect(result.stdout).toContain('join_url: https://tray.example.com/join/tray-w5.secret');
      float.dispose();
    });

    it('routes join / leave / reset through panel-RPC rather than the ambient helpers', async () => {
      const float = installFloat('standalone-worker');
      float.storage.setItem(LEADER_STATUS_STORAGE_KEY, JSON.stringify(activeLeader('tray-w4')));

      float.rpcResult = undefined;
      const join = await runHost(['join', 'https://tray.example.com/join/tray-x.secret']);
      expect(join.exitCode).toBe(0);

      float.rpcResult = { kind: 'left', previousMode: 'leader' };
      const leave = await runHost(['leave']);
      expect(leave.exitCode).toBe(0);
      expect(leave.stdout).toContain('Stopped leader.');

      float.rpcResult = activeLeader('tray-w4-new');
      const reset = await runHost(['reset']);
      expect(reset.exitCode).toBe(0);
      expect(reset.stdout).toContain('Tray session reset.');

      expect(float.rpcCalls.map((c) => c.op)).toEqual(['tray-join', 'tray-leave', 'tray-reset']);

      expect(float.events).toEqual([]);
      float.dispose();
    });
  });

  describe('standalone-page float (shell on the page, managers local)', () => {
    it('reads the live module globals', async () => {
      const float = installFloat('standalone-page');
      setLeaderTrayRuntimeStatus(activeLeader('tray-p1'));
      setConnectedFollowersGetter(() => [{ runtimeId: 'tab-peer', cdp: true }]);

      const result = await runHost([]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('status: leader');
      expect(result.stdout).toContain('join_url: https://tray.example.com/join/tray-p1.secret');
      expect(result.stdout).toContain('- tab-peer [playwright]');
      float.dispose();
    });

    it('dispatches slicc:tray-join on the page and persists both boot keys', async () => {
      const float = installFloat('standalone-page');

      const result = await runHost(['join', 'https://tray.example.com/join/tray-p2.secret']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Joining tray as follower');
      expect(float.events).toHaveLength(1);
      expect(float.events[0].type).toBe('slicc:tray-join');
      expect(float.events[0].detail).toMatchObject({
        joinUrl: 'https://tray.example.com/join/tray-p2.secret',
      });

      expect(float.storage.getItem(TRAY_JOIN_STORAGE_KEY)).toBe(
        'https://tray.example.com/join/tray-p2.secret'
      );
      expect(float.storage.getItem(TRAY_WORKER_STORAGE_KEY)).toBe('https://tray.example.com');
      expect(float.rpcCalls).toEqual([]);
      float.dispose();
    });

    it('dispatches slicc:tray-leave and synthesizes the result from the live status', async () => {
      const float = installFloat('standalone-page');
      setLeaderTrayRuntimeStatus(activeLeader('tray-p3'));

      const result = await runHost(['leave']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('Stopped leader. Tray runtime is now dormant.\n');
      expect(float.events).toHaveLength(1);
      expect(float.events[0].type).toBe('slicc:tray-leave');
      expect(float.events[0].detail).toMatchObject({ workerBaseUrl: null });

      expect(float.storage.getItem(TRAY_JOIN_STORAGE_KEY)).toBeNull();
      expect(float.storage.getItem(TRAY_WORKER_STORAGE_KEY)).toBeNull();
      float.dispose();
    });

    it('uses the registered tray resetter instead of the panel-RPC bridge', async () => {
      const float = installFloat('standalone-page');
      setLeaderTrayRuntimeStatus(activeLeader('tray-p4'));
      setTrayResetter(async () => activeLeader('tray-p4-new'));

      const result = await runHost(['reset']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('join_url: https://tray.example.com/join/tray-p4-new.secret');
      expect(float.rpcCalls).toEqual([]);
      float.dispose();
    });
  });

  describe('extension-offscreen float (managers run in this realm)', () => {
    it('lets the live leader global outrank a stale leader shim', async () => {
      const float = installFloat('extension-offscreen');

      float.storage.setItem(LEADER_STATUS_STORAGE_KEY, JSON.stringify(activeLeader('tray-stale')));
      setLeaderTrayRuntimeStatus(activeLeader('tray-live'));

      const result = await runHost([]);

      expect(result.stdout).toContain('join_url: https://tray.example.com/join/tray-live.secret');
      expect(result.stdout).not.toContain('tray-stale');
      float.dispose();
    });

    it('lets the live follower global outrank a stale follower shim', async () => {
      const float = installFloat('extension-offscreen');
      float.storage.setItem(
        FOLLOWER_STATUS_STORAGE_KEY,
        JSON.stringify({ ...connectedFollower('tray-stale'), state: 'error', lastError: 'stale' })
      );
      setFollowerTrayRuntimeStatus(connectedFollower('tray-live'));

      const result = await runHost([]);

      expect(result.stdout).toContain('status: follower (connected)');
      expect(result.stdout).not.toContain('stale');
      float.dispose();
    });
  });

  describe('dormant float (no managers, no bridge)', () => {
    it('reports inactive with no join URL', async () => {
      const float = installFloat('dormant');

      const result = await runHost([]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('status: inactive');
      expect(result.stdout).toContain('join_url: unavailable');
      float.dispose();
    });

    it('surfaces "no transport available" when host join has nowhere to go', async () => {
      const float = installFloat('dormant');

      const result = await runHost(['join', 'https://tray.example.com/join/tray-d2.secret']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('host join:');
      expect(result.stderr).toContain('no transport available');
      float.dispose();
    });

    it('reports host reset as unavailable rather than crashing', async () => {
      const float = installFloat('dormant');
      setLeaderTrayRuntimeStatus(activeLeader('tray-d3'));

      const result = await runHost(['reset']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('tray reset is not available in this environment');
      float.dispose();
    });
  });

  describe('cross-float invariants', () => {
    it('the same command surface reports the same tray from either side of the worker boundary', async () => {
      const page = installFloat('standalone-page');
      setLeaderTrayRuntimeStatus(activeLeader('tray-shared'));
      setConnectedFollowersGetter(() => [{ runtimeId: 'peer-1', exec: true }]);
      const fromPage = await runHost([]);
      page.dispose();

      resetTrayModuleState();

      const worker = installFloat('standalone-worker');
      worker.storage.setItem(
        LEADER_STATUS_STORAGE_KEY,
        JSON.stringify(activeLeader('tray-shared'))
      );
      worker.storage.setItem(
        LEADER_FOLLOWERS_STORAGE_KEY,
        JSON.stringify([{ runtimeId: 'peer-1', exec: true }])
      );
      const fromWorker = await runHost([]);
      worker.dispose();

      expect(fromWorker.stdout).toBe(fromPage.stdout);
      expect(fromWorker.stdout).toContain('- peer-1 [ssh]');
    });

    it('an empty follower mirror does not resurrect a stale page-side follower list', async () => {
      const float = installFloat('standalone-worker');
      float.storage.setItem(LEADER_STATUS_STORAGE_KEY, JSON.stringify(activeLeader('tray-x1')));
      writeConnectedFollowersToShim([{ runtimeId: 'gone-peer', exec: true }]);
      writeConnectedFollowersToShim([]);

      const result = await runHost([]);

      expect(result.stdout).not.toContain('gone-peer');
      expect(result.stdout).not.toContain('followers:');
      float.dispose();
    });
  });
});
