import { describe, expect, it } from 'vitest';
import { projectTrayRuntimeStatus } from '../../../src/kernel/facade/tray-runtime.js';

describe('projectTrayRuntimeStatus', () => {
  it('defensively maps only tray snapshot fields and defaults leader diagnostics', () => {
    const snapshot = projectTrayRuntimeStatus(
      {
        state: 'leader',
        session: {
          workerBaseUrl: 'https://tray.example',
          trayId: 'tray-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          controllerId: 'controller-1',
          controllerUrl: 'https://tray.example/controller',
          joinUrl: 'https://tray.example/join',
          webhookUrl: 'https://tray.example/webhook',
          runtime: 'extension',
        },
        error: null,
      },
      {
        state: 'connected',
        joinUrl: 'https://tray.example/join',
        trayId: 'tray-1',
        error: null,
        lastError: null,
        reconnectAttempts: 2,
        attachAttempts: 3,
        lastAttachCode: 'LEADER_CONNECTED',
        connectingSince: 10,
        lastPingTime: 20,
        stalled: true,
      }
    );

    expect(snapshot.leader.reconnectAttempts).toBe(0);
    expect(snapshot.follower).not.toHaveProperty('stalled');
    expect(snapshot.follower).toEqual({
      state: 'connected',
      joinUrl: 'https://tray.example/join',
      trayId: 'tray-1',
      error: null,
      lastError: null,
      reconnectAttempts: 2,
      attachAttempts: 3,
      lastAttachCode: 'LEADER_CONNECTED',
      connectingSince: 10,
      lastPingTime: 20,
    });
  });
});
