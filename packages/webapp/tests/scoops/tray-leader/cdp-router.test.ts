import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/base/logger.js';
import type { CDPTransport } from '../../../src/cdp/transport.js';
import { CDPRouter } from '../../../src/scoops/tray-leader/cdp-router.js';
import type { LeaderSyncContext } from '../../../src/scoops/tray-leader/context.js';
import {
  type ConnectedFollower,
  FollowerRegistry,
} from '../../../src/scoops/tray-leader/follower-registry.js';
import type { LeaderSyncManagerOptions } from '../../../src/scoops/tray-leader-sync.js';
import type { LeaderToFollowerMessage } from '../../../src/scoops/tray-sync-protocol.js';

function createLog(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function addFollower(registry: FollowerRegistry, bootstrapId: string) {
  const sent: LeaderToFollowerMessage[] = [];
  const send = vi.fn((message: LeaderToFollowerMessage) => {
    sent.push(message);
    return true;
  });
  registry.followers.set(bootstrapId, {
    bootstrapId,
    sync: { send, close: vi.fn() },
    unsubscribe: vi.fn(),
    keepalive: { stop: vi.fn() },
  } as unknown as ConnectedFollower);
  return { sent };
}

function createHarness(overrides: Partial<LeaderSyncManagerOptions> = {}) {
  const log = createLog();
  const followers = new FollowerRegistry({ log, onMessage: vi.fn() });
  const options: LeaderSyncManagerOptions = {
    getMessages: () => [],
    getScoopJid: () => 'cone',
    onFollowerMessage: vi.fn(),
    onFollowerAbort: vi.fn(),
    sendControl: vi.fn(),
    ...overrides,
  };
  const context: LeaderSyncContext = {
    options,
    followers,
    log,
    sendControl: options.sendControl,
  };
  const router = new CDPRouter(context, { getBridgeTransport: () => undefined });
  return { followers, router, log };
}

function createFocusTransport(
  targetIds: string[],
  initialFocus: string | null,
  exposeActive = true
) {
  const targets = new Set(targetIds);
  const sessionTargets = new Map<string, string>();
  const bringCalls: string[] = [];
  let focusedTargetId = initialFocus;
  let failingBringTargetId: string | null = null;
  let sessionCounter = 0;
  const send = vi.fn(
    async (
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string
    ): Promise<Record<string, unknown>> => {
      if (method === 'Target.getTargets') {
        return {
          targetInfos: [...targets].map((targetId) => ({
            targetId,
            type: 'page',
            title: targetId,
            url: `https://${targetId}.example.com`,
            attached: false,
            ...(exposeActive ? { active: targetId === focusedTargetId } : {}),
          })),
        };
      }
      if (method === 'Target.attachToTarget') {
        const targetId = params?.['targetId'];
        if (typeof targetId !== 'string' || !targets.has(targetId)) {
          throw new Error('No target with given id');
        }
        const attachedSessionId = `temporary-${targetId}-${++sessionCounter}`;
        sessionTargets.set(attachedSessionId, targetId);
        return { sessionId: attachedSessionId };
      }
      if (method === 'Target.detachFromTarget') {
        const detachedSessionId = params?.['sessionId'];
        if (typeof detachedSessionId === 'string') sessionTargets.delete(detachedSessionId);
        return {};
      }

      const targetId =
        (sessionId ? sessionTargets.get(sessionId) : undefined) ??
        (sessionId?.startsWith('session-') ? sessionId.slice('session-'.length) : undefined);
      if (!targetId || !targets.has(targetId)) throw new Error('Session target is gone');
      if (method === 'Runtime.evaluate') {
        return { result: { value: targetId === focusedTargetId } };
      }
      if (method === 'Page.bringToFront') {
        if (targetId === failingBringTargetId) {
          failingBringTargetId = null;
          throw new Error('Focus restore failed');
        }
        focusedTargetId = targetId;
        bringCalls.push(targetId);
        return {};
      }
      return {};
    }
  );
  return {
    transport: {
      state: 'connected',
      connect: vi.fn(),
      disconnect: vi.fn(),
      send,
      on: vi.fn(),
      off: vi.fn(),
      once: vi.fn(),
    } as unknown as CDPTransport,
    bringCalls,
    getFocusedTarget: () => focusedTargetId,
    setFocusedTarget: (targetId: string) => {
      focusedTargetId = targetId;
    },
    failNextBringToFront: (targetId: string) => {
      failingBringTargetId = targetId;
    },
    removeTarget: (targetId: string) => {
      targets.delete(targetId);
    },
  };
}

function executePreview(router: CDPRouter, requestId: string, targetId: string): Promise<void> {
  return router.executeLocalCDP(
    requestId,
    targetId,
    'Page.bringToFront',
    {},
    `session-${targetId}`,
    'requester'
  );
}

describe('CDPRouter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('restores focus once after a burst of follower previews', async () => {
    vi.useFakeTimers();
    const focus = createFocusTransport(['leader', 'tab-1', 'tab-2', 'tab-3'], 'leader', false);
    const { followers, router } = createHarness({ browserTransport: focus.transport });
    addFollower(followers, 'requester');

    await Promise.all([
      executePreview(router, 'preview-1', 'tab-1'),
      executePreview(router, 'preview-2', 'tab-2'),
      executePreview(router, 'preview-3', 'tab-3'),
    ]);
    expect(focus.getFocusedTarget()).toBe('tab-3');

    await vi.runAllTimersAsync();

    expect(focus.getFocusedTarget()).toBe('leader');
    expect(focus.bringCalls).toEqual(['tab-1', 'tab-2', 'tab-3', 'leader']);
  });

  it('does not restore when the user switches tabs during the settle window', async () => {
    vi.useFakeTimers();
    const focus = createFocusTransport(['leader', 'preview', 'user-choice'], 'leader');
    const { followers, router } = createHarness({ browserTransport: focus.transport });
    addFollower(followers, 'requester');

    await executePreview(router, 'preview-1', 'preview');
    focus.setFocusedTarget('user-choice');
    await vi.runAllTimersAsync();

    expect(focus.getFocusedTarget()).toBe('user-choice');
    expect(focus.bringCalls).toEqual(['preview']);
  });

  it('does not restore when the previously focused target is gone', async () => {
    vi.useFakeTimers();
    const focus = createFocusTransport(['leader', 'preview'], 'leader');
    const { followers, router } = createHarness({ browserTransport: focus.transport });
    addFollower(followers, 'requester');

    await executePreview(router, 'preview-1', 'preview');
    focus.removeTarget('leader');
    await vi.runAllTimersAsync();

    expect(focus.getFocusedTarget()).toBe('preview');
    expect(focus.bringCalls).toEqual(['preview']);
  });

  it('does not restore when no focused target can be determined', async () => {
    vi.useFakeTimers();
    const focus = createFocusTransport(['preview'], null, false);
    const { followers, router } = createHarness({ browserTransport: focus.transport });
    addFollower(followers, 'requester');

    await executePreview(router, 'preview-1', 'preview');
    await vi.runAllTimersAsync();

    expect(focus.getFocusedTarget()).toBe('preview');
    expect(focus.bringCalls).toEqual(['preview']);
  });

  it('cancels teardown restoration and remains reusable after reset', async () => {
    vi.useFakeTimers();
    const focus = createFocusTransport(['leader', 'preview'], 'leader');
    const { followers, router } = createHarness({ browserTransport: focus.transport });
    addFollower(followers, 'requester');

    await executePreview(router, 'preview-before-stop', 'preview');
    router.resetPreviewFocus();
    await vi.runAllTimersAsync();
    expect(focus.bringCalls).toEqual(['preview']);

    focus.setFocusedTarget('leader');
    await executePreview(router, 'preview-after-reset', 'preview');
    await vi.runAllTimersAsync();
    expect(focus.bringCalls).toEqual(['preview', 'preview', 'leader']);
  });

  it('contains a thrown restore without breaking later preview bursts', async () => {
    vi.useFakeTimers();
    const focus = createFocusTransport(['leader', 'preview'], 'leader');
    const { followers, router, log } = createHarness({ browserTransport: focus.transport });
    addFollower(followers, 'requester');

    await executePreview(router, 'preview-failed-restore', 'preview');
    focus.failNextBringToFront('leader');
    await vi.runAllTimersAsync();
    expect(log.debug).toHaveBeenCalledWith(
      'Follower preview focus restore skipped',
      expect.objectContaining({ targetId: 'leader', error: 'Focus restore failed' })
    );

    focus.setFocusedTarget('leader');
    await executePreview(router, 'preview-after-failure', 'preview');
    await vi.runAllTimersAsync();
    expect(focus.bringCalls).toEqual(['preview', 'preview', 'leader']);
  });

  it('reassembles out-of-order chunked responses before forwarding them', () => {
    const { followers, router } = createHarness();
    const requester = addFollower(followers, 'requester');
    const target = addFollower(followers, 'target');
    followers.setRuntimeId('runtime-target', 'target');
    router.forwardCDPRequest(
      'request-1',
      'runtime-target',
      'tab-1',
      'Runtime.evaluate',
      { expression: '1 + 1' },
      undefined,
      'requester'
    );
    expect(target.sent).toEqual([
      expect.objectContaining({ type: 'cdp.request', requestId: 'request-1' }),
    ]);

    const result = { result: { value: 'chunked-value' } };
    const serialized = JSON.stringify(result);
    const midpoint = Math.floor(serialized.length / 2);
    router.handleCDPResponse({
      type: 'cdp.response',
      requestId: 'request-1',
      chunkData: serialized.slice(midpoint),
      chunkIndex: 1,
      totalChunks: 2,
    });
    expect(requester.sent).toEqual([]);

    router.handleCDPResponse({
      type: 'cdp.response',
      requestId: 'request-1',
      chunkData: serialized.slice(0, midpoint),
      chunkIndex: 0,
      totalChunks: 2,
    });
    expect(requester.sent).toEqual([{ type: 'cdp.response', requestId: 'request-1', result }]);
  });

  it('disconnect cleanup rejects pending transport requests before runtime removal', async () => {
    const cleanupOrder: string[] = [];
    let followers!: FollowerRegistry;
    const onRemoteTransportsCleaned = vi.fn((runtimeId: string) => {
      cleanupOrder.push('transport');
      expect(followers.runtimeToBootstrap.has(runtimeId)).toBe(true);
    });
    const harness = createHarness({ onRemoteTransportsCleaned });
    followers = harness.followers;
    addFollower(followers, 'target');
    followers.setRuntimeId('runtime-target', 'target');
    followers.onFollowerRemoved({
      removeRuntime: () => cleanupOrder.push('registry'),
    });
    const transport = harness.router.createRemoteTransport('runtime-target', 'tab-1');
    const pending = transport.send('Page.navigate', { url: 'https://example.com' });

    followers.removeFollower('target');

    await expect(pending).rejects.toThrow('Transport disconnected');
    expect(transport.state).toBe('disconnected');
    expect(onRemoteTransportsCleaned).toHaveBeenCalledWith('runtime-target');
    expect(cleanupOrder).toEqual(['transport', 'registry']);
    expect(followers.runtimeToBootstrap.has('runtime-target')).toBe(false);
  });
});
