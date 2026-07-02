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

    // Clear rate limiter to allow immediate disconnect lick
    (mgr as any).previewLickLastEmitAt.clear();

    // Now disconnect
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
