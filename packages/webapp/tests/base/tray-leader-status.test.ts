import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getLeaderStatusWithFallback,
  getLeaderTrayRuntimeStatus,
  LEADER_STATUS_STORAGE_KEY,
  setLeaderTrayRuntimeStatus,
  subscribeToLeaderTrayRuntimeStatus,
} from '../../src/base/tray-leader-status.js';

const legacySession = {
  workerBaseUrl: 'https://tray.example',
  trayId: 'tray',
  createdAt: '2026-01-01T00:00:00.000Z',
  controllerId: 'controller',
  controllerUrl: 'https://tray.example/controller/token',
  joinUrl: 'https://tray.example/join/token',
  webhookUrl: 'https://tray.example/wh/home.delivery',
  runtime: 'test',
  coneId: 'home',
  coneSecret: 'legacy-delivery-secret',
  rebindSecret: 'private-management-secret',
};

afterEach(() => {
  setLeaderTrayRuntimeStatus({ state: 'inactive', session: null, error: null });
  vi.unstubAllGlobals();
});

describe('leader status secret boundary', () => {
  it('omits legacy identity secrets from getters and subscriber snapshots', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToLeaderTrayRuntimeStatus(listener);
    try {
      setLeaderTrayRuntimeStatus({ state: 'leader', session: legacySession, error: null });
      for (const status of [getLeaderTrayRuntimeStatus(), listener.mock.calls[0][0]]) {
        expect(status.session.coneId).toBe('home');
        expect(status.session.webhookUrl).toBe(legacySession.webhookUrl);
        expect(status.session).not.toHaveProperty('coneSecret');
        expect(status.session).not.toHaveProperty('rebindSecret');
      }
    } finally {
      unsubscribe();
    }
  });

  it('sanitizes legacy localStorage fallback records too', () => {
    const getItem = vi.fn(() =>
      JSON.stringify({ state: 'leader', session: legacySession, error: null })
    );
    vi.stubGlobal('localStorage', { getItem });
    const status = getLeaderStatusWithFallback();
    expect(getItem).toHaveBeenCalledWith(LEADER_STATUS_STORAGE_KEY);
    expect(status.session).not.toHaveProperty('coneSecret');
    expect(status.session).not.toHaveProperty('rebindSecret');
    expect(status.session?.coneId).toBe('home');
  });
});
