import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/base/logger.js';
import type { LeaderSyncContext } from '../../../src/scoops/tray-leader/context.js';
import {
  type ConnectedFollower,
  FollowerRegistry,
} from '../../../src/scoops/tray-leader/follower-registry.js';
import { TabTeleportRouter } from '../../../src/scoops/tray-leader/tab-teleport-router.js';
import type { LeaderSyncManagerOptions } from '../../../src/scoops/tray-leader-sync.js';
import type {
  LeaderToFollowerMessage,
  TrayTargetEntry,
} from '../../../src/scoops/tray-sync-protocol.js';

const SOURCE_ENTRY: TrayTargetEntry = {
  targetId: 'leader:tab1',
  localTargetId: 'tab1',
  runtimeId: 'leader',
  title: 'Dashboard',
  url: 'https://dash.example',
  isLocal: false,
  kind: 'browser',
};

function createHarness(
  opts: {
    teleportTab?: ReturnType<typeof vi.fn>;
    entries?: TrayTargetEntry[];
    browserAPI?: unknown;
    advertiseRuntime?: boolean;
  } = {}
) {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as Logger;
  const followers = new FollowerRegistry({ log, onMessage: vi.fn() });
  const sent: LeaderToFollowerMessage[] = [];
  followers.followers.set('boot-1', {
    bootstrapId: 'boot-1',
    runtime: 'slicc-standalone',
    floatType: 'standalone',
    lastActivity: 1,
    keepalive: { stop: vi.fn() },
    unsubscribe: vi.fn(),
    sync: {
      send: vi.fn((message: LeaderToFollowerMessage) => {
        sent.push(message);
        return true;
      }),
      close: vi.fn(),
    },
  } as unknown as ConnectedFollower);
  if (opts.advertiseRuntime !== false) followers.setRuntimeId('runtime-1', 'boot-1');

  const options = {
    getMessages: () => [],
    getScoopJid: () => 'cone',
    onFollowerMessage: vi.fn(),
    onFollowerAbort: vi.fn(),
    sendControl: vi.fn(),
    browserAPI: 'browserAPI' in opts ? opts.browserAPI : {},
  } as unknown as LeaderSyncManagerOptions;
  const context: LeaderSyncContext = {
    options,
    followers,
    log,
    sendControl: options.sendControl,
  };
  const teleportTab =
    opts.teleportTab ??
    vi.fn(async () => ({
      targetId: 'runtime-1:new-tab',
      url: 'https://dash.example',
      cookieCount: 3,
      storageEntryCount: 2,
      degraded: 'none' as const,
    }));
  const router = new TabTeleportRouter(context, {
    getTargetEntries: () => opts.entries ?? [SOURCE_ENTRY],
    teleportTab: teleportTab as never,
  });
  return { followers, router, sent, teleportTab };
}

describe('TabTeleportRouter', () => {
  it('teleports the named tab onto the REQUESTING follower and replies tab.opened', async () => {
    const { router, sent, teleportTab } = createHarness();
    await router.handleTeleportRequest('boot-1', {
      type: 'tab.teleport.request',
      requestId: 'tp-1',
      targetId: 'leader:tab1',
    });

    // The destination comes from the channel identity, never the payload.
    // The SOURCE is addressed by its local id: `attachToPage` treats any id
    // with a colon as remote and would ask the tray for a transport to the
    // `leader` runtime, which no follower owns — so the composite form never
    // routes and the teleport hangs until it times out.
    expect(teleportTab).toHaveBeenCalledWith(expect.anything(), {
      sourceTargetId: 'tab1',
      destination: { kind: 'runtime', runtimeId: 'runtime-1' },
    });
    expect(sent).toEqual([
      { type: 'tab.opened', requestId: 'tp-1', targetId: 'runtime-1:new-tab' },
    ]);
  });

  it('rejects a source that is not in the tray registry', async () => {
    const { router, sent, teleportTab } = createHarness({ entries: [] });
    await router.handleTeleportRequest('boot-1', {
      type: 'tab.teleport.request',
      requestId: 'tp-2',
      targetId: 'leader:ghost',
    });
    expect(teleportTab).not.toHaveBeenCalled();
    expect(sent[0]).toEqual({
      type: 'tab.open.error',
      requestId: 'tp-2',
      error: expect.stringContaining('not in the tray registry'),
    });
  });

  it('rejects when the requester has not advertised a runtime yet', async () => {
    const { router, sent } = createHarness({ advertiseRuntime: false });
    await router.handleTeleportRequest('boot-1', {
      type: 'tab.teleport.request',
      requestId: 'tp-3',
      targetId: 'leader:tab1',
    });
    expect(sent[0]).toEqual({
      type: 'tab.open.error',
      requestId: 'tp-3',
      error: expect.stringContaining('has not advertised a runtime'),
    });
  });

  it('rejects when the leader has no BrowserAPI to drive the teleport', async () => {
    const { router, sent } = createHarness({ browserAPI: undefined });
    await router.handleTeleportRequest('boot-1', {
      type: 'tab.teleport.request',
      requestId: 'tp-4',
      targetId: 'leader:tab1',
    });
    expect(sent[0]).toEqual({
      type: 'tab.open.error',
      requestId: 'tp-4',
      error: expect.stringContaining('no BrowserAPI'),
    });
  });

  it('reports the underlying failure when the teleport itself throws', async () => {
    const teleportTab = vi.fn(async () => {
      throw new Error('destination refused cookies');
    });
    const { router, sent } = createHarness({ teleportTab });
    await router.handleTeleportRequest('boot-1', {
      type: 'tab.teleport.request',
      requestId: 'tp-5',
      targetId: 'leader:tab1',
    });
    expect(sent[0]).toEqual({
      type: 'tab.open.error',
      requestId: 'tp-5',
      error: 'destination refused cookies',
    });
  });

  it('drops an in-flight request when the requester disconnects (fail-closed)', async () => {
    let release!: () => void;
    const teleportTab = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              targetId: 'runtime-1:new-tab',
              url: 'https://dash.example',
              cookieCount: 0,
              storageEntryCount: 0,
              degraded: 'none',
            });
        })
    );
    const { followers, router, sent } = createHarness({ teleportTab });
    const pending = router.handleTeleportRequest('boot-1', {
      type: 'tab.teleport.request',
      requestId: 'tp-6',
      targetId: 'leader:tab1',
    });
    followers.removeFollower('boot-1');
    release();
    await pending;
    // No reply is sent to a channel that is already gone.
    expect(sent).toEqual([]);
  });
});
