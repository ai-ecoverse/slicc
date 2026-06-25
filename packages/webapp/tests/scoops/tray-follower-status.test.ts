import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FOLLOWER_STATUS_STORAGE_KEY,
  type FollowerTrayRuntimeStatus,
  getFollowerStatusWithFallback,
  getFollowerTrayRuntimeStatus,
  resetReconnectAttempts,
  setFollowerLastPingTime,
  setFollowerTrayRuntimeStatus,
  subscribeToFollowerTrayRuntimeStatus,
} from '../../src/scoops/tray-follower-status.js';

/** Helper to build a status with sensible defaults for all fields. */
function makeStatus(overrides: Partial<FollowerTrayRuntimeStatus> = {}): FollowerTrayRuntimeStatus {
  return {
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
    ...overrides,
  };
}

describe('follower tray runtime status', () => {
  beforeEach(() => {
    setFollowerTrayRuntimeStatus(makeStatus());
  });

  it('defaults to inactive', () => {
    const status = getFollowerTrayRuntimeStatus();
    expect(status.state).toBe('inactive');
    expect(status.joinUrl).toBeNull();
    expect(status.trayId).toBeNull();
    expect(status.error).toBeNull();
    expect(status.lastPingTime).toBeNull();
    expect(status.reconnectAttempts).toBe(0);
    expect(status.attachAttempts).toBe(0);
    expect(status.lastAttachCode).toBeNull();
    expect(status.connectingSince).toBeNull();
    expect(status.lastError).toBeNull();
  });

  it('tracks connecting state', () => {
    setFollowerTrayRuntimeStatus(
      makeStatus({
        state: 'connecting',
        joinUrl: 'https://tray.example.com/join/token',
      })
    );
    const status = getFollowerTrayRuntimeStatus();
    expect(status.state).toBe('connecting');
    expect(status.joinUrl).toBe('https://tray.example.com/join/token');
  });

  it('tracks connected state with trayId', () => {
    setFollowerTrayRuntimeStatus(
      makeStatus({
        state: 'connected',
        joinUrl: 'https://tray.example.com/join/token',
        trayId: 'tray-123',
      })
    );
    const status = getFollowerTrayRuntimeStatus();
    expect(status.state).toBe('connected');
    expect(status.trayId).toBe('tray-123');
  });

  it('tracks error state', () => {
    setFollowerTrayRuntimeStatus(
      makeStatus({
        state: 'error',
        joinUrl: 'https://tray.example.com/join/token',
        error: 'Connection failed',
      })
    );
    const status = getFollowerTrayRuntimeStatus();
    expect(status.state).toBe('error');
    expect(status.error).toBe('Connection failed');
  });

  it('returns a copy, not the internal reference', () => {
    setFollowerTrayRuntimeStatus(
      makeStatus({
        state: 'connected',
        joinUrl: 'https://tray.example.com/join/token',
        trayId: 'tray-123',
      })
    );
    const a = getFollowerTrayRuntimeStatus();
    const b = getFollowerTrayRuntimeStatus();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it('tracks reconnecting state with attempt count', () => {
    setFollowerTrayRuntimeStatus(
      makeStatus({
        state: 'reconnecting',
        joinUrl: 'https://tray.example.com/join/token',
        trayId: 'tray-123',
        lastPingTime: 1710000000000,
        reconnectAttempts: 3,
      })
    );
    const status = getFollowerTrayRuntimeStatus();
    expect(status.state).toBe('reconnecting');
    expect(status.reconnectAttempts).toBe(3);
    expect(status.lastPingTime).toBe(1710000000000);
  });

  it('resetReconnectAttempts resets counter without changing other fields', () => {
    setFollowerTrayRuntimeStatus(
      makeStatus({
        state: 'reconnecting',
        joinUrl: 'https://tray.example.com/join/token',
        trayId: 'tray-123',
        lastPingTime: 1710000000000,
        reconnectAttempts: 5,
      })
    );
    resetReconnectAttempts();
    const status = getFollowerTrayRuntimeStatus();
    expect(status.reconnectAttempts).toBe(0);
    expect(status.state).toBe('reconnecting');
    expect(status.trayId).toBe('tray-123');
    expect(status.lastPingTime).toBe(1710000000000);
  });

  it('tracks lastPingTime when connected', () => {
    const now = Date.now();
    setFollowerTrayRuntimeStatus(
      makeStatus({
        state: 'connected',
        joinUrl: 'https://tray.example.com/join/token',
        trayId: 'tray-123',
        lastPingTime: now,
      })
    );
    const status = getFollowerTrayRuntimeStatus();
    expect(status.lastPingTime).toBe(now);
  });

  it('setFollowerLastPingTime updates only lastPingTime', () => {
    setFollowerTrayRuntimeStatus(
      makeStatus({
        state: 'connected',
        joinUrl: 'https://tray.example.com/join/token',
        trayId: 'tray-123',
      })
    );
    const now = 1710000099999;
    setFollowerLastPingTime(now);
    const status = getFollowerTrayRuntimeStatus();
    expect(status.lastPingTime).toBe(now);
    expect(status.state).toBe('connected');
    expect(status.trayId).toBe('tray-123');
    expect(status.reconnectAttempts).toBe(0);
  });

  it('tracks diagnostic fields for connecting state', () => {
    const connectingSince = Date.now();
    setFollowerTrayRuntimeStatus(
      makeStatus({
        state: 'connecting',
        joinUrl: 'https://tray.example.com/join/token',
        attachAttempts: 5,
        lastAttachCode: 'LEADER_NOT_ELECTED',
        connectingSince,
        lastError: 'some transient error',
      })
    );
    const status = getFollowerTrayRuntimeStatus();
    expect(status.attachAttempts).toBe(5);
    expect(status.lastAttachCode).toBe('LEADER_NOT_ELECTED');
    expect(status.connectingSince).toBe(connectingSince);
    expect(status.lastError).toBe('some transient error');
  });
});

describe('subscribeToFollowerTrayRuntimeStatus', () => {
  // Mirrors the leader-side subscriber contract: every setter (including
  // resetReconnectAttempts and setFollowerLastPingTime) must notify so
  // the offscreen→panel pipe doesn't drop intermediate states.
  beforeEach(() => {
    setFollowerTrayRuntimeStatus(makeStatus());
  });

  it('fires on setFollowerTrayRuntimeStatus and respects unsubscribe', () => {
    const states: string[] = [];
    const unsubscribe = subscribeToFollowerTrayRuntimeStatus((s) => states.push(s.state));

    setFollowerTrayRuntimeStatus(makeStatus({ state: 'connecting' }));
    setFollowerTrayRuntimeStatus(makeStatus({ state: 'connected' }));
    unsubscribe();
    setFollowerTrayRuntimeStatus(makeStatus({ state: 'disconnected' as never }));

    expect(states).toEqual(['connecting', 'connected']);
  });

  it('gives each listener its own snapshot so mutations do not leak', () => {
    const observed: string[] = [];
    const unsubscribeBad = subscribeToFollowerTrayRuntimeStatus((status) => {
      (status as { state: string }).state = 'inactive';
    });
    const unsubscribeGood = subscribeToFollowerTrayRuntimeStatus((status) => {
      observed.push(status.state);
    });

    setFollowerTrayRuntimeStatus(makeStatus({ state: 'connected' }));

    expect(observed).toEqual(['connected']);
    unsubscribeBad();
    unsubscribeGood();
  });

  it('also fires on resetReconnectAttempts and setFollowerLastPingTime', () => {
    setFollowerTrayRuntimeStatus(
      makeStatus({ state: 'connected', reconnectAttempts: 5, lastPingTime: 0 })
    );
    const calls: number[] = [];
    const unsubscribe = subscribeToFollowerTrayRuntimeStatus((s) => {
      calls.push(s.lastPingTime ?? -1);
    });

    resetReconnectAttempts();
    setFollowerLastPingTime(123);

    expect(calls).toEqual([0, 123]);
    expect(getFollowerTrayRuntimeStatus().reconnectAttempts).toBe(0);
    unsubscribe();
  });
});

describe('getFollowerStatusWithFallback (standalone-worker path)', () => {
  // Symmetric to getLeaderStatusWithFallback: the standalone kernel-worker
  // thread never runs the FollowerSyncManager (it lives on the page), so its
  // module global is permanently `inactive`. Without this fallback the worker
  // -side `host` command reports `status: inactive` while the page-side
  // follower is genuinely connected — the exact b268 symptom (chat synced +
  // screenshot worked, but `host` said inactive). The fallback reads the
  // `slicc.followerTrayStatus` shim that `wc-tray.ts` mirrors on the page.
  let original: Storage | undefined;
  let store: Map<string, string>;

  beforeEach(() => {
    setFollowerTrayRuntimeStatus(makeStatus());
    store = new Map<string, string>();
    original = (globalThis as { localStorage?: Storage }).localStorage;
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    } as unknown as Storage;
  });

  afterEach(() => {
    setFollowerTrayRuntimeStatus(makeStatus());
    if (original === undefined) delete (globalThis as { localStorage?: Storage }).localStorage;
    else (globalThis as { localStorage?: Storage }).localStorage = original;
  });

  it('reads a connected follower from the shim when the module global is inactive', () => {
    store.set(
      FOLLOWER_STATUS_STORAGE_KEY,
      JSON.stringify(
        makeStatus({
          state: 'connected',
          joinUrl: 'https://www.sliccy.ai/join/abc.def',
          trayId: 'tray-xyz',
        })
      )
    );
    const status = getFollowerStatusWithFallback();
    expect(status.state).toBe('connected');
    expect(status.joinUrl).toBe('https://www.sliccy.ai/join/abc.def');
    expect(status.trayId).toBe('tray-xyz');
  });

  it('prefers the module global when it is non-inactive (extension/offscreen owns it)', () => {
    setFollowerTrayRuntimeStatus(makeStatus({ state: 'connecting', joinUrl: 'live://global' }));
    store.set(
      FOLLOWER_STATUS_STORAGE_KEY,
      JSON.stringify(makeStatus({ state: 'connected', joinUrl: 'stale://shim' }))
    );
    const status = getFollowerStatusWithFallback();
    expect(status.state).toBe('connecting');
    expect(status.joinUrl).toBe('live://global');
  });

  it('returns the inactive module global when the shim is absent', () => {
    expect(getFollowerStatusWithFallback().state).toBe('inactive');
  });

  it('ignores an inactive shim value (a seeded/cleared shim is not a follower)', () => {
    store.set(FOLLOWER_STATUS_STORAGE_KEY, JSON.stringify(makeStatus({ state: 'inactive' })));
    expect(getFollowerStatusWithFallback().state).toBe('inactive');
  });

  it('swallows a malformed shim value and falls back to the module global', () => {
    store.set(FOLLOWER_STATUS_STORAGE_KEY, '{not json');
    expect(getFollowerStatusWithFallback().state).toBe('inactive');
  });
});
