/**
 * Tests for 'preview' lifecycle lick emission + formatting.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatLickEventForCone } from '../../src/scoops/lick-formatting.js';
import type { LickEvent } from '../../src/scoops/lick-manager.js';
import { LeaderSyncManager } from '../../src/scoops/tray-leader-sync.js';
import type { WorkerBridgeConnected } from '../../src/scoops/tray-types.js';

describe('preview lifecycle lick', () => {
  let emitLick: ReturnType<typeof vi.fn>;
  let mgr: LeaderSyncManager;

  beforeEach(() => {
    emitLick = vi.fn();
    mgr = new LeaderSyncManager({
      getMessages: () => [],
      getScoopJid: () => 'cone-jid',
      onFollowerMessage: () => {},
      onFollowerAbort: () => {},
      sendControl: () => {},
      onPreviewLick: emitLick,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('emits a preview lifecycle lick on connect', () => {
    const connectMsg: WorkerBridgeConnected = {
      type: 'bridge.connected',
      connId: 'c1',
      previewToken: 't.s',
      origin: 'https://example.com',
      userAgent: 'Test UA',
      connectedAt: '2026-07-02T12:00:00.000Z',
    };

    mgr.onBridgeConnected(connectMsg);

    expect(emitLick).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'preview',
        previewLifecycle: 'connected',
        previewConnId: 'c1',
        previewToken: 't.s',
        previewOrigin: 'https://example.com',
        previewUserAgent: 'Test UA',
        previewConnectedAt: '2026-07-02T12:00:00.000Z',
      })
    );
  });

  it('emits a preview lifecycle lick on disconnect', () => {
    // First connect
    const connectMsg: WorkerBridgeConnected = {
      type: 'bridge.connected',
      connId: 'c1',
      previewToken: 't.s',
      origin: 'https://example.com',
      userAgent: 'Test UA',
      connectedAt: '2026-07-02T12:00:00.000Z',
    };
    mgr.onBridgeConnected(connectMsg);
    emitLick.mockClear();

    // No manual rate-limiter reset: connect and disconnect use separate throttle
    // buckets, so the disconnect fires even immediately after the connect.
    mgr.onBridgeDisconnected({
      type: 'bridge.disconnected',
      connId: 'c1',
      reason: 'user closed',
    });

    expect(emitLick).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'preview',
        previewLifecycle: 'disconnected',
        previewConnId: 'c1',
        previewToken: 't.s',
        previewOrigin: 'https://example.com',
        previewUserAgent: 'Test UA',
        previewConnectedAt: '2026-07-02T12:00:00.000Z',
      })
    );
  });

  it('still fires the disconnect lick for a quick visit (within the connect throttle window)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-02T12:00:00.000Z'));
    const base = {
      previewToken: 't.s',
      origin: 'https://example.com',
      userAgent: 'Test UA',
      connectedAt: '2026-07-02T12:00:00.000Z',
    };

    // Visitor opens the tab (connect lick fires)...
    mgr.onBridgeConnected({ type: 'bridge.connected', connId: 'c1', ...base });
    expect(emitLick).toHaveBeenCalledTimes(1);

    // ...and closes it 1s later, INSIDE the 2s throttle window. The disconnect
    // must still fire — otherwise the cone would believe the tab is still live.
    vi.advanceTimersByTime(1000);
    mgr.onBridgeDisconnected({ type: 'bridge.disconnected', connId: 'c1', reason: 'closed' });
    expect(emitLick).toHaveBeenCalledTimes(2);
    expect(emitLick).toHaveBeenLastCalledWith(
      expect.objectContaining({ previewLifecycle: 'disconnected', previewConnId: 'c1' })
    );

    vi.useRealTimers();
  });

  it('ignores a duplicate bridge.connected for a known connId (reconnect replay is idempotent)', () => {
    const msg: WorkerBridgeConnected = {
      type: 'bridge.connected',
      connId: 'c1',
      previewToken: 't.s',
      origin: 'https://example.com',
      userAgent: 'Test UA',
      connectedAt: '2026-07-02T12:00:00.000Z',
    };
    mgr.onBridgeConnected(msg);
    const transport = mgr.getBridgeTransport('c1');
    // A replayed bridge.connected (same connId) must not build a second transport.
    mgr.onBridgeConnected(msg);
    expect(mgr.getBridgeTransport('c1')).toBe(transport);
    expect((mgr as any).bridgeConns.size).toBe(1);
  });

  it('rate-limits lifecycle licks per token (2s throttle) and re-fires after the window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-02T12:00:00.000Z'));
    const base: Omit<WorkerBridgeConnected, 'connId'> = {
      type: 'bridge.connected',
      previewToken: 't.s',
      origin: 'https://example.com',
      userAgent: 'Test UA',
      connectedAt: '2026-07-02T12:00:00.000Z',
    };

    // Two rapid connects under the SAME token → only the first lick fires.
    mgr.onBridgeConnected({ ...base, connId: 'c1' });
    mgr.onBridgeConnected({ ...base, connId: 'c2' });
    expect(emitLick).toHaveBeenCalledTimes(1);

    // Past the 2s window → a subsequent event fires again.
    vi.advanceTimersByTime(2001);
    mgr.onBridgeConnected({ ...base, connId: 'c3' });
    expect(emitLick).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('suppresses preview lick when quiet is true', () => {
    // Mint with quiet=true
    (mgr as any).mintMap.set('t.quiet', {
      url: 'https://quiet.com',
      title: 'Quiet Preview',
      quiet: true,
    });

    const connectMsg: WorkerBridgeConnected = {
      type: 'bridge.connected',
      connId: 'c1',
      previewToken: 't.quiet',
      origin: 'https://quiet.com',
      userAgent: 'Test UA',
      connectedAt: '2026-07-02T12:00:00.000Z',
    };

    mgr.onBridgeConnected(connectMsg);

    // Should NOT have called emitLick
    expect(emitLick).not.toHaveBeenCalled();
  });

  it('formats a preview connected lick to non-null content', () => {
    const event: LickEvent = {
      type: 'preview',
      previewLifecycle: 'connected',
      previewConnId: 'c1',
      previewOrigin: 'https://example.com',
      previewToken: 't.s',
      previewUserAgent: 'Test UA',
      previewConnectedAt: '2026-07-02T12:00:00.000Z',
      timestamp: '2026-07-02T12:00:00.000Z',
      body: {},
    } as any;

    const formatted = formatLickEventForCone(event);

    expect(formatted).not.toBeNull();
    expect(formatted?.label).toBe('Preview');
    expect(formatted?.content).toContain('Preview tab connected');
    expect(formatted?.content).toContain('https://example.com');
  });

  it('formats a preview disconnected lick to non-null content', () => {
    const event: LickEvent = {
      type: 'preview',
      previewLifecycle: 'disconnected',
      previewConnId: 'c1',
      previewOrigin: 'https://example.com',
      previewToken: 't.s',
      previewUserAgent: 'Test UA',
      previewConnectedAt: '2026-07-02T12:00:00.000Z',
      timestamp: '2026-07-02T12:00:00.000Z',
      body: {},
    } as any;

    const formatted = formatLickEventForCone(event);

    expect(formatted).not.toBeNull();
    expect(formatted?.label).toBe('Preview');
    expect(formatted?.content).toContain('Preview tab disconnected');
    expect(formatted?.content).toContain('https://example.com');
  });
});
