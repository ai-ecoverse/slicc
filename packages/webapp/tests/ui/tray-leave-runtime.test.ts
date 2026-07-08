import { describe, expect, it } from 'vitest';
import {
  TRAY_JOIN_STORAGE_KEY,
  TRAY_WORKER_STORAGE_KEY,
} from '../../src/scoops/tray-runtime-config.js';
import {
  performTrayLeave,
  type TrayLeaveDeps,
  type TrayLeaveReadyHandle,
  type TrayLeaveStoppable,
} from '../../src/ui/tray-leave-runtime.js';

interface RecordingHandle extends TrayLeaveReadyHandle {
  id: string;
  stopCalls: number;
  ready: Promise<unknown>;
}

function makeHandle(
  id: string,
  opts?: { throwOnStop?: boolean; ready?: Promise<unknown> }
): RecordingHandle {
  const handle: RecordingHandle = {
    id,
    stopCalls: 0,
    ready: opts?.ready ?? Promise.resolve({ trayId: 'test' }),
    stop() {
      this.stopCalls += 1;
      if (opts?.throwOnStop) throw new Error(`${id} stop boom`);
    },
  };
  return handle;
}

interface FakeStorage {
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  data: Map<string, string>;
}

function makeStorage(initial: Record<string, string> = {}): FakeStorage {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    setItem: (k, v) => {
      data.set(k, v);
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
}

interface RecordingLog {
  errors: Array<{ message: string; meta?: Record<string, unknown> }>;
  error(message: string, meta?: Record<string, unknown>): void;
}

function makeLog(): RecordingLog {
  return {
    errors: [],
    error(message, meta) {
      this.errors.push({ message, meta });
    },
  };
}

interface DepsState<TLeader extends RecordingHandle> {
  leader: TLeader | null;
  follower: TrayLeaveStoppable | null;
  hooksWired: Array<TLeader>;
  hooksCleared: number;
  startLeaderCalls: Array<string>;
  startLeaderImpl: (workerBaseUrl: string) => TLeader;
  storage: FakeStorage;
  log: RecordingLog;
}

function makeDeps<TLeader extends RecordingHandle>(
  state: DepsState<TLeader>
): TrayLeaveDeps<TLeader> {
  return {
    getLeader: () => state.leader,
    setLeader: (h) => {
      state.leader = h;
    },
    getFollower: () => state.follower,
    setFollower: (h) => {
      state.follower = h;
    },
    startLeader: (workerBaseUrl) => {
      state.startLeaderCalls.push(workerBaseUrl);
      return state.startLeaderImpl(workerBaseUrl);
    },
    clearLeaderHooks: () => {
      state.hooksCleared += 1;
    },
    wireLeaderHooks: (h) => {
      state.hooksWired.push(h);
    },
    storage: state.storage,
    log: state.log,
  };
}

describe('performTrayLeave', () => {
  describe('leave-entirely path (workerBaseUrl: null)', () => {
    it('returns { kind: "left", previousMode: "leader" } and stops the leader handle', async () => {
      const leader = makeHandle('L1');
      const state: DepsState<RecordingHandle> = {
        leader,
        follower: null,
        hooksWired: [],
        hooksCleared: 0,
        startLeaderCalls: [],
        startLeaderImpl: () => {
          throw new Error('should not be called');
        },
        storage: makeStorage({
          [TRAY_JOIN_STORAGE_KEY]: 'https://x/join/abc',
          [TRAY_WORKER_STORAGE_KEY]: 'https://x',
        }),
        log: makeLog(),
      };
      const result = await performTrayLeave({ workerBaseUrl: null }, makeDeps(state));
      expect(result).toEqual({ kind: 'left', previousMode: 'leader' });
      expect(leader.stopCalls).toBe(1);
      expect(state.leader).toBeNull();
      expect(state.hooksCleared).toBe(1);
      expect(state.storage.data.has(TRAY_JOIN_STORAGE_KEY)).toBe(false);
      expect(state.storage.data.has(TRAY_WORKER_STORAGE_KEY)).toBe(false);
    });

    it('returns { kind: "left", previousMode: "follower" } and stops the follower handle', async () => {
      const follower = makeHandle('F1');
      const state: DepsState<RecordingHandle> = {
        leader: null,
        follower,
        hooksWired: [],
        hooksCleared: 0,
        startLeaderCalls: [],
        startLeaderImpl: () => {
          throw new Error('not called');
        },
        storage: makeStorage(),
        log: makeLog(),
      };
      const result = await performTrayLeave({ workerBaseUrl: null }, makeDeps(state));
      expect(result).toEqual({ kind: 'left', previousMode: 'follower' });
      expect(follower.stopCalls).toBe(1);
      expect(state.follower).toBeNull();
    });

    it('returns { kind: "noop" } when nothing was active', async () => {
      const state: DepsState<RecordingHandle> = {
        leader: null,
        follower: null,
        hooksWired: [],
        hooksCleared: 0,
        startLeaderCalls: [],
        startLeaderImpl: () => {
          throw new Error('not called');
        },
        storage: makeStorage(),
        log: makeLog(),
      };
      const result = await performTrayLeave({ workerBaseUrl: null }, makeDeps(state));
      expect(result).toEqual({ kind: 'noop' });
    });

    it('logs storage failures via deps.log instead of swallowing them', async () => {
      const storage: FakeStorage = {
        data: new Map(),
        setItem: () => {
          throw new Error('quota');
        },
        removeItem: () => {
          throw new Error('denied');
        },
      };
      const state: DepsState<RecordingHandle> = {
        leader: makeHandle('L1'),
        follower: null,
        hooksWired: [],
        hooksCleared: 0,
        startLeaderCalls: [],
        startLeaderImpl: () => {
          throw new Error('not called');
        },
        storage,
        log: makeLog(),
      };
      const result = await performTrayLeave({ workerBaseUrl: null }, makeDeps(state));
      expect(result).toEqual({ kind: 'left', previousMode: 'leader' });
      // Two storage operations attempted (join-clear + worker-clear), both
      // log on failure.
      expect(state.log.errors.length).toBeGreaterThanOrEqual(2);
      expect(state.log.errors[0].message).toMatch(/tray-leave storage write failed/);
    });
  });

  describe('role-switch path (workerBaseUrl is a URL)', () => {
    it('stops old leader, starts new one, wires hooks, writes worker key AFTER success', async () => {
      const oldLeader = makeHandle('L1');
      const newLeader = makeHandle('L2');
      const state: DepsState<RecordingHandle> = {
        leader: oldLeader,
        follower: null,
        hooksWired: [],
        hooksCleared: 0,
        startLeaderCalls: [],
        startLeaderImpl: () => newLeader,
        storage: makeStorage({ [TRAY_JOIN_STORAGE_KEY]: 'https://x/join/abc' }),
        log: makeLog(),
      };
      const result = await performTrayLeave(
        { workerBaseUrl: 'https://new.example' },
        makeDeps(state)
      );
      expect(result).toEqual({
        kind: 'switched',
        previousMode: 'leader',
        workerBaseUrl: 'https://new.example',
      });
      expect(oldLeader.stopCalls).toBe(1);
      expect(state.leader).toBe(newLeader);
      expect(state.startLeaderCalls).toEqual(['https://new.example']);
      expect(state.hooksCleared).toBe(1);
      expect(state.hooksWired).toEqual([newLeader]);
      expect(state.storage.data.has(TRAY_JOIN_STORAGE_KEY)).toBe(false);
      expect(state.storage.data.get(TRAY_WORKER_STORAGE_KEY)).toBe('https://new.example');
    });

    it('returns previousMode "follower" when switching from follower to leader', async () => {
      const follower = makeHandle('F1');
      const newLeader = makeHandle('L1');
      const state: DepsState<RecordingHandle> = {
        leader: null,
        follower,
        hooksWired: [],
        hooksCleared: 0,
        startLeaderCalls: [],
        startLeaderImpl: () => newLeader,
        storage: makeStorage(),
        log: makeLog(),
      };
      const result = await performTrayLeave(
        { workerBaseUrl: 'https://new.example' },
        makeDeps(state)
      );
      expect(result).toEqual({
        kind: 'switched',
        previousMode: 'follower',
        workerBaseUrl: 'https://new.example',
      });
      expect(follower.stopCalls).toBe(1);
    });

    it('returns previousMode "inactive" when creating a leader from a dormant runtime', async () => {
      const newLeader = makeHandle('L1');
      const state: DepsState<RecordingHandle> = {
        leader: null,
        follower: null,
        hooksWired: [],
        hooksCleared: 0,
        startLeaderCalls: [],
        startLeaderImpl: () => newLeader,
        storage: makeStorage(),
        log: makeLog(),
      };
      const result = await performTrayLeave(
        { workerBaseUrl: 'https://new.example' },
        makeDeps(state)
      );
      expect(result).toEqual({
        kind: 'switched',
        previousMode: 'inactive',
        workerBaseUrl: 'https://new.example',
      });
    });
  });

  describe('half-state failure recovery (startLeader throws)', () => {
    it('rolls storage back to fully-dormant when startLeader rejects', async () => {
      const oldLeader = makeHandle('L1');
      const state: DepsState<RecordingHandle> = {
        leader: oldLeader,
        follower: null,
        hooksWired: [],
        hooksCleared: 0,
        startLeaderCalls: [],
        startLeaderImpl: () => {
          throw new Error('worker unreachable');
        },
        storage: makeStorage({
          [TRAY_JOIN_STORAGE_KEY]: 'https://x/join/abc',
          [TRAY_WORKER_STORAGE_KEY]: 'https://x',
        }),
        log: makeLog(),
      };
      await expect(
        performTrayLeave({ workerBaseUrl: 'https://bad.example' }, makeDeps(state))
      ).rejects.toThrow(/worker unreachable/);
      // Critical: storage MUST NOT point at the failed URL — that would
      // make the next page reload try to revive a stale leader.
      expect(state.storage.data.has(TRAY_JOIN_STORAGE_KEY)).toBe(false);
      expect(state.storage.data.has(TRAY_WORKER_STORAGE_KEY)).toBe(false);
      // Old leader was stopped before startLeader tried.
      expect(oldLeader.stopCalls).toBe(1);
      expect(state.leader).toBeNull();
      // Hooks were NOT wired because startLeader threw.
      expect(state.hooksWired).toEqual([]);
      // Failure was logged at error level.
      expect(state.log.errors.some((e) => /startLeader failed/.test(e.message))).toBe(true);
    });
  });

  describe('teardown error handling', () => {
    it('logs leader.stop() throws via deps.log and continues with the follower stop', async () => {
      const leader = makeHandle('L1', { throwOnStop: true });
      const follower = makeHandle('F1');
      const state: DepsState<RecordingHandle> = {
        leader,
        follower,
        hooksWired: [],
        hooksCleared: 0,
        startLeaderCalls: [],
        startLeaderImpl: () => {
          throw new Error('not called');
        },
        storage: makeStorage(),
        log: makeLog(),
      };
      const result = await performTrayLeave({ workerBaseUrl: null }, makeDeps(state));
      expect(result.kind).toBe('left');
      // Follower stop still ran despite leader stop throw.
      expect(follower.stopCalls).toBe(1);
      expect(state.log.errors.some((e) => /Leader stop threw/.test(e.message))).toBe(true);
    });
  });
});
