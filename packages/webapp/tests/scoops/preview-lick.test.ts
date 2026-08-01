/**
 * Tests for 'preview' lifecycle lick emission + formatting.
 */

import type { WorkerBridgeConnected } from '@slicc/shared-ts';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { formatLickEventForCone } from '../../src/scoops/lick-formatting.js';
import type { LickEvent } from '../../src/scoops/lick-manager.js';
import { LeaderSyncManager } from '../../src/scoops/tray-leader-sync.js';

describe('preview lifecycle lick', () => {
  let emitLick: Mock<(event: LickEvent) => void>;
  let mgr: LeaderSyncManager;

  beforeEach(() => {
    emitLick = vi.fn<(event: LickEvent) => void>();
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

  it('never emits a preview lifecycle lick on disconnect', () => {
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

    mgr.onBridgeDisconnected({
      type: 'bridge.disconnected',
      connId: 'c1',
      reason: 'user closed',
    });

    expect(emitLick).not.toHaveBeenCalled();
  });

  it('emits only once across 101 connections for the same preview', () => {
    const base = {
      previewToken: 't.s',
      origin: 'https://example.com',
      userAgent: 'Test UA',
      connectedAt: '2026-07-02T12:00:00.000Z',
    };

    mgr.onBridgeConnected({ type: 'bridge.connected', connId: 'c1', ...base });
    for (let index = 0; index < 100; index += 1) {
      mgr.onBridgeConnected({ type: 'bridge.connected', connId: `later-${index}`, ...base });
    }

    expect(emitLick).toHaveBeenCalledTimes(1);
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

  it('re-arms a preview announcement explicitly', () => {
    const base: Omit<WorkerBridgeConnected, 'connId'> = {
      type: 'bridge.connected',
      previewToken: 't.s',
      origin: 'https://example.com',
      userAgent: 'Test UA',
      connectedAt: '2026-07-02T12:00:00.000Z',
    };

    mgr.onBridgeConnected({ ...base, connId: 'c1' });
    mgr.onBridgeConnected({ ...base, connId: 'c2' });
    expect(emitLick).toHaveBeenCalledTimes(1);

    expect(mgr.rearmPreviewAnnouncements('t.s')).toBe(1);
    mgr.onBridgeConnected({ ...base, connId: 'c3' });
    expect(emitLick).toHaveBeenCalledTimes(2);
  });

  it('suppresses preview lick when quiet is true', () => {
    mgr.registerMintedPreview('t.quiet', {
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
