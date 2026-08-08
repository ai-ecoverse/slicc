import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/base/logger.js';
import type { LeaderSyncContext } from '../../../src/scoops/tray-leader/context.js';
import { FollowerRegistry } from '../../../src/scoops/tray-leader/follower-registry.js';
import {
  PREVIEW_LIFECYCLE_RECORD_CAP,
  PreviewBridgeManager,
} from '../../../src/scoops/tray-leader/preview-bridge.js';
import type { LeaderSyncManagerOptions } from '../../../src/scoops/tray-leader-sync.js';

function createHarness() {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as Logger;
  const followers = new FollowerRegistry({ log, onMessage: vi.fn() });
  const options = {
    getMessages: () => [],
    getScoopJid: () => 'cone',
    onFollowerMessage: vi.fn(),
    onFollowerAbort: vi.fn(),
    sendControl: vi.fn(),
    onPreviewLick: vi.fn(),
  } satisfies LeaderSyncManagerOptions;
  const context: LeaderSyncContext = {
    options,
    followers,
    log,
    sendControl: options.sendControl,
  };
  return { bridge: new PreviewBridgeManager(context), options };
}

describe('PreviewBridgeManager', () => {
  it('uses minted metadata for target entries and tears down all state', () => {
    const { bridge, options } = createHarness();
    bridge.registerMintedPreview('token', {
      url: 'https://example.com/page',
      title: 'Example preview',
      quiet: false,
    });
    bridge.onBridgeConnected({
      type: 'bridge.connected',
      connId: 'conn',
      previewToken: 'token',
      origin: 'https://example.com',
      userAgent: 'test',
      connectedAt: '2026-07-27T00:00:00.000Z',
    });

    expect(bridge.getTargetEntries()).toEqual([
      expect.objectContaining({
        targetId: 'preview:token:conn',
        url: 'https://example.com/page',
        title: 'Example preview',
        kind: 'preview',
      }),
    ]);
    expect(options.onPreviewLick).toHaveBeenCalledWith(
      expect.objectContaining({ previewLifecycle: 'connected', previewConnId: 'conn' })
    );

    bridge.stop();
    expect(bridge.getBridgeTransport('conn')).toBeUndefined();
    expect(bridge.mintMap.size).toBe(0);
    expect(bridge.getPreviewLifecycleRecords()).toEqual([]);
  });

  it('records announced and suppressed connects plus disconnects', () => {
    const { bridge, options } = createHarness();
    const base = {
      type: 'bridge.connected' as const,
      previewToken: 'token',
      origin: 'https://example.com',
      userAgent: 'test',
      connectedAt: '2026-07-27T00:00:00.000Z',
    };

    bridge.onBridgeConnected({ ...base, connId: 'first' });
    bridge.onBridgeConnected({ ...base, connId: 'first' });
    bridge.onBridgeConnected({ ...base, connId: 'second' });
    bridge.onBridgeDisconnected({
      type: 'bridge.disconnected',
      connId: 'second',
      reason: 'closed',
    });

    expect(options.onPreviewLick).toHaveBeenCalledTimes(1);
    expect(bridge.getPreviewLifecycleRecords()).toEqual([
      expect.objectContaining({ lifecycle: 'connected', connId: 'first', announced: true }),
      expect.objectContaining({ lifecycle: 'connected', connId: 'first', announced: false }),
      expect.objectContaining({ lifecycle: 'connected', connId: 'second', announced: false }),
      expect.objectContaining({
        lifecycle: 'disconnected',
        connId: 'second',
        reason: 'closed',
        announced: false,
      }),
    ]);

    bridge.onBridgeDisconnected({
      type: 'bridge.disconnected',
      connId: 'unknown',
      reason: 'worker replay',
    });
    const unknownDisconnect = bridge.getPreviewLifecycleRecords().at(-1);
    expect(unknownDisconnect).toEqual(
      expect.objectContaining({
        lifecycle: 'disconnected',
        connId: 'unknown',
        announced: false,
      })
    );
    expect(unknownDisconnect).not.toHaveProperty('previewToken');
  });

  it('resyncs replayed connections without recording or announcing and preserves mint metadata', async () => {
    const { bridge, options } = createHarness();
    bridge.registerMintedPreview('token', {
      url: 'https://example.com/page',
      title: 'Existing preview',
      quiet: false,
    });
    const replay = (connId: string) =>
      bridge.onBridgeConnected({
        type: 'bridge.connected',
        connId,
        previewToken: 'token',
        origin: 'https://example.com',
        userAgent: 'test',
        connectedAt: '2026-07-27T00:00:00.000Z',
        replay: true,
      });

    replay('first');
    replay('second');

    expect(bridge.getTargetEntries()).toHaveLength(2);
    expect(bridge.getPreviewLifecycleRecords()).toEqual([]);
    expect(options.onPreviewLick).not.toHaveBeenCalled();
    expect(bridge.mintMap.get('token')).toEqual({
      url: 'https://example.com/page',
      title: 'Existing preview',
      quiet: false,
      announced: true,
    });

    const transport = bridge.getBridgeTransport('first');
    const response = transport!.send('Runtime.evaluate', { expression: '1 + 1' });
    const request = options.sendControl.mock.calls.find(
      ([message]) => message.type === 'bridge.cdp.request'
    )?.[0];
    if (request?.type !== 'bridge.cdp.request') {
      throw new Error('Expected replayed transport to send a CDP request');
    }
    bridge.onBridgeCdpResponse({
      type: 'bridge.cdp.response',
      connId: 'first',
      id: request.id,
      result: { value: 2 },
    });
    await expect(response).resolves.toEqual({ value: 2 });
  });

  it('restores durable state without a socket, then persists first visit and truncate transitions', () => {
    const { bridge, options } = createHarness();
    bridge.restorePreviewState({
      type: 'preview.state',
      previewToken: 'token',
      quiet: false,
      announced: false,
    });

    bridge.onBridgeConnected({
      type: 'bridge.connected',
      connId: 'first',
      previewToken: 'token',
      origin: 'https://example.com',
      userAgent: 'test',
      connectedAt: '2026-07-27T00:00:00.000Z',
    });
    expect(options.onPreviewLick).toHaveBeenCalledTimes(1);
    expect(options.sendControl).toHaveBeenCalledWith({
      type: 'preview.state.update',
      previewToken: 'token',
      announced: true,
    });

    expect(bridge.rearmPreviewAnnouncements('token')).toBe(1);
    expect(options.sendControl).toHaveBeenLastCalledWith({
      type: 'preview.state.update',
      previewToken: 'token',
      announced: false,
    });
  });

  it('synthesizes replay state silently and only upgrades announced on existing metadata', () => {
    const synthetic = createHarness();
    synthetic.bridge.onBridgeConnected({
      type: 'bridge.connected',
      connId: 'synthetic',
      previewToken: 'synthetic-token',
      origin: 'https://synthetic.example',
      userAgent: 'test',
      connectedAt: '2026-07-27T00:00:00.000Z',
      replay: true,
    });
    expect(synthetic.bridge.mintMap.get('synthetic-token')).toEqual({
      url: 'https://synthetic.example',
      title: 'Preview',
      quiet: true,
      announced: true,
    });
    expect(synthetic.options.onPreviewLick).not.toHaveBeenCalled();
    expect(synthetic.bridge.getPreviewLifecycleRecords()).toEqual([]);

    const existing = createHarness();
    existing.bridge.registerMintedPreview('token', {
      url: 'https://real.example/page',
      title: 'Real metadata',
      quiet: false,
    });
    existing.bridge.onBridgeConnected({
      type: 'bridge.connected',
      connId: 'existing',
      previewToken: 'token',
      origin: 'https://fallback.example',
      userAgent: 'test',
      connectedAt: '2026-07-27T00:00:00.000Z',
      replay: true,
    });
    expect(existing.bridge.mintMap.get('token')).toEqual({
      url: 'https://real.example/page',
      title: 'Real metadata',
      quiet: false,
      announced: true,
    });
  });

  it.each([
    { quiet: false, initialLicks: 1 },
    { quiet: true, initialLicks: 0 },
  ])('keeps a $quiet preview silent after a leader restart replay', ({ quiet, initialLicks }) => {
    const initial = createHarness();
    initial.bridge.registerMintedPreview('token', {
      url: 'https://example.com/page',
      title: 'Example preview',
      quiet,
    });
    initial.bridge.onBridgeConnected({
      type: 'bridge.connected',
      connId: 'before-restart',
      previewToken: 'token',
      origin: 'https://example.com',
      userAgent: 'test',
      connectedAt: '2026-07-27T00:00:00.000Z',
    });
    expect(initial.options.onPreviewLick).toHaveBeenCalledTimes(initialLicks);

    const restarted = createHarness();
    restarted.bridge.onBridgeConnected({
      type: 'bridge.connected',
      connId: 'replayed',
      previewToken: 'token',
      origin: 'https://example.com',
      userAgent: 'test',
      connectedAt: '2026-07-27T00:00:00.000Z',
      replay: true,
    });
    restarted.bridge.onBridgeConnected({
      type: 'bridge.connected',
      connId: 'after-restart',
      previewToken: 'token',
      origin: 'https://example.com',
      userAgent: 'test',
      connectedAt: '2026-07-27T00:01:00.000Z',
    });

    expect(restarted.options.onPreviewLick).not.toHaveBeenCalled();
    expect(restarted.bridge.mintMap.get('token')).toEqual(
      expect.objectContaining({ quiet: true, announced: true })
    );
    expect(restarted.bridge.getPreviewLifecycleRecords()).toEqual([
      expect.objectContaining({ connId: 'after-restart', announced: false }),
    ]);
  });

  it('re-arms one preview and never announces a quiet preview', () => {
    const { bridge, options } = createHarness();
    bridge.registerMintedPreview('normal', {
      url: 'https://normal.example',
      title: 'Normal',
      quiet: false,
    });
    bridge.registerMintedPreview('quiet', {
      url: 'https://quiet.example',
      title: 'Quiet',
      quiet: true,
    });
    const connect = (previewToken: string, connId: string) =>
      bridge.onBridgeConnected({
        type: 'bridge.connected',
        connId,
        previewToken,
        origin: `https://${previewToken}.example`,
        userAgent: 'test',
        connectedAt: '2026-07-27T00:00:00.000Z',
      });

    connect('normal', 'normal-1');
    connect('normal', 'normal-2');
    connect('quiet', 'quiet-1');
    expect(options.onPreviewLick).toHaveBeenCalledTimes(1);

    expect(bridge.rearmPreviewAnnouncements('normal')).toBe(1);
    connect('normal', 'normal-3');
    expect(options.onPreviewLick).toHaveBeenCalledTimes(2);
    expect(bridge.getPreviewLifecycleRecords('quiet')).toEqual([
      expect.objectContaining({ connId: 'quiet-1', announced: false }),
    ]);
  });

  it('bounds records as an oldest-first ring buffer', () => {
    const { bridge } = createHarness();
    for (let index = 0; index <= PREVIEW_LIFECYCLE_RECORD_CAP; index += 1) {
      bridge.onBridgeConnected({
        type: 'bridge.connected',
        connId: `conn-${index}`,
        previewToken: 'token',
        origin: 'https://example.com',
        userAgent: 'test',
        connectedAt: '2026-07-27T00:00:00.000Z',
      });
    }

    const records = bridge.getPreviewLifecycleRecords();
    expect(records).toHaveLength(PREVIEW_LIFECYCLE_RECORD_CAP);
    expect(records[0]?.connId).toBe('conn-1');
    expect(records.at(-1)?.connId).toBe(`conn-${PREVIEW_LIFECYCLE_RECORD_CAP}`);
  });

  it('clears only the dropped preview records and latch', () => {
    const { bridge, options } = createHarness();
    const connect = (previewToken: string, connId: string) =>
      bridge.onBridgeConnected({
        type: 'bridge.connected',
        connId,
        previewToken,
        origin: `https://${previewToken}.example`,
        userAgent: 'test',
        connectedAt: '2026-07-27T00:00:00.000Z',
      });
    connect('drop', 'drop-1');
    connect('keep', 'keep-1');

    bridge.dropMintedPreview('drop');
    expect(bridge.getPreviewLifecycleRecords().map((record) => record.previewToken)).toEqual([
      'keep',
    ]);
    expect(bridge.rearmPreviewAnnouncements('drop')).toBe(0);

    bridge.registerMintedPreview('drop', {
      url: 'https://drop.example',
      title: 'Drop',
      quiet: false,
    });
    connect('drop', 'drop-2');
    expect(options.onPreviewLick).toHaveBeenCalledTimes(3);
  });
});
