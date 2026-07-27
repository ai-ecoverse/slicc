import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/core/logger.js';
import type { LeaderSyncContext } from '../../../src/scoops/tray-leader/context.js';
import { FollowerRegistry } from '../../../src/scoops/tray-leader/follower-registry.js';
import { PreviewBridgeManager } from '../../../src/scoops/tray-leader/preview-bridge.js';
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
  });
});
