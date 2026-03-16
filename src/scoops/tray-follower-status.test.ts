import { describe, expect, it, beforeEach } from 'vitest';
import {
  getFollowerTrayRuntimeStatus,
  setFollowerTrayRuntimeStatus,
  resetReconnectAttempts,
  setFollowerLastPingTime,
} from './tray-follower-status.js';

describe('follower tray runtime status', () => {
  beforeEach(() => {
    setFollowerTrayRuntimeStatus({
      state: 'inactive',
      joinUrl: null,
      trayId: null,
      error: null,
      lastPingTime: null,
      reconnectAttempts: 0,
    });
  });

  it('defaults to inactive', () => {
    const status = getFollowerTrayRuntimeStatus();
    expect(status.state).toBe('inactive');
    expect(status.joinUrl).toBeNull();
    expect(status.trayId).toBeNull();
    expect(status.error).toBeNull();
    expect(status.lastPingTime).toBeNull();
    expect(status.reconnectAttempts).toBe(0);
  });

  it('tracks connecting state', () => {
    setFollowerTrayRuntimeStatus({
      state: 'connecting',
      joinUrl: 'https://tray.example.com/join/token',
      trayId: null,
      error: null,
      lastPingTime: null,
      reconnectAttempts: 0,
    });
    const status = getFollowerTrayRuntimeStatus();
    expect(status.state).toBe('connecting');
    expect(status.joinUrl).toBe('https://tray.example.com/join/token');
  });

  it('tracks connected state with trayId', () => {
    setFollowerTrayRuntimeStatus({
      state: 'connected',
      joinUrl: 'https://tray.example.com/join/token',
      trayId: 'tray-123',
      error: null,
      lastPingTime: null,
      reconnectAttempts: 0,
    });
    const status = getFollowerTrayRuntimeStatus();
    expect(status.state).toBe('connected');
    expect(status.trayId).toBe('tray-123');
  });

  it('tracks error state', () => {
    setFollowerTrayRuntimeStatus({
      state: 'error',
      joinUrl: 'https://tray.example.com/join/token',
      trayId: null,
      error: 'Connection failed',
      lastPingTime: null,
      reconnectAttempts: 0,
    });
    const status = getFollowerTrayRuntimeStatus();
    expect(status.state).toBe('error');
    expect(status.error).toBe('Connection failed');
  });

  it('returns a copy, not the internal reference', () => {
    setFollowerTrayRuntimeStatus({
      state: 'connected',
      joinUrl: 'https://tray.example.com/join/token',
      trayId: 'tray-123',
      error: null,
      lastPingTime: null,
      reconnectAttempts: 0,
    });
    const a = getFollowerTrayRuntimeStatus();
    const b = getFollowerTrayRuntimeStatus();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it('tracks reconnecting state with attempt count', () => {
    setFollowerTrayRuntimeStatus({
      state: 'reconnecting',
      joinUrl: 'https://tray.example.com/join/token',
      trayId: 'tray-123',
      error: null,
      lastPingTime: 1710000000000,
      reconnectAttempts: 3,
    });
    const status = getFollowerTrayRuntimeStatus();
    expect(status.state).toBe('reconnecting');
    expect(status.reconnectAttempts).toBe(3);
    expect(status.lastPingTime).toBe(1710000000000);
  });

  it('resetReconnectAttempts resets counter without changing other fields', () => {
    setFollowerTrayRuntimeStatus({
      state: 'reconnecting',
      joinUrl: 'https://tray.example.com/join/token',
      trayId: 'tray-123',
      error: null,
      lastPingTime: 1710000000000,
      reconnectAttempts: 5,
    });
    resetReconnectAttempts();
    const status = getFollowerTrayRuntimeStatus();
    expect(status.reconnectAttempts).toBe(0);
    expect(status.state).toBe('reconnecting');
    expect(status.trayId).toBe('tray-123');
    expect(status.lastPingTime).toBe(1710000000000);
  });

  it('tracks lastPingTime when connected', () => {
    const now = Date.now();
    setFollowerTrayRuntimeStatus({
      state: 'connected',
      joinUrl: 'https://tray.example.com/join/token',
      trayId: 'tray-123',
      error: null,
      lastPingTime: now,
      reconnectAttempts: 0,
    });
    const status = getFollowerTrayRuntimeStatus();
    expect(status.lastPingTime).toBe(now);
  });

  it('setFollowerLastPingTime updates only lastPingTime', () => {
    setFollowerTrayRuntimeStatus({
      state: 'connected',
      joinUrl: 'https://tray.example.com/join/token',
      trayId: 'tray-123',
      error: null,
      lastPingTime: null,
      reconnectAttempts: 0,
    });
    const now = 1710000099999;
    setFollowerLastPingTime(now);
    const status = getFollowerTrayRuntimeStatus();
    expect(status.lastPingTime).toBe(now);
    expect(status.state).toBe('connected');
    expect(status.trayId).toBe('tray-123');
    expect(status.reconnectAttempts).toBe(0);
  });
});
