import { describe, it, expect } from 'vitest';

import { createStandalonePanelRpcHandlers } from '../../src/ui/panel-rpc-handlers.js';
import type { LeaderTrayRuntimeStatus } from '../../src/scoops/tray-leader.js';

/**
 * Targeted tests for the `tray-reset` panel-RPC handler. The factory
 * returns a record of handlers — most of them touch DOM APIs and are
 * covered elsewhere; this suite is concerned only with the tray-reset
 * branch, which has no DOM dependency.
 */

function leaderStatus(): LeaderTrayRuntimeStatus {
  return {
    state: 'leader',
    session: {
      workerBaseUrl: 'https://tray.example.com',
      trayId: 'tray-new',
      createdAt: '2026-05-17T00:00:00.000Z',
      controllerId: 'controller-1',
      controllerUrl: 'https://tray.example.com/controller/controller-1',
      joinUrl: 'https://tray.example.com/join/tray-new',
      webhookUrl: 'https://tray.example.com/webhooks/tray-new',
      leaderKey: 'leader-key',
      leaderWebSocketUrl: 'wss://tray.example.com/ws',
      runtime: 'slicc-standalone',
    },
    error: null,
  };
}

describe('createStandalonePanelRpcHandlers — tray-reset', () => {
  it('calls the resetTray callback and returns its result', async () => {
    let invocations = 0;
    const expected = leaderStatus();
    const handlers = createStandalonePanelRpcHandlers({
      resetTray: async () => {
        invocations += 1;
        return expected;
      },
    });
    const trayReset = handlers['tray-reset'];
    expect(trayReset).toBeTypeOf('function');
    const result = await trayReset!(undefined);
    expect(invocations).toBe(1);
    expect(result).toEqual(expected);
  });

  it('rejects with a clear error when no resetTray callback is wired', async () => {
    // Mirrors the standalone state where the page has not started a
    // leader tray (or the variable is still null). The handler should
    // surface this as an error string the worker can render.
    const handlers = createStandalonePanelRpcHandlers({});
    await expect(handlers['tray-reset']!(undefined)).rejects.toThrow(/no active tray session/i);
  });

  it('propagates a failure from the resetTray callback', async () => {
    const handlers = createStandalonePanelRpcHandlers({
      resetTray: async () => {
        throw new Error('tray worker unreachable');
      },
    });
    await expect(handlers['tray-reset']!(undefined)).rejects.toThrow(/tray worker unreachable/);
  });
});
