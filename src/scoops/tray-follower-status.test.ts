import { describe, expect, it, beforeEach } from 'vitest';
import {
  getFollowerTrayRuntimeStatus,
  setFollowerTrayRuntimeStatus,
} from './tray-follower-status.js';

describe('follower tray runtime status', () => {
  beforeEach(() => {
    setFollowerTrayRuntimeStatus({
      state: 'inactive',
      joinUrl: null,
      trayId: null,
      error: null,
    });
  });

  it('defaults to inactive', () => {
    const status = getFollowerTrayRuntimeStatus();
    expect(status.state).toBe('inactive');
    expect(status.joinUrl).toBeNull();
    expect(status.trayId).toBeNull();
    expect(status.error).toBeNull();
  });

  it('tracks connecting state', () => {
    setFollowerTrayRuntimeStatus({
      state: 'connecting',
      joinUrl: 'https://tray.example.com/join/token',
      trayId: null,
      error: null,
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
    });
    const a = getFollowerTrayRuntimeStatus();
    const b = getFollowerTrayRuntimeStatus();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});
