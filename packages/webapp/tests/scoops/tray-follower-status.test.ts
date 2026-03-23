import { describe, expect, it, beforeEach } from 'vitest';
import {
  getFollowerTrayRuntimeStatus,
  setFollowerTrayRuntimeStatus,
  resetReconnectAttempts,
  setFollowerLastPingTime,
  type FollowerTrayRuntimeStatus,
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
