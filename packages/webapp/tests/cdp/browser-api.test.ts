import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserAPI, getDefaultCdpUrl } from '../../src/cdp/browser-api.js';
import type { CDPClient } from '../../src/cdp/cdp-client.js';
import {
  CdpBridgeRejectedError,
  CdpReconnectBackoffError,
} from '../../src/cdp/cdp-reconnect-policy.js';
import { HarRecorder } from '../../src/cdp/har-recorder.js';
import { type RemoteCDPSender, RemoteCDPTransport } from '../../src/cdp/remote-cdp-transport.js';
import type { TabPage } from '../../src/cdp/tab-handle.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';

let dbCounter = 0;

function pngBase64(width: number): string {
  const bytes = [
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0,
    0,
    0,
    13,
    73,
    72,
    68,
    82,
    (width >>> 24) & 255,
    (width >>> 16) & 255,
    (width >>> 8) & 255,
    width & 255,
    0,
    0,
    0,
    100,
  ];
  return btoa(String.fromCharCode(...bytes));
}

function createMockClient() {
  const eventHandlers = new Map<string, Set<(params: Record<string, unknown>) => void>>();

  const mockClient = {
    state: 'connected' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    send: vi.fn().mockResolvedValue({}),
    on: vi.fn((event: string, handler: (params: Record<string, unknown>) => void) => {
      let set = eventHandlers.get(event);
      if (!set) {
        set = new Set();
        eventHandlers.set(event, set);
      }
      set.add(handler);
    }),
    off: vi.fn((event: string, handler: (params: Record<string, unknown>) => void) => {
      const set = eventHandlers.get(event);
      if (set) set.delete(handler);
    }),
    once: vi.fn().mockResolvedValue({}),

    _fireEvent(event: string, params: Record<string, unknown> = {}) {
      const set = eventHandlers.get(event);
      if (set) {
        for (const h of set) h(params);
      }
    },
  } as unknown as CDPClient & {
    _fireEvent: (event: string, params?: Record<string, unknown>) => void;
  };

  return mockClient;
}

function tabOf(api: BrowserAPI, targetId = 'target-1'): Promise<TabPage> {
  return api.withTab(targetId, async (page) => page);
}

describe('BrowserAPI', () => {
  let api: BrowserAPI;
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    mockClient = createMockClient();
    api = new BrowserAPI(mockClient as unknown as CDPClient);
  });

  describe('connect / disconnect', () => {
    it('derives the default URL from the current location when available', () => {
      expect(getDefaultCdpUrl({ protocol: 'https:', host: 'example.com' })).toBe(
        'wss://example.com/cdp'
      );
      expect(getDefaultCdpUrl({ protocol: 'http:', host: 'localhost:3030' })).toBe(
        'ws://localhost:3030/cdp'
      );
    });

    it('connects with default URL', async () => {
      await api.connect();
      expect(mockClient.connect).toHaveBeenCalledWith({
        url: 'ws://localhost:5710/cdp',
        timeout: undefined,
      });
    });

    it('connects with custom URL', async () => {
      await api.connect({ url: 'ws://custom:9222/cdp' });
      expect(mockClient.connect).toHaveBeenCalledWith({
        url: 'ws://custom:9222/cdp',
        timeout: undefined,
      });
    });

    it('disconnects and resets state', () => {
      api.disconnect();
      expect(mockClient.disconnect).toHaveBeenCalled();
    });
  });

  describe('superseded gate (duplicate-tab CDP war guard)', () => {
    it('does not reconnect a superseded local client and notifies once', async () => {
      (mockClient as unknown as { state: string }).state = 'disconnected';
      (mockClient as unknown as { superseded: boolean }).superseded = true;
      const onSuperseded = vi.fn();
      api.setCdpSupersededHandler(onSuperseded);

      await api.listPages();
      await api.listPages();

      expect(mockClient.connect).not.toHaveBeenCalled();

      expect(onSuperseded).toHaveBeenCalledTimes(1);
    });

    it('reconnects normally when the client is not superseded', async () => {
      (mockClient as unknown as { state: string }).state = 'disconnected';
      (mockClient as unknown as { superseded: boolean }).superseded = false;
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ targetInfos: [] });
      const onSuperseded = vi.fn();
      api.setCdpSupersededHandler(onSuperseded);

      await api.listPages();

      expect(mockClient.connect).toHaveBeenCalled();
      expect(onSuperseded).not.toHaveBeenCalled();
    });
  });

  describe('ensureConnected (lazy auto-connect)', () => {
    it('auto-connects when client is disconnected on listPages', async () => {
      (mockClient as unknown as { state: string }).state = 'disconnected';
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ targetInfos: [] });

      await api.listPages();

      expect(mockClient.connect).toHaveBeenCalledWith({
        url: 'ws://localhost:5710/cdp',
        timeout: undefined,
      });
    });

    it('does not reconnect when already connected', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ targetInfos: [] });

      await api.listPages();

      expect(mockClient.connect).not.toHaveBeenCalled();
    });

    it('resets sessionId and attachedTargetId on reconnect', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      await api.attachToPage('target-1');

      (mockClient as unknown as { state: string }).state = 'disconnected';

      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ targetInfos: [] });
      await api.listPages();

      expect(mockClient.connect).toHaveBeenCalled();
    });

    it('auto-connects on attachToPage when disconnected', async () => {
      (mockClient as unknown as { state: string }).state = 'disconnected';
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        sessionId: 'sess-new',
      });

      const sessionId = await api.attachToPage('target-1');
      expect(sessionId).toBe('sess-new');
      expect(mockClient.connect).toHaveBeenCalled();
    });

    it('replays the last connect() options on lazy reconnect (bridge URL + subprotocol)', async () => {
      await api.connect({
        url: 'ws://localhost:5710/cdp',
        protocols: 'slicc.bridge.v1.abc-123',
      });
      expect(mockClient.connect).toHaveBeenLastCalledWith({
        url: 'ws://localhost:5710/cdp',
        timeout: undefined,
        protocols: 'slicc.bridge.v1.abc-123',
      });

      (mockClient as unknown as { state: string }).state = 'disconnected';
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ targetInfos: [] });
      await api.listPages();

      expect(mockClient.connect).toHaveBeenLastCalledWith({
        url: 'ws://localhost:5710/cdp',
        timeout: undefined,
        protocols: 'slicc.bridge.v1.abc-123',
      });
    });

    it('captures connect() options even when the initial attempt rejects', async () => {
      let now = 1_000_000;
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
      (mockClient.connect as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('bridge not listening yet')
      );
      await expect(
        api.connect({
          url: 'ws://localhost:5710/cdp',
          protocols: 'slicc.bridge.v1.xyz',
        })
      ).rejects.toThrow('bridge not listening yet');

      (mockClient as unknown as { state: string }).state = 'disconnected';
      await expect(api.listPages()).rejects.toBeInstanceOf(CdpReconnectBackoffError);
      expect(mockClient.connect).toHaveBeenCalledTimes(1);

      now += 60_000;
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ targetInfos: [] });
      await api.listPages();

      expect(mockClient.connect).toHaveBeenLastCalledWith({
        url: 'ws://localhost:5710/cdp',
        timeout: undefined,
        protocols: 'slicc.bridge.v1.xyz',
      });
      nowSpy.mockRestore();
    });

    it('stops redialing after the bridge rejects the token', async () => {
      api.setCdpConnectFailureClassifier(async () => 'terminal');
      const onRejected = vi.fn();
      api.setCdpBridgeRejectedHandler(onRejected);
      (mockClient.connect as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('CDP WebSocket connection failed')
      );

      await expect(
        api.connect({
          url: 'ws://localhost:5710/cdp',
          protocols: 'slicc.bridge.v1.stale',
        })
      ).rejects.toBeInstanceOf(CdpBridgeRejectedError);

      (mockClient as unknown as { state: string }).state = 'disconnected';
      await expect(api.listPages()).rejects.toBeInstanceOf(CdpBridgeRejectedError);
      await expect(api.listPages()).rejects.toBeInstanceOf(CdpBridgeRejectedError);

      expect(mockClient.connect).toHaveBeenCalledTimes(1);
      expect(onRejected).toHaveBeenCalledTimes(1);
    });

    it('primeConnectOptions replays the bridge URL on lazy connect without an eager connect (follower overlay)', async () => {
      api.primeConnectOptions({
        url: 'ws://localhost:7777/cdp',
        protocols: 'slicc.bridge.v1.follower-token',
      });

      expect(mockClient.connect).not.toHaveBeenCalled();

      (mockClient as unknown as { state: string }).state = 'disconnected';
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ targetInfos: [] });
      await api.listPages();

      expect(mockClient.connect).toHaveBeenLastCalledWith({
        url: 'ws://localhost:7777/cdp',
        timeout: undefined,
        protocols: 'slicc.bridge.v1.follower-token',
      });
    });
  });

  describe('reconnectIfNeeded (kernel-worker forwarder re-dial)', () => {
    it('re-dials with the captured options when the client is disconnected', async () => {
      api.primeConnectOptions({ url: 'ws://localhost:7777/cdp', protocols: 'slicc.bridge.v1' });
      (mockClient as unknown as { state: string }).state = 'disconnected';

      await api.reconnectIfNeeded();

      expect(mockClient.connect).toHaveBeenCalledTimes(1);
      expect(mockClient.connect).toHaveBeenLastCalledWith({
        url: 'ws://localhost:7777/cdp',
        timeout: undefined,
        protocols: 'slicc.bridge.v1',
      });
    });

    it('is a no-op while connected', async () => {
      await api.reconnectIfNeeded();
      expect(mockClient.connect).not.toHaveBeenCalled();
    });

    it('never re-dials a superseded client', async () => {
      (mockClient as unknown as { state: string }).state = 'disconnected';
      (mockClient as unknown as { superseded: boolean }).superseded = true;
      const onSuperseded = vi.fn();
      api.setCdpSupersededHandler(onSuperseded);

      await api.reconnectIfNeeded();

      expect(mockClient.connect).not.toHaveBeenCalled();
      expect(onSuperseded).toHaveBeenCalledTimes(1);
    });
  });

  describe('openWindow / getWindowBounds / setWindowBounds', () => {
    it('opens a sized window via Target.createTarget with newWindow:true', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        targetId: 'win-tab-1',
      });

      const targetId = await api.openWindow('https://example.com', {
        width: 1280,
        height: 800,
        left: 40,
        top: 60,
      });

      expect(targetId).toBe('win-tab-1');
      expect(mockClient.send).toHaveBeenCalledWith('Target.createTarget', {
        url: 'https://example.com',
        newWindow: true,
        background: false,
        width: 1280,
        height: 800,
        left: 40,
        top: 60,
      });
    });

    it('rejects combining maximized state with geometry', async () => {
      await expect(
        api.openWindow('about:blank', { state: 'maximized', width: 800, height: 600 })
      ).rejects.toThrow(/cannot be combined/);
      expect(mockClient.send).not.toHaveBeenCalled();
    });

    it('reads window bounds and page dpr', async () => {
      const send = mockClient.send as ReturnType<typeof vi.fn>;
      send
        .mockResolvedValueOnce({
          windowId: 3,
          bounds: { left: 1, top: 2, width: 1000, height: 700, windowState: 'normal' },
        })

        .mockResolvedValueOnce({ sessionId: 'sess-dpr' })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ result: { value: 2 } });

      vi.spyOn(api, 'withTab').mockResolvedValueOnce(2 as never);

      const bounds = await api.getWindowBounds('target-1');
      expect(bounds).toEqual({
        left: 1,
        top: 2,
        width: 1000,
        height: 700,
        state: 'normal',
        dpr: 2,
      });
      expect(send).toHaveBeenCalledWith('Browser.getWindowForTarget', { targetId: 'target-1' });
    });

    it('setWindowBounds applies then reads back achieved bounds', async () => {
      const send = mockClient.send as ReturnType<typeof vi.fn>;
      send
        .mockResolvedValueOnce({ windowId: 9, bounds: { windowState: 'normal' } })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          bounds: { left: 0, top: 0, width: 1080, height: 809, windowState: 'normal' },
        });
      vi.spyOn(api, 'withTab').mockResolvedValueOnce(1 as never);

      const achieved = await api.setWindowBounds('target-1', { width: 1080, height: 1080 });
      expect(achieved).toEqual({
        left: 0,
        top: 0,
        width: 1080,
        height: 809,
        state: 'normal',
        dpr: 1,
      });
      expect(send).toHaveBeenCalledWith('Browser.setWindowBounds', {
        windowId: 9,
        bounds: { width: 1080, height: 1080 },
      });
      expect(send).toHaveBeenCalledWith('Browser.getWindowBounds', { windowId: 9 });
    });

    it('setWindowBounds restores maximized windows before applying geometry', async () => {
      const send = mockClient.send as ReturnType<typeof vi.fn>;
      send
        .mockResolvedValueOnce({
          windowId: 9,
          bounds: { left: 0, top: 0, width: 1920, height: 1080, windowState: 'maximized' },
        })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          bounds: { left: 10, top: 20, width: 800, height: 600, windowState: 'normal' },
        });
      vi.spyOn(api, 'withTab').mockResolvedValueOnce(1 as never);

      const achieved = await api.setWindowBounds('target-1', { width: 800, height: 600 });
      expect(achieved).toMatchObject({ width: 800, height: 600, state: 'normal' });
      expect(send.mock.calls.filter((c) => c[0] === 'Browser.setWindowBounds')).toEqual([
        ['Browser.setWindowBounds', { windowId: 9, bounds: { windowState: 'normal' } }],
        ['Browser.setWindowBounds', { windowId: 9, bounds: { width: 800, height: 600 } }],
      ]);
    });
  });

  describe('listPages', () => {
    it('returns page targets', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        targetInfos: [
          {
            targetId: 't1',
            type: 'page',
            title: 'Google',
            url: 'https://google.com',
            attached: false,
          },
          {
            targetId: 't2',
            type: 'page',
            title: 'GitHub',
            url: 'https://github.com',
            attached: false,
          },
          {
            targetId: 't3',
            type: 'service_worker',
            title: 'SW',
            url: 'chrome://sw',
            attached: false,
          },
        ],
      });

      const pages = await api.listPages();
      expect(pages).toHaveLength(2);
      expect(pages[0]).toEqual({ targetId: 't1', title: 'Google', url: 'https://google.com' });
      expect(pages[1]).toEqual({ targetId: 't2', title: 'GitHub', url: 'https://github.com' });
    });

    it('handles empty target list', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        targetInfos: [],
      });
      const pages = await api.listPages();
      expect(pages).toHaveLength(0);
    });

    it('queries local client even when attached to a remote target', async () => {
      const remoteClient = createMockClient();

      api.setTrayTargetProvider({
        getTargets: () => [],
        createRemoteTransport: () => remoteClient as unknown as CDPClient,
      });

      (remoteClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ sessionId: 'remote-sess' })
        .mockResolvedValueOnce({});
      await api.attachToPage('follower-1:tab-1');

      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        targetInfos: [
          {
            targetId: 'local-tab',
            type: 'page',
            title: 'Local Chrome Tab',
            url: 'https://local.example.com',
            attached: false,
          },
        ],
      });

      const pages = await api.listPages();
      expect(pages).toHaveLength(1);
      expect(pages[0]).toEqual({
        targetId: 'local-tab',
        title: 'Local Chrome Tab',
        url: 'https://local.example.com',
      });

      expect(
        (remoteClient.send as ReturnType<typeof vi.fn>).mock.calls.some(
          (call) => call[0] === 'Target.getTargets'
        )
      ).toBe(false);
    });
  });

  describe('listAllTargets', () => {
    it('deduplicates leader registry entries that mirror local pages', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        targetInfos: [
          {
            targetId: 'tab-1',
            type: 'page',
            title: 'Local Page',
            url: 'https://local.example.com',
            attached: false,
          },
        ],
      });

      api.setTrayTargetProvider({
        getTargets: () => [
          {
            targetId: 'leader:tab-1',
            localTargetId: 'tab-1',
            runtimeId: 'leader',
            title: 'Local Page',
            url: 'https://local.example.com',
            isLocal: false,
          },
        ],
      });

      await expect(api.listAllTargets()).resolves.toEqual([
        { targetId: 'tab-1', title: 'Local Page', url: 'https://local.example.com' },
      ]);
    });

    it('does not deduplicate leader registry entries while attached to a remote target', async () => {
      const remoteClient = createMockClient();

      api.setTrayTargetProvider({
        getTargets: () => [
          {
            targetId: 'leader:1',
            localTargetId: '1',
            runtimeId: 'leader',
            title: 'Leader Page',
            url: 'https://leader.example.com',
            isLocal: false,
          },
        ],
        createRemoteTransport: () => remoteClient as unknown as CDPClient,
      });

      (remoteClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ sessionId: 'remote-sess' })
        .mockResolvedValueOnce({});

      await api.attachToPage('follower-1:1');

      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        targetInfos: [
          {
            targetId: 'local-tab',
            type: 'page',
            title: 'Local Page',
            url: 'https://local.example.com',
            attached: false,
          },
        ],
      });

      await expect(api.listAllTargets()).resolves.toEqual([
        { targetId: 'local-tab', title: 'Local Page', url: 'https://local.example.com' },
        { targetId: 'leader:1', title: 'Leader Page', url: 'https://leader.example.com' },
      ]);
    });

    it('keeps remote tray targets whose local target ids match a local page', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        targetInfos: [
          {
            targetId: 'tab-1',
            type: 'page',
            title: 'Local Page',
            url: 'https://local.example.com',
            attached: false,
          },
        ],
      });

      api.setTrayTargetProvider({
        getTargets: () => [
          {
            targetId: 'follower-1:tab-1',
            localTargetId: 'tab-1',
            runtimeId: 'follower-1',
            title: 'Remote Page',
            url: 'https://remote.example.com',
            isLocal: false,
          },
        ],
      });

      await expect(api.listAllTargets()).resolves.toEqual([
        { targetId: 'tab-1', title: 'Local Page', url: 'https://local.example.com' },
        { targetId: 'follower-1:tab-1', title: 'Remote Page', url: 'https://remote.example.com' },
      ]);
    });
  });

  describe('attachToPage / detach', () => {
    it('attaches to a target and returns session ID', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        sessionId: 'sess-1',
      });

      const sessionId = await api.attachToPage('target-1');
      expect(sessionId).toBe('sess-1');
      expect(mockClient.send).toHaveBeenCalledWith('Target.attachToTarget', {
        targetId: 'target-1',
        flatten: true,
      });
      expect(mockClient.send).toHaveBeenCalledWith('Page.enable', {}, 'sess-1');
    });

    it('attaches to new target without detaching previous (avoids focus steal)', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      await api.attachToPage('target-1');

      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-2' });
      await api.attachToPage('target-2');

      expect(mockClient.send).not.toHaveBeenCalledWith(
        'Target.detachFromTarget',
        expect.anything()
      );
    });

    it('detach is a no-op when not attached', async () => {
      await api.detach();

      expect(mockClient.send).not.toHaveBeenCalledWith(
        'Target.detachFromTarget',
        expect.anything()
      );
    });

    it('auto-dismisses unexpected JavaScript dialogs for the attached session', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        sessionId: 'sess-1',
      });
      await api.attachToPage('target-1');

      mockClient._fireEvent('Page.javascriptDialogOpening', {
        sessionId: 'sess-1',
        type: 'alert',
        message: 'blocked',
      });

      await Promise.resolve();

      expect(mockClient.send).toHaveBeenCalledWith(
        'Page.handleJavaScriptDialog',
        { accept: false },
        'sess-1',
        5000
      );
    });

    it('restores local client when attaching to a local target after a remote one', async () => {
      const remoteClient = createMockClient();
      api.setTrayTargetProvider({
        getTargets: () => [],
        createRemoteTransport: () => remoteClient as unknown as CDPClient,
      });

      (remoteClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ sessionId: 'remote-sess' })
        .mockResolvedValueOnce({});
      await api.attachToPage('follower-1:tab-1');

      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ sessionId: 'local-sess' })
        .mockResolvedValueOnce({});
      const sessionId = await api.attachToPage('local-target-1');

      expect(sessionId).toBe('local-sess');
      expect(mockClient.send).toHaveBeenCalledWith('Target.attachToTarget', {
        targetId: 'local-target-1',
        flatten: true,
      });

      expect(
        (remoteClient.send as ReturnType<typeof vi.fn>).mock.calls.some(
          (call) => call[0] === 'Target.attachToTarget' && call[1]?.targetId === 'local-target-1'
        )
      ).toBe(false);
    });

    it('keeps auto-dismiss handling after switching to a remote transport', async () => {
      const remoteClient = createMockClient();
      api.setTrayTargetProvider({
        getTargets: () => [],
        createRemoteTransport: () => remoteClient as unknown as CDPClient,
      });

      (remoteClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        sessionId: 'remote-sess',
      });

      await api.attachToPage('follower-1:tab-1');

      remoteClient._fireEvent('Page.javascriptDialogOpening', {
        sessionId: 'remote-sess',
        type: 'alert',
        message: 'blocked remotely',
      });

      await Promise.resolve();

      expect(remoteClient.send).toHaveBeenCalledWith(
        'Page.handleJavaScriptDialog',
        { accept: false },
        'remote-sess',
        5000
      );
    });
  });

  describe('navigate', () => {
    let page: TabPage;

    beforeEach(async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      page = await tabOf(api);
    });

    it('navigates and waits for its own session load event', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
        if (method === 'Page.navigate') {
          queueMicrotask(() =>
            mockClient._fireEvent('Page.loadEventFired', { sessionId: 'sess-1' })
          );
          return { frameId: 'f1' };
        }
        return {};
      });

      await page.navigate('https://example.com');

      expect(mockClient.send).toHaveBeenCalledWith('Page.enable', {}, 'sess-1');
      expect(mockClient.send).toHaveBeenCalledWith(
        'Page.navigate',
        { url: 'https://example.com' },
        'sess-1'
      );

      expect(mockClient.once).not.toHaveBeenCalled();
    });

    it('ignores a sibling tab session load event and resolves on its own', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValue({});
      let settled = false;
      const navigation = page.navigate('https://example.com').then(() => {
        settled = true;
      });

      mockClient._fireEvent('Page.loadEventFired', { sessionId: 'sess-other' });
      await new Promise((r) => setTimeout(r, 5));
      expect(settled).toBe(false);

      mockClient._fireEvent('Page.loadEventFired', { sessionId: 'sess-1' });
      await navigation;
      expect(settled).toBe(true);
    });

    it('does not leave an unhandled rejection when Page.navigate fails', async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);
      vi.useFakeTimers();
      try {
        (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
          if (method === 'Page.navigate') throw new Error('net::ERR_ABORTED');
          return {};
        });

        await expect(page.navigate('https://example.com')).rejects.toThrow('net::ERR_ABORTED');

        await vi.advanceTimersByTimeAsync(31_000);
      } finally {
        vi.useRealTimers();

        await new Promise((r) => setTimeout(r, 10));
        process.off('unhandledRejection', onUnhandled);
      }
      expect(unhandled).toEqual([]);
    });

    it('navigates on ITS OWN session, not whichever tab attached last', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-2' });
      await api.attachToPage('target-2');
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
        if (method === 'Page.navigate') {
          queueMicrotask(() =>
            mockClient._fireEvent('Page.loadEventFired', { sessionId: 'sess-1' })
          );
        }
        return {};
      });

      await page.navigate('https://example.com');

      expect(mockClient.send).toHaveBeenCalledWith(
        'Page.navigate',
        { url: 'https://example.com' },
        'sess-1'
      );
    });
  });

  describe('bringToFront', () => {
    it('keeps user-initiated foregrounding permanent', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        sessionId: 'sess-1',
      });
      const page = await tabOf(api);
      (mockClient.send as ReturnType<typeof vi.fn>).mockClear();

      await page.bringToFront();

      expect(mockClient.send).toHaveBeenCalledTimes(1);
      expect(mockClient.send).toHaveBeenCalledWith('Page.bringToFront', {}, 'sess-1');
      expect(mockClient.send).not.toHaveBeenCalledWith('Target.getTargets');
    });
  });

  describe('screenshot', () => {
    let page: TabPage;

    beforeEach(async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      page = await tabOf(api);
    });

    it('captures a viewport screenshot (no clip, Chrome default)', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: 'viewport-shot',
      });

      const data = await page.screenshot();
      expect(data).toBe('viewport-shot');
      expect(mockClient.send).toHaveBeenCalledWith(
        'Page.captureScreenshot',
        { format: 'png', captureBeyondViewport: false },
        'sess-1'
      );

      expect(mockClient.send).not.toHaveBeenCalledWith(
        'Page.bringToFront',
        expect.anything(),
        expect.anything()
      );
    });

    it('maxWidth recapture clips at the current scroll origin (#3232)', async () => {
      let capture = 0;
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
        if (method === 'Page.captureScreenshot') {
          return { data: ++capture === 1 ? pngBase64(2560) : pngBase64(800) };
        }
        if (method === 'Runtime.evaluate') {
          return { result: { value: JSON.stringify({ w: 1280, h: 800, x: 40, y: 1286 }) } };
        }
        return {};
      });

      await page.screenshot({ maxWidth: 800 });
      const captures = (mockClient.send as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([m]) => m === 'Page.captureScreenshot'
      );
      expect(captures).toHaveLength(2);

      expect(captures[1][1]).toEqual({
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 40, y: 1286, width: 1280, height: 800, scale: 800 / 2560 },
      });
    });

    it('maxWidth recapture clips at 0,0 when the tab is unscrolled', async () => {
      let capture = 0;
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
        if (method === 'Page.captureScreenshot') {
          return { data: ++capture === 1 ? pngBase64(2560) : pngBase64(800) };
        }
        if (method === 'Runtime.evaluate') {
          return { result: { value: JSON.stringify({ w: 1280, h: 800, x: 0, y: 0 }) } };
        }
        return {};
      });

      await page.screenshot({ maxWidth: 800 });
      const recapture = (mockClient.send as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([m]) => m === 'Page.captureScreenshot'
      )[1];
      expect((recapture[1] as { clip: { x: number; y: number } }).clip).toEqual({
        x: 0,
        y: 0,
        width: 1280,
        height: 800,
        scale: 800 / 2560,
      });
    });

    it('maxWidth composes with an existing clip scale instead of replacing it', async () => {
      let capture = 0;
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) =>
        method === 'Page.captureScreenshot'
          ? { data: ++capture === 1 ? pngBase64(2560) : pngBase64(1280) }
          : {}
      );

      await page.screenshot({
        clip: { x: 0, y: 0, width: 1280, height: 800, scale: 2 },
        maxWidth: 1280,
      });
      const recapture = (mockClient.send as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([m]) => m === 'Page.captureScreenshot'
      )[1];
      expect((recapture[1] as { clip: { scale: number } }).clip.scale).toBe(1);
    });

    function fakeChrome(tab: {
      cssWidth: number;
      peekWidth: number;

      clipFactor: number;
    }) {
      return async (method: string, params?: Record<string, unknown>) => {
        if (method === 'Runtime.evaluate') {
          return {
            result: {
              value: JSON.stringify({ w: tab.cssWidth, h: tab.cssWidth, x: 0, y: 0 }),
            },
          };
        }
        if (method !== 'Page.captureScreenshot') return {};
        const clip = params?.['clip'] as { width: number; scale?: number } | undefined;
        if (!clip) return { data: pngBase64(tab.peekWidth) };
        return {
          data: pngBase64(Math.round(clip.width * (clip.scale ?? 1) * tab.clipFactor)),
        };
      };
    }

    function captureWidths(): number[] {
      return (mockClient.send as ReturnType<typeof vi.fn>).mock.calls
        .filter(([m]) => m === 'Page.captureScreenshot')
        .map(([, p]) => {
          const clip = (p as { clip?: { width: number; scale?: number } }).clip;
          return clip ? Math.round(clip.width * (clip.scale ?? 1)) : 0;
        });
    }

    it('hits maxWidth on a zoomed tab whose peek ratio overstates the clip factor (#3373)', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(
        fakeChrome({ cssWidth: 1024, peekWidth: 2560, clipFactor: 2 })
      );

      const data = await page.screenshot({ maxWidth: 500 });

      expect(data).toBe(pngBase64(500));
    });

    it('hits maxWidth on a mobile-emulated tab without upscaling past native (#3373)', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(
        fakeChrome({ cssWidth: 980, peekWidth: 1082, clipFactor: 2.625 })
      );

      const data = await page.screenshot({ maxWidth: 500 });

      expect(data).toBe(pngBase64(500));

      for (const width of captureWidths()) expect(width * 2.625).toBeLessThanOrEqual(1082);
    });

    it('corrects a one-pixel rounding overshoot instead of shipping the native frame', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(
        fakeChrome({ cssWidth: 1000, peekWidth: 1000, clipFactor: 1.0012 })
      );

      const data = await page.screenshot({ maxWidth: 500 });

      expect(data).toBe(pngBase64(500));
      expect(captureWidths()).toHaveLength(3);
    });

    it('returns native pixels, never invented ones, when the cap cannot be met', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) =>
        method === 'Page.captureScreenshot'
          ? { data: pngBase64(1600) }
          : { result: { value: JSON.stringify({ w: 800, h: 600, x: 0, y: 0 }) } }
      );

      const data = await page.screenshot({ maxWidth: 500 });

      expect(data).toBe(pngBase64(1600));

      expect(captureWidths()).toHaveLength(4);
    });

    it('maxWidth is a no-op for non-PNG output rather than misreading the header', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) =>
        method === 'Page.captureScreenshot'
          ? { data: btoa('\xff\xd8\xffjpegjunkjpegjunkjpegjunk') }
          : {}
      );
      const data = await page.screenshot({ format: 'jpeg', maxWidth: 100 });
      expect(data).toBe(btoa('\xff\xd8\xffjpegjunkjpegjunkjpegjunk'));
      expect(
        (mockClient.send as ReturnType<typeof vi.fn>).mock.calls.filter(
          ([m]) => m === 'Page.captureScreenshot'
        )
      ).toHaveLength(1);
    });

    it('retries with bringToFront when capture fails on background tab', async () => {
      vi.spyOn(
        api as unknown as { findFocusedLocalPage: (x: string | null) => Promise<string | null> },
        'findFocusedLocalPage'
      ).mockResolvedValue(null);
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('Unable to capture screenshot'))
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ data: 'woken-shot' });

      const data = await page.screenshot();
      expect(data).toBe('woken-shot');
      expect(mockClient.send).toHaveBeenCalledWith('Page.bringToFront', {}, 'sess-1');
    });

    it('the wake-up fallback gives focus back to whichever page held it', async () => {
      vi.spyOn(
        api as unknown as {
          findFocusedLocalPage: (x: string | null, owner?: symbol) => Promise<string | null>;
        },
        'findFocusedLocalPage'
      ).mockResolvedValue('front-1');

      const attachSpy = vi
        .spyOn(
          api as unknown as {
            attachToPageOwned: (id: string, owner?: symbol) => Promise<string>;
          },
          'attachToPageOwned'
        )
        .mockImplementation(async (id: string) => (id === 'front-1' ? 'sess-front' : 'sess-1'));
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('Unable to capture screenshot'))
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ data: 'woken-shot' })
        .mockResolvedValueOnce({});

      const data = await page.screenshot();
      expect(data).toBe('woken-shot');

      expect(attachSpy.mock.calls.map((c) => c[0])).toEqual(['target-1', 'front-1', 'target-1']);
      const fronts = (mockClient.send as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === 'Page.bringToFront'
      );
      expect(fronts.length).toBe(2);
    });

    it('restores focus even when the retry capture throws', async () => {
      vi.spyOn(
        api as unknown as {
          findFocusedLocalPage: (x: string | null, owner?: symbol) => Promise<string | null>;
        },
        'findFocusedLocalPage'
      ).mockResolvedValue('front-1');

      const attachSpy = vi
        .spyOn(
          api as unknown as {
            attachToPageOwned: (id: string, owner?: symbol) => Promise<string>;
          },
          'attachToPageOwned'
        )
        .mockImplementation(async (id: string) => (id === 'front-1' ? 'sess-front' : 'sess-1'));
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('Unable to capture screenshot'))
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('target crashed'))
        .mockResolvedValueOnce({});

      await expect(page.screenshot()).rejects.toThrow('target crashed');
      expect(attachSpy.mock.calls.map((c) => c[0])).toEqual(['target-1', 'front-1', 'target-1']);
    });

    it('foregroundFallback:false fails fast instead of stealing window focus', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Unable to capture screenshot')
      );

      await expect(page.screenshot({ foregroundFallback: false })).rejects.toThrow(
        'Unable to capture screenshot'
      );

      expect(mockClient.send).not.toHaveBeenCalledWith(
        'Page.bringToFront',
        expect.anything(),
        expect.anything()
      );
    });

    it('full page screenshot at DPR 1 uses CSS dimensions with scale 1', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ result: { value: '{"dpr":1,"w":1280,"h":5000}' } })
        .mockResolvedValueOnce({ data: 'fullpage' });

      const data = await page.screenshot({ fullPage: true });
      expect(data).toBe('fullpage');
      expect(mockClient.send).toHaveBeenCalledWith(
        'Page.captureScreenshot',
        {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: 1280, height: 5000, scale: 1 },
        },
        'sess-1'
      );
    });

    it('full page screenshot uses CSS dimensions with scale 1', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ result: { value: '{"w":1440,"h":3130}' } })
        .mockResolvedValueOnce({ data: 'hidpi' });

      const data = await page.screenshot({ fullPage: true });
      expect(data).toBe('hidpi');
      expect(mockClient.send).toHaveBeenCalledWith(
        'Page.captureScreenshot',
        {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: 1440, height: 3130, scale: 1 },
        },
        'sess-1'
      );
    });

    it('passes through provided clip with scale 1', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: 'clipped' });

      const data = await page.screenshot({ clip: { x: 10, y: 20, width: 300, height: 400 } });
      expect(data).toBe('clipped');
      expect(mockClient.send).toHaveBeenCalledWith(
        'Page.captureScreenshot',
        {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 10, y: 20, width: 300, height: 400, scale: 1 },
        },
        'sess-1'
      );
    });
  });

  describe('evaluate', () => {
    let page: TabPage;

    beforeEach(async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      page = await tabOf(api);
    });

    it('evaluates an expression and returns result', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          result: { type: 'number', value: 42 },
        });

      const result = await page.evaluate('1 + 41');
      expect(result).toBe(42);
    });

    it('evaluates string results', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          result: { type: 'string', value: 'hello' },
        });

      const result = await page.evaluate('"hello"');
      expect(result).toBe('hello');
    });

    it('throws on evaluation errors', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          result: { type: 'object' },
          exceptionDetails: {
            text: 'Uncaught ReferenceError',
            exception: { description: 'ReferenceError: foo is not defined' },
          },
        });

      await expect(page.evaluate('foo.bar')).rejects.toThrow('ReferenceError');
    });
  });

  describe('evaluateInFrame', () => {
    let page: TabPage;

    beforeEach(async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      page = await tabOf(api);
    });

    it('uses an isolated world by default for injected automation code', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ executionContextId: 41 })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ result: { type: 'string', value: 'isolated' } });

      await expect(page.evaluateInFrame('frame-1', 'window.helper')).resolves.toBe('isolated');
      expect(mockClient.send).toHaveBeenCalledWith(
        'Page.createIsolatedWorld',
        { frameId: 'frame-1', worldName: '__slicc_iframe' },
        'sess-1'
      );
    });

    it('uses the frame default context when the main world is requested', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(
        async (method: string, params?: Record<string, unknown>) => {
          if (method === 'Runtime.enable') {
            mockClient._fireEvent('Runtime.executionContextCreated', {
              sessionId: 'sess-1',
              context: {
                id: 42,
                auxData: { frameId: 'frame-1', isDefault: true },
              },
            });
            return {};
          }
          if (method === 'Runtime.evaluate') {
            expect(params?.['contextId']).toBe(42);
            return { result: { type: 'string', value: 'page-global' } };
          }
          return {};
        }
      );

      await expect(
        page.evaluateInFrame('frame-1', 'window.appState', { world: 'main' })
      ).resolves.toBe('page-global');
      expect(mockClient.send).not.toHaveBeenCalledWith(
        'Page.createIsolatedWorld',
        expect.anything(),
        expect.anything()
      );
    });

    it('re-resolves remote main contexts after lifecycle invalidation', async () => {
      let remoteTransport: RemoteCDPTransport;
      let runtimeEnabled = false;
      let nextContextId = 42;
      const evaluatedContexts: number[] = [];
      const sender: RemoteCDPSender = {
        sendCDPRequest(requestId, method, params) {
          if (method === 'Target.attachToTarget') {
            remoteTransport.handleResponse(requestId, { sessionId: 'remote-sess' });
          } else if (method === 'Runtime.enable') {
            if (!runtimeEnabled) {
              runtimeEnabled = true;
              remoteTransport.handleEvent('Runtime.executionContextCreated', {
                sessionId: 'remote-sess',
                context: {
                  id: nextContextId++,
                  auxData: { frameId: 'frame-1', isDefault: true },
                },
              });
            }
            remoteTransport.handleResponse(requestId, {});
          } else if (method === 'Runtime.disable') {
            runtimeEnabled = false;
            remoteTransport.handleResponse(requestId, {});
          } else if (method === 'Runtime.evaluate') {
            const contextId = params?.['contextId'] as number;
            evaluatedContexts.push(contextId);
            remoteTransport.handleResponse(requestId, {
              result: { type: 'string', value: `context-${contextId}` },
            });
          } else {
            remoteTransport.handleResponse(requestId, {});
          }
        },
      };
      remoteTransport = new RemoteCDPTransport(sender);
      api.setTrayTargetProvider({
        getTargets: () => [],
        createRemoteTransport: () => remoteTransport,
      });
      const remote = await tabOf(api, 'follower-1:tab-1');

      await expect(
        remote.evaluateInFrame('frame-1', 'window.appState', { world: 'main' })
      ).resolves.toBe('context-42');
      remoteTransport.handleEvent('Runtime.executionContextDestroyed', {
        sessionId: 'remote-sess',
        executionContextId: 42,
      });
      await expect(
        remote.evaluateInFrame('frame-1', 'window.appState', { world: 'main' })
      ).resolves.toBe('context-43');
      remoteTransport.handleEvent('Runtime.executionContextsCleared', {
        sessionId: 'remote-sess',
      });
      await expect(
        remote.evaluateInFrame('frame-1', 'window.appState', { world: 'main' })
      ).resolves.toBe('context-44');
      expect(evaluatedContexts).toEqual([42, 43, 44]);
    });
  });

  describe('click', () => {
    let page: TabPage;

    beforeEach(async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      page = await tabOf(api);
    });

    it('clicks an element by selector', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ root: { nodeId: 1 } })
        .mockResolvedValueOnce({ nodeId: 5 })
        .mockResolvedValueOnce({
          model: { content: [100, 200, 200, 200, 200, 250, 100, 250], width: 100, height: 50 },
        })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      await page.click('button.submit');

      const pressCall = (mockClient.send as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) =>
          c[0] === 'Input.dispatchMouseEvent' &&
          (c[1] as Record<string, unknown>).type === 'mousePressed'
      );
      expect(pressCall).toBeDefined();
      expect((pressCall![1] as Record<string, unknown>).x).toBe(150);
      expect((pressCall![1] as Record<string, unknown>).y).toBe(225);
    });

    it('throws if element not found', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ root: { nodeId: 1 } })
        .mockResolvedValueOnce({ nodeId: 0 });

      await expect(page.click('.missing')).rejects.toThrow('Element not found');
    });
  });

  describe('type', () => {
    let page: TabPage;

    beforeEach(async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      page = await tabOf(api);
    });

    it('types text character by character', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValue({});

      await page.type('hi');

      const keyCalls = (mockClient.send as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === 'Input.dispatchKeyEvent'
      );
      expect(keyCalls).toHaveLength(4);
      expect((keyCalls[0][1] as Record<string, unknown>).type).toBe('keyDown');
      expect((keyCalls[0][1] as Record<string, unknown>).text).toBe('h');
      expect((keyCalls[1][1] as Record<string, unknown>).type).toBe('keyUp');
      expect((keyCalls[2][1] as Record<string, unknown>).text).toBe('i');
    });
  });

  describe('waitForSelector', () => {
    let page: TabPage;

    beforeEach(async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      page = await tabOf(api);
    });

    it('resolves when selector is found', async () => {
      let callCount = 0;
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
        if (method === 'Runtime.enable') return {};
        if (method === 'Runtime.evaluate') {
          callCount++;

          return { result: { type: 'boolean', value: callCount >= 2 } };
        }
        return {};
      });

      await page.waitForSelector('.target', { interval: 10 });
      expect(callCount).toBeGreaterThanOrEqual(2);
    });

    it('times out if selector never appears', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
        if (method === 'Runtime.enable') return {};
        if (method === 'Runtime.evaluate') {
          return { result: { type: 'boolean', value: false } };
        }
        return {};
      });

      await expect(page.waitForSelector('.never', { timeout: 100, interval: 10 })).rejects.toThrow(
        'waitForSelector timed out'
      );
    });
  });

  describe('getAccessibilityTree', () => {
    let page: TabPage;

    beforeEach(async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      page = await tabOf(api);
    });

    it('returns accessibility tree', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          result: {
            type: 'object',
            value: {
              role: 'RootWebArea',
              name: 'Test Page',
              children: [{ role: 'heading', name: 'Hello World' }],
            },
          },
        });

      const tree = await page.getAccessibilityTree();
      expect(tree.role).toBe('RootWebArea');
      expect(tree.name).toBe('Test Page');
      expect(tree.children).toHaveLength(1);
      expect(tree.children![0].role).toBe('heading');
      expect(tree.children![0].name).toBe('Hello World');
    });

    it('returns fallback for empty tree', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          result: { type: 'undefined', value: undefined },
        });

      const tree = await page.getAccessibilityTree();
      expect(tree.role).toBe('RootWebArea');
      expect(tree.name).toBe('');
    });

    it('normalizes non-string accessibility values', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          result: {
            type: 'object',
            value: {
              role: 'RootWebArea',
              name: 'Slack',
              children: [
                {
                  role: 'textbox',
                  name: { label: 'Message' },
                  value: 0,
                  description: ['composer'],
                },
              ],
            },
          },
        });

      const tree = await page.getAccessibilityTree();
      expect(tree.children).toHaveLength(1);
      expect(tree.children![0].name).toBe('{"label":"Message"}');
      expect(tree.children![0].value).toBe('0');
      expect(tree.children![0].description).toBe('["composer"]');
    });
  });

  describe('viewport override persistence', () => {
    function attachCounting() {
      let sessCount = 0;
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) =>
        method === 'Target.attachToTarget' ? { sessionId: `sess-${++sessCount}` } : {}
      );
    }

    function emulationCalls() {
      return (mockClient.send as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([method]) => method === 'Emulation.setDeviceMetricsOverride'
      );
    }

    it('sets and records a viewport override for a tab', async () => {
      attachCounting();
      await api.withTab('t1', async (page) => {
        await page.setViewportOverride(1440, 900);
      });
      expect(emulationCalls()).toEqual([
        [
          'Emulation.setDeviceMetricsOverride',
          { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
          'sess-1',
        ],
      ]);
    });

    it('keeps the override without re-applying it when a sibling switches tabs', async () => {
      attachCounting();
      await api.withTab('t1', async (page) => {
        await page.setViewportOverride(1440, 900);
      });
      await api.withTab('t2', async () => {});
      await api.withTab('t1', async () => {});

      expect(emulationCalls()).toHaveLength(1);
    });

    it('re-applies the override on a genuine re-attach after the session died', async () => {
      attachCounting();
      await api.withTab('t1', async (page) => {
        await page.setViewportOverride(1440, 900);
      });

      mockClient._fireEvent('Target.detachedFromTarget', { sessionId: 'sess-1' });
      await api.withTab('t1', async () => {});

      const calls = emulationCalls();
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual([
        'Emulation.setDeviceMetricsOverride',
        { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
        'sess-2',
      ]);
    });

    it('mobile emulation sends metrics, touch, and UA — and a later resize preserves them', async () => {
      attachCounting();
      const calls = (method: string) =>
        (mockClient.send as ReturnType<typeof vi.fn>).mock.calls.filter(([m]) => m === method);

      await api.withTab('t1', async (page) => {
        await page.setViewportOverride(412, 915, {
          deviceScaleFactor: 2.625,
          mobile: true,
          userAgent: 'MobileUA',
        });
      });
      expect(emulationCalls()[0][1]).toEqual({
        width: 412,
        height: 915,
        deviceScaleFactor: 2.625,
        mobile: true,
      });
      expect(calls('Emulation.setTouchEmulationEnabled')[0][1]).toEqual({
        enabled: true,
        maxTouchPoints: 5,
      });
      expect(calls('Emulation.setUserAgentOverride')[0][1]).toEqual({ userAgent: 'MobileUA' });

      await api.withTab('t1', async (page) => {
        await page.setViewportOverride(500, 800);
      });
      expect(emulationCalls()[1][1]).toEqual({
        width: 500,
        height: 800,
        deviceScaleFactor: 2.625,
        mobile: true,
      });
      expect(calls('Emulation.setUserAgentOverride')).toHaveLength(2);

      await api.withTab('t2', async () => {});
      await api.withTab('t1', async () => {});
      const reapplied = emulationCalls().at(-1)?.[1];
      expect(reapplied).toEqual({
        width: 500,
        height: 800,
        deviceScaleFactor: 2.625,
        mobile: true,
      });
    });

    it('drops the override when the tab is closed', async () => {
      attachCounting();
      await api.withTab('t1', async (page) => {
        await page.setViewportOverride(1440, 900);
      });
      await api.closePage('t1');
      await api.withTab('t2', async () => {});
      await api.withTab('t1', async () => {});
      expect(emulationCalls()).toHaveLength(1);
    });
  });

  describe('withTab mutex', () => {
    it('tracks queue depth and cumulative wait in getTabLockStats', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
        sessionId: 'sess-x',
      }));

      let releaseFirst: () => void;
      const gate = new Promise<void>((r) => {
        releaseFirst = r;
      });

      const p1 = api.withTab('target-1', async () => {
        await gate;
        return 1;
      });
      await new Promise((r) => setTimeout(r, 5));
      const p2 = api.withTab('target-1', async () => 2);
      await new Promise((r) => setTimeout(r, 20));

      expect(api.getTabLockStats().queueDepth).toBe(2);

      releaseFirst!();
      await Promise.all([p1, p2]);

      const stats = api.getTabLockStats();
      expect(stats.queueDepth).toBe(0);
      expect(stats.acquisitions).toBe(2);
      expect(stats.totalWaitMs).toBeGreaterThanOrEqual(10);
    });

    it('runs two concurrent withTab calls on DIFFERENT targetIds in parallel', async () => {
      const order: string[] = [];
      let sessCount = 0;
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) =>
        method === 'Target.attachToTarget' ? { sessionId: `sess-${++sessCount}` } : {}
      );

      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });

      const p1 = api.withTab('target-1', async (page) => {
        order.push('op1-start');
        await gate;
        order.push('op1-end');
        return `result-1-${page.sessionId}`;
      });
      await new Promise((r) => setTimeout(r, 5));

      const r2 = await api.withTab('target-2', async (page) => {
        order.push('op2-start');
        order.push('op2-end');
        return `result-2-${page.sessionId}`;
      });
      expect(order).toEqual(['op1-start', 'op2-start', 'op2-end']);

      release();
      const r1 = await p1;
      expect(r1).toContain('result-1-');
      expect(r2).toContain('result-2-');
      expect(order).toEqual(['op1-start', 'op2-start', 'op2-end', 'op1-end']);
    });

    it('recovers from errors in withTab and releases lock for next operation', async () => {
      const executionOrder: string[] = [];

      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
        if (method === 'Target.attachToTarget') {
          return { sessionId: 'sess-ok' };
        }
        if (method === 'Page.enable') {
          return {};
        }
        return {};
      });

      const p1 = api
        .withTab('target-1', async () => {
          executionOrder.push('op1-start');
          await new Promise((r) => setTimeout(r, 10));
          executionOrder.push('op1-error');
          throw new Error('Intentional error in op1');
        })
        .catch((err) => {
          executionOrder.push('op1-caught');
          return `error-caught: ${err.message}`;
        });

      await new Promise((r) => setTimeout(r, 5));

      const p2 = api
        .withTab('target-1', async () => {
          executionOrder.push('op2-start');
          await new Promise((r) => setTimeout(r, 5));
          executionOrder.push('op2-end');
          return 'op2-success';
        })
        .catch((err) => {
          throw err;
        });

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBe('error-caught: Intentional error in op1');
      expect(r2).toBe('op2-success');

      expect(executionOrder).toEqual([
        'op1-start',
        'op1-error',
        'op1-caught',
        'op2-start',
        'op2-end',
      ]);
    });

    it('hands the callback a handle naming the tab and its session', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ sessionId: 'sess-abc' })
        .mockResolvedValueOnce({});

      const seen = await api.withTab('target-1', async (page) => ({
        targetId: page.targetId,
        sessionId: page.sessionId,
      }));

      expect(seen).toEqual({ targetId: 'target-1', sessionId: 'sess-abc' });
    });

    it('attaches to the requested targetId', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValue({ sessionId: 'sess-123' });

      await api.withTab('target-xyz', async () => undefined);

      expect(mockClient.send).toHaveBeenCalledWith('Target.attachToTarget', {
        targetId: 'target-xyz',
        flatten: true,
      });
    });

    it('allows return value from callback to propagate', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-1' });

      const result = await api.withTab('target-1', async () => {
        return { custom: 'data', nested: { value: 42 } };
      });

      expect(result).toEqual({ custom: 'data', nested: { value: 42 } });
    });

    it('handles three concurrent calls in order', async () => {
      const order: string[] = [];

      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { sessionId: 'sess-ok' };
      });

      const p1 = api
        .withTab('target-1', async () => {
          order.push('1-start');
          await new Promise((r) => setTimeout(r, 10));
          order.push('1-end');
        })
        .catch(() => {});

      await new Promise((r) => setTimeout(r, 5));

      const p2 = api
        .withTab('target-2', async () => {
          order.push('2-start');
          await new Promise((r) => setTimeout(r, 10));
          order.push('2-end');
        })
        .catch(() => {});

      await new Promise((r) => setTimeout(r, 5));

      const p3 = api
        .withTab('target-3', async () => {
          order.push('3-start');
          await new Promise((r) => setTimeout(r, 10));
          order.push('3-end');
        })
        .catch(() => {});

      await Promise.all([p1, p2, p3]);

      expect(order).toEqual(['1-start', '1-end', '2-start', '2-end', '3-start', '3-end']);
    });
  });

  describe('per-tab session registry (issue #2417)', () => {
    function attachCounting() {
      let sessCount = 0;
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) =>
        method === 'Target.attachToTarget' ? { sessionId: `sess-${++sessCount}` } : {}
      );
    }

    function callsTo(method: string) {
      return (mockClient.send as ReturnType<typeof vi.fn>).mock.calls.filter(([m]) => m === method);
    }

    it('attaches a tab once and reuses its session across switches', async () => {
      attachCounting();

      await api.withTab('t1', async () => {});
      await api.withTab('t2', async () => {});
      await api.withTab('t1', async () => {});
      await api.withTab('t2', async () => {});

      const attaches = callsTo('Target.attachToTarget');
      expect(attaches).toHaveLength(2);
      expect(attaches.map(([, params]) => (params as { targetId: string }).targetId)).toEqual([
        't1',
        't2',
      ]);
      expect(callsTo('Target.detachFromTarget')).toHaveLength(0);
    });

    it('reports the most recently used tab through getSessionId/getAttachedTargetId', async () => {
      attachCounting();
      await api.withTab('t1', async () => {});
      await api.withTab('t2', async () => {});

      expect(api.getAttachedTargetId()).toBe('t2');
      expect(api.getSessionId()).toBe('sess-2');

      await api.withTab('t1', async () => {});
      expect(api.getAttachedTargetId()).toBe('t1');
      expect(api.getSessionId()).toBe('sess-1');
    });

    it('detaches the session when the tab is closed, and re-attaches later', async () => {
      attachCounting();
      await api.withTab('t1', async () => {});

      await api.closePage('t1');

      expect(mockClient.send).toHaveBeenCalledWith('Target.detachFromTarget', {
        sessionId: 'sess-1',
      });
      expect(mockClient.send).toHaveBeenCalledWith('Target.closeTarget', { targetId: 't1' });
      expect(api.getAttachedTargetId()).toBeNull();

      await api.withTab('t1', async () => {});
      expect(callsTo('Target.attachToTarget')).toHaveLength(2);
    });

    it('evicts the least-recently-used session over the cap and detaches it', async () => {
      attachCounting();

      for (let i = 0; i < 33; i++) await api.withTab(`t${i}`, async () => {});

      expect(callsTo('Target.detachFromTarget')).toEqual([
        ['Target.detachFromTarget', { sessionId: 'sess-1' }],
      ]);

      await api.withTab('t0', async () => {});
      expect(callsTo('Target.attachToTarget')).toHaveLength(34);
    });

    it('never evicts the session a navigation is still waiting on', async () => {
      attachCounting();

      const navigating = api.withTab('t-nav', (page) => page.navigate('https://slow.example'));
      await new Promise((r) => setTimeout(r, 5));
      for (let i = 0; i < 32; i++) await api.withTab(`t${i}`, async () => {});

      const detached = callsTo('Target.detachFromTarget').map(
        ([, params]) => (params as { sessionId: string }).sessionId
      );
      expect(detached).not.toContain('sess-1');
      expect(detached).toEqual(['sess-2']);

      mockClient._fireEvent('Page.loadEventFired', { sessionId: 'sess-1' });
      await navigating;

      expect(api.getTabLockStats('t-nav').acquisitions).toBe(1);
      expect(callsTo('Target.attachToTarget')).toHaveLength(33);
    });

    it('defers eviction while every candidate is busy', async () => {
      attachCounting();

      const navigating: Array<Promise<void>> = [];

      for (let i = 0; i < 32; i++) {
        navigating.push(api.withTab(`t${i}`, (page) => page.navigate('https://slow.example')));
        await new Promise((r) => setTimeout(r, 0));
      }

      let detachesWhileBusy = -1;
      await api.withTab('t-extra', async () => {
        detachesWhileBusy = callsTo('Target.detachFromTarget').length;
      });
      expect(detachesWhileBusy).toBe(0);

      expect(callsTo('Target.detachFromTarget')).toEqual([
        ['Target.detachFromTarget', { sessionId: 'sess-33' }],
      ]);

      for (let i = 1; i <= 32; i++) {
        mockClient._fireEvent('Page.loadEventFired', { sessionId: `sess-${i}` });
      }
      await Promise.all(navigating);
    });

    it('keeps the most-recently-used tabs when the cap is reached', async () => {
      attachCounting();
      for (let i = 0; i < 32; i++) await api.withTab(`t${i}`, async () => {});

      await api.withTab('t0', async () => {});
      await api.withTab('overflow', async () => {});

      expect(callsTo('Target.detachFromTarget')).toEqual([
        ['Target.detachFromTarget', { sessionId: 'sess-2' }],
      ]);
    });

    it('drops a session when Chrome reports Target.detachedFromTarget', async () => {
      attachCounting();
      await api.withTab('t1', async () => {});

      mockClient._fireEvent('Target.detachedFromTarget', { sessionId: 'sess-1' });
      expect(api.getSessionId()).toBeNull();

      await api.withTab('t1', async () => {});

      expect(callsTo('Target.attachToTarget')).toHaveLength(2);

      expect(callsTo('Target.detachFromTarget')).toHaveLength(0);
    });

    it('drops a session when the tab is destroyed', async () => {
      attachCounting();
      await api.withTab('t1', async () => {});

      mockClient._fireEvent('Target.targetDestroyed', { targetId: 't1' });

      await api.withTab('t1', async () => {});
      expect(callsTo('Target.attachToTarget')).toHaveLength(2);
    });

    it('clears the whole registry when the transport reconnects', async () => {
      attachCounting();
      await api.withTab('t1', async () => {});
      await api.withTab('t2', async () => {});

      (mockClient as unknown as { state: string }).state = 'disconnected';
      await api.withTab('t1', async () => {});
      (mockClient as unknown as { state: string }).state = 'connected';
      await api.withTab('t2', async () => {});

      expect(mockClient.connect).toHaveBeenCalled();
      expect(callsTo('Target.attachToTarget')).toHaveLength(4);
    });

    it('re-attaches and retries the callback exactly once on a stale session', async () => {
      attachCounting();
      let calls = 0;
      const result = await api.withTab('t1', async (page) => {
        calls += 1;
        if (calls === 1) throw new Error('Session with given id not found');
        return page.sessionId;
      });

      expect(calls).toBe(2);
      expect(result).toBe('sess-2');
      expect(callsTo('Target.attachToTarget')).toHaveLength(2);
    });

    it('gives up after one heal instead of retrying forever', async () => {
      attachCounting();
      let calls = 0;
      await expect(
        api.withTab('t1', async () => {
          calls += 1;
          throw new Error('No tab attached for sessionId 42');
        })
      ).rejects.toThrow('No tab attached for sessionId 42');

      expect(calls).toBe(2);
    });

    it('heals when the stale error was the callback\u2019s first round trip', async () => {
      let sessCount = 0;
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(
        async (method: string, _params: unknown, sessionId?: string) => {
          if (method === 'Target.attachToTarget') return { sessionId: `sess-${++sessCount}` };

          if (sessionId === 'sess-1' && method === 'Runtime.enable') {
            throw new Error('Session with given id not found');
          }
          if (method === 'Runtime.evaluate') return { result: { type: 'string', value: 'ok' } };
          return {};
        }
      );

      let runs = 0;
      const out = await api.withTab('t1', async (page) => {
        runs += 1;
        return page.evaluate('document.title');
      });

      expect(out).toBe('ok');
      expect(runs).toBe(2);
      expect(callsTo('Target.attachToTarget')).toHaveLength(2);
    });

    it('does not replay a callback that had already changed the page', async () => {
      let sessCount = 0;
      let keys = 0;
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
        if (method === 'Target.attachToTarget') return { sessionId: `sess-${++sessCount}` };
        if (method === 'Input.dispatchKeyEvent') {
          keys += 1;

          if (keys > 4) throw new Error('Session with given id not found');
          return {};
        }
        return {};
      });

      await expect(api.withTab('t1', (page) => page.type('abcdef'))).rejects.toThrow(
        /reset mid-command.*outcome is unknown/s
      );

      expect(keys).toBe(5);
      expect(callsTo('Target.attachToTarget')).toHaveLength(1);
    });

    it('counts the callback\u2019s DIRECT transport sends as applied (press: keyDown then keyUp)', async () => {
      let sessCount = 0;
      let keys = 0;
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
        if (method === 'Target.attachToTarget') return { sessionId: `sess-${++sessCount}` };
        if (method === 'Input.dispatchKeyEvent') {
          keys += 1;

          if (keys > 1) throw new Error('Session with given id not found');
          return {};
        }
        return {};
      });

      await expect(
        api.withTab('t1', async ({ sessionId, transport }) => {
          await transport.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a' }, sessionId);
          await transport.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a' }, sessionId);
        })
      ).rejects.toThrow(/reset mid-command.*outcome is unknown/s);

      expect(keys).toBe(2);
      expect(callsTo('Target.attachToTarget')).toHaveLength(1);
    });

    it('hands out one stable transport facade per real transport', () => {
      const a = api.getTransport();
      expect(api.getTransport()).toBe(a);

      const seen: unknown[] = [];
      api.setSessionChangeCallback((_sid, transport) => seen.push(transport));
      return api
        .withTab('t1', async () => undefined)
        .then(() => {
          expect(seen).toHaveLength(1);
          expect(seen[0]).toBe(a);
        });
    });

    it('does not replay a RETRY that had already changed the page', async () => {
      let sessCount = 0;
      let inserts = 0;
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(
        async (method: string, _params: unknown, sessionId?: string) => {
          if (method === 'Target.attachToTarget') return { sessionId: `sess-${++sessCount}` };

          if (sessionId === 'sess-1') throw new Error('Session with given id not found');
          if (method === 'Input.insertText') {
            inserts += 1;
            if (inserts > 1) throw new Error('Session with given id not found');
            return {};
          }
          return {};
        }
      );

      await expect(
        api.withTab('t1', async (page) => {
          await page.insertText('a');
          await page.insertText('b');
        })
      ).rejects.toThrow(/outcome is unknown/);

      expect(callsTo('Target.attachToTarget')).toHaveLength(2);
      expect(inserts).toBe(2);
    });

    it('re-arms the tab after an uncertain-outcome failure', async () => {
      let sessCount = 0;
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
        if (method === 'Target.attachToTarget') return { sessionId: `sess-${++sessCount}` };
        if (method === 'Input.insertText') throw new Error('Target closed');
        if (method === 'Runtime.evaluate') return { result: { type: 'number', value: 1 } };
        return {};
      });

      await expect(
        api.withTab('t1', async (page) => {
          await page.evaluate('1');
          await page.insertText('hello');
        })
      ).rejects.toThrow(/outcome is unknown/);

      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) =>
        method === 'Target.attachToTarget' ? { sessionId: `sess-${++sessCount}` } : {}
      );
      await api.withTab('t1', async () => {});

      expect(callsTo('Target.attachToTarget')).toHaveLength(2);
      expect(api.getSessionId()).toBe('sess-2');
    });

    it('does not retry an ordinary command failure', async () => {
      attachCounting();
      let calls = 0;
      await expect(
        api.withTab('t1', async () => {
          calls += 1;
          throw new Error('Element not found: #missing');
        })
      ).rejects.toThrow('Element not found');

      expect(calls).toBe(1);
      expect(callsTo('Target.attachToTarget')).toHaveLength(1);
    });

    it('notifies session-change and per-target subscribers with the targetId', async () => {
      attachCounting();
      const onChange = vi.fn();
      const onReplaced = vi.fn();
      api.setSessionChangeCallback(onChange);
      const unsubscribe = api.onSessionReplaced('t1', onReplaced);

      await api.withTab('t1', async () => {});

      expect(onChange).toHaveBeenCalledWith('sess-1', api.getTransport(), 't1');
      expect(onReplaced).toHaveBeenCalledTimes(1);

      await api.withTab('t1', async () => {});
      expect(onReplaced).toHaveBeenCalledTimes(1);

      mockClient._fireEvent('Target.detachedFromTarget', { sessionId: 'sess-1' });
      await api.withTab('t1', async () => {});
      expect(onReplaced).toHaveBeenLastCalledWith('sess-2', api.getTransport(), 't1');

      unsubscribe();
      mockClient._fireEvent('Target.detachedFromTarget', { sessionId: 'sess-2' });
      await api.withTab('t1', async () => {});
      expect(onReplaced).toHaveBeenCalledTimes(2);
    });

    async function twoTransports() {
      const remoteClient = createMockClient();
      const removeRemoteTransport = vi.fn();
      api.setTrayTargetProvider({
        getTargets: () => [],
        createRemoteTransport: () => remoteClient as unknown as CDPClient,
        removeRemoteTransport,
      });
      attachCounting();
      (remoteClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) =>
        method === 'Target.attachToTarget' ? { sessionId: 'remote-sess' } : {}
      );
      await api.withTab('local-1', async () => {});
      await api.withTab('follower-1:tab-1', async () => {});
      return { remoteClient, removeRemoteTransport };
    }

    function remoteAttaches(remoteClient: ReturnType<typeof createMockClient>) {
      return (remoteClient.send as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([m]) => m === 'Target.attachToTarget'
      );
    }

    it('detaches a remote session BEFORE disposing its follower transport', async () => {
      const { remoteClient, removeRemoteTransport } = await twoTransports();
      const order: string[] = [];
      (remoteClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
        if (method === 'Target.detachFromTarget') order.push('detach');
        return method === 'Target.attachToTarget' ? { sessionId: 'remote-sess-2' } : {};
      });
      removeRemoteTransport.mockImplementation(() => order.push('dispose'));

      await api.closePage('follower-1:tab-1');

      expect(order[0]).toBe('detach');
      expect(order.slice(1).every((step) => step === 'dispose')).toBe(true);
    });

    it('keeps local sessions when a follower transport drops', async () => {
      const { remoteClient, removeRemoteTransport } = await twoTransports();

      (remoteClient as unknown as { state: string }).state = 'disconnected';
      await api.withTab('local-1', async () => {});

      expect(callsTo('Target.attachToTarget')).toHaveLength(1);
      expect(api.getSessionId()).toBe('sess-1');
      expect(removeRemoteTransport).toHaveBeenCalledWith('follower-1', 'tab-1');

      expect(remoteClient.off).toHaveBeenCalledWith(
        'Target.detachedFromTarget',
        expect.any(Function)
      );
      expect(remoteClient.off).toHaveBeenCalledWith('Target.targetDestroyed', expect.any(Function));
    });

    it('keeps remote sessions when the local client drops', async () => {
      const { remoteClient } = await twoTransports();

      await api.withTab('local-1', async () => {});

      (mockClient as unknown as { state: string }).state = 'disconnected';
      await api.withTab('local-1', async () => {});
      (mockClient as unknown as { state: string }).state = 'connected';

      expect(callsTo('Target.attachToTarget')).toHaveLength(2);
      await api.withTab('follower-1:tab-1', async () => {});
      expect(remoteAttaches(remoteClient)).toHaveLength(1);
      expect(api.getSessionId()).toBe('remote-sess');
    });

    it('stops listening to a remote transport once its last session goes', async () => {
      const { remoteClient } = await twoTransports();

      await api.closePage('follower-1:tab-1');

      expect(remoteClient.off).toHaveBeenCalledWith(
        'Target.detachedFromTarget',
        expect.any(Function)
      );

      remoteClient._fireEvent('Target.targetDestroyed', { targetId: 'local-1' });
      await api.withTab('local-1', async () => {});
      expect(callsTo('Target.attachToTarget')).toHaveLength(1);
    });

    it('keeps a remote tray session alive while another tab is driven locally', async () => {
      const remoteClient = createMockClient();
      const removeRemoteTransport = vi.fn();
      api.setTrayTargetProvider({
        getTargets: () => [],
        createRemoteTransport: () => remoteClient as unknown as CDPClient,
        removeRemoteTransport,
      });
      attachCounting();
      (remoteClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) =>
        method === 'Target.attachToTarget' ? { sessionId: 'remote-sess' } : {}
      );

      await api.withTab('follower-1:tab-1', async () => {});
      await api.withTab('local-1', async () => {});
      await api.withTab('follower-1:tab-1', async () => {});

      expect(
        (remoteClient.send as ReturnType<typeof vi.fn>).mock.calls.filter(
          ([m]) => m === 'Target.attachToTarget'
        )
      ).toHaveLength(1);
      expect(callsTo('Target.attachToTarget')).toHaveLength(1);
      expect(removeRemoteTransport).not.toHaveBeenCalled();
      expect(api.getSessionId()).toBe('remote-sess');
    });
  });

  describe('per-tab locking (issue #2417)', () => {
    function attachCounting() {
      let sessCount = 0;
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) =>
        method === 'Target.attachToTarget' ? { sessionId: `sess-${++sessCount}` } : {}
      );
    }

    it('serializes two calls on the SAME tab', async () => {
      attachCounting();
      const order: string[] = [];

      const p1 = api.withTab('t1', async () => {
        order.push('a-start');
        await new Promise((r) => setTimeout(r, 20));
        order.push('a-end');
      });
      await new Promise((r) => setTimeout(r, 2));
      const p2 = api.withTab('t1', async () => {
        order.push('b-start');
        order.push('b-end');
      });
      await Promise.all([p1, p2]);

      expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
    });

    it('lets another tab run while a navigation waits for its load event', async () => {
      attachCounting();
      const order: string[] = [];

      const navigating = api.withTab('t1', async (page) => {
        order.push('nav-start');
        await page.navigate('https://slow.example');
        order.push('nav-end');
      });
      await new Promise((r) => setTimeout(r, 5));

      await api.withTab('t2', async () => {
        order.push('sibling');
      });
      expect(order).toEqual(['nav-start', 'sibling']);

      mockClient._fireEvent('Page.loadEventFired', { sessionId: 'sess-1' });
      await navigating;
      expect(order).toEqual(['nav-start', 'sibling', 'nav-end']);
    });

    it('lets another tab run while Page.navigate itself hangs', async () => {
      let sessCount = 0;
      const order: string[] = [];
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
        if (method === 'Target.attachToTarget') return { sessionId: `sess-${++sessCount}` };
        if (method === 'Page.navigate') return new Promise(() => undefined);
        return {};
      });

      const abandoned = api.withTab('t1', (page) => page.navigate('https://hangs.example'));
      void abandoned.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 5));

      await api.withTab('t2', async () => {
        order.push('sibling-ran');
      });
      expect(order).toEqual(['sibling-ran']);
    });

    it('keeps a parked navigation bound to its own session when a sibling runs', async () => {
      attachCounting();
      let navigated: string | undefined;
      const navigating = api.withTab('t1', async (page) => {
        await page.navigate('https://slow.example');
        navigated = page.sessionId;
      });
      await new Promise((r) => setTimeout(r, 5));
      await api.withTab('t2', async () => {});

      expect(api.getAttachedTargetId()).toBe('t2');

      mockClient._fireEvent('Page.loadEventFired', { sessionId: 'sess-1' });
      await navigating;

      expect(navigated).toBe('sess-1');
      expect(
        (mockClient.send as ReturnType<typeof vi.fn>).mock.calls.filter(
          ([m, , sid]) => m === 'Page.navigate' && sid === 'sess-1'
        )
      ).toHaveLength(1);
    });

    it('holds the bridge across a foregrounding, so another tab cannot attach meanwhile', async () => {
      const order: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let sessCount = 0;
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
        if (method === 'Target.attachToTarget') return { sessionId: `sess-${++sessCount}` };
        if (method === 'Page.bringToFront') {
          order.push('front-start');
          await gate;
          order.push('front-end');
        }
        return {};
      });

      const t1 = await tabOf(api, 't1');
      const fronting = t1.bringToFront();
      await new Promise((r) => setTimeout(r, 5));

      const tabWork = api.withTab('t2', async () => {
        order.push('tab-work');
      });
      await new Promise((r) => setTimeout(r, 5));
      expect(order).toEqual(['front-start']);

      release();
      await Promise.all([fronting, tabWork]);
      expect(order).toEqual(['front-start', 'front-end', 'tab-work']);
    });

    it('takes the bridge-wide lock from inside a tab hold without deadlocking', async () => {
      attachCounting();
      const done = await Promise.race([
        api
          .withTab('t1', async (page) => {
            await page.bringToFront();
            await page.screenshot({ foregroundFallback: false });
            return 'ok';
          })
          .catch((err: unknown) => `error: ${String(err)}`),
        new Promise((r) => setTimeout(() => r('deadlocked'), 300)),
      ]);
      expect(done).toBe('ok');
    });

    it('lets an outside attachToPage run while a body is mid-command', async () => {
      attachCounting();
      const order: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });

      const body = api.withTab('t1', async () => {
        order.push('body-start');
        await gate;
        order.push('body-end');
      });
      await new Promise((r) => setTimeout(r, 5));

      const peek = api.attachToPage('t2').then(() => order.push('peek-attached'));
      await new Promise((r) => setTimeout(r, 5));
      expect(order).toEqual(['body-start', 'peek-attached']);

      release();
      await Promise.all([body, peek]);
      expect(order).toEqual(['body-start', 'peek-attached', 'body-end']);
    });

    it('keeps a body on its own session when a sibling moved the cursor', async () => {
      attachCounting();
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let handleTarget: string | null = null;
      let handleSession: string | null = null;
      let cursorTarget: string | null = null;

      const body = api.withTab('t1', async (page) => {
        await gate;

        handleTarget = page.targetId;
        handleSession = page.sessionId;
        cursorTarget = api.getAttachedTargetId();
        await page.evaluate('1');
      });
      await new Promise((r) => setTimeout(r, 5));
      const stray = api.attachToPage('t2');
      await new Promise((r) => setTimeout(r, 5));

      release();
      await Promise.all([body, stray]);
      expect(handleTarget).toBe('t1');
      expect(handleSession).toBe('sess-1');
      expect(cursorTarget).toBe('t2');

      expect(mockClient.send).toHaveBeenCalledWith('Runtime.evaluate', expect.anything(), 'sess-1');
    });

    it('lets the peek path front a tab while another tab is mid-command', async () => {
      attachCounting();
      const order: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });

      const body = api.withTab('t1', async () => {
        await gate;
        order.push('body-end');
      });
      await new Promise((r) => setTimeout(r, 5));
      const front = api.bringTabToFront('t2').then(() => order.push('fronted'));
      await new Promise((r) => setTimeout(r, 5));

      expect(order).toEqual(['fronted']);

      release();
      await Promise.all([body, front]);
      expect(order).toEqual(['fronted', 'body-end']);
      expect(api.getAttachedTargetId()).toBe('t2');
    });

    it('selectTab moves the cursor under the locks and nothing else', async () => {
      attachCounting();
      await api.selectTab('t1');
      expect(api.getAttachedTargetId()).toBe('t1');
      expect(
        (mockClient.send as ReturnType<typeof vi.fn>).mock.calls.some(
          ([m]) => m === 'Page.bringToFront'
        )
      ).toBe(false);
    });

    it('reports per-tab contention, and none bridge-wide, for a busy sibling', async () => {
      attachCounting();
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });

      const p1 = api.withTab('t1', async () => {
        await gate;
      });
      await new Promise((r) => setTimeout(r, 5));
      const p2 = api.withTab('t1', async () => {});

      const p3 = api.withTab('t2', async () => {});
      await new Promise((r) => setTimeout(r, 20));
      expect(api.getTabLockStats().queueDepth).toBe(2);

      release();
      await Promise.all([p1, p2, p3]);

      const t1 = api.getTabLockStats('t1');
      const t2 = api.getTabLockStats('t2');
      expect(t1.acquisitions).toBe(2);
      expect(t2.acquisitions).toBe(1);

      expect(t1.tabWaitMs).toBeGreaterThanOrEqual(10);
      expect(t2.tabWaitMs).toBe(0);
      expect(t2.bridgeWaitMs).toBe(0);

      const bridge = api.getTabLockStats();
      expect(bridge.acquisitions).toBe(3);
      expect(bridge.totalWaitMs).toBe(t1.totalWaitMs + t2.totalWaitMs);
      expect(bridge.queueDepth).toBe(0);
    });

    it('records no wait at all when neither lock was contended', async () => {
      attachCounting();

      await api.withTab('t1', async () => {});
      await api.withTab('t2', async () => {});
      await api.withTab('t1', async () => {});

      for (const targetId of ['t1', 't2']) {
        const stats = api.getTabLockStats(targetId);
        expect(stats.tabWaitMs).toBe(0);
        expect(stats.bridgeWaitMs).toBe(0);
        expect(stats.totalWaitMs).toBe(0);
      }
      expect(api.getTabLockStats().acquisitions).toBe(3);
    });

    it('reports zeroed stats for a tab that was never driven', () => {
      expect(api.getTabLockStats('never-touched')).toEqual({
        queueDepth: 0,
        totalWaitMs: 0,
        tabWaitMs: 0,
        bridgeWaitMs: 0,
        acquisitions: 0,
      });
    });
  });

  describe('cooperative cancellation (withTab signal)', () => {
    function attachCounting() {
      let sessCount = 0;
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) =>
        method === 'Target.attachToTarget' ? { sessionId: `sess-${++sessCount}` } : {}
      );
    }

    const settle = () => new Promise((r) => setTimeout(r, 5));

    function deferred(): { promise: Promise<void>; resolve: () => void } {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }

    async function until(ready: () => boolean, what: string): Promise<void> {
      for (let i = 0; i < 500; i++) {
        if (ready()) return;
        await new Promise((r) => setTimeout(r, 1));
      }
      throw new Error(`timed out waiting for ${what}`);
    }

    it('rejects a caller still queued for the tab lock, without running its body', async () => {
      attachCounting();
      const controller = new AbortController();
      const release = deferred();
      let holding = false;
      let holderDone = false;
      let queuedBodyRan = false;

      const holder = api.withTab('t1', async () => {
        holding = true;
        await release.promise;
        holderDone = true;
      });
      await until(() => holding, 'the holder to take the tab');

      const queued = api.withTab(
        't1',
        async () => {
          queuedBodyRan = true;
        },
        { signal: controller.signal }
      );
      const rejected = queued.catch((e: unknown) => e);
      await settle();

      controller.abort();
      const err = (await rejected) as Error;

      expect(holderDone).toBe(false);
      expect(queuedBodyRan).toBe(false);
      expect(err.name).toBe('CommandAbortedError');
      expect(err.message).toContain('queued for the lock on tab t1');

      release.resolve();
      await holder;
      expect(holderDone).toBe(true);
    });

    it('keeps FIFO order for the caller behind an aborted one', async () => {
      attachCounting();
      const controller = new AbortController();
      const release = deferred();
      const order: string[] = [];
      let holding = false;

      const first = api.withTab('t1', async () => {
        holding = true;
        await release.promise;
        order.push('first');
      });
      await until(() => holding, 'the first caller to take the tab');
      const aborted = api
        .withTab('t1', async () => order.push('aborted-body'), { signal: controller.signal })
        .catch(() => order.push('aborted'));
      await settle();
      const third = api.withTab('t1', async () => order.push('third'));
      await settle();

      controller.abort();
      await until(() => order.includes('aborted'), 'the abandoned caller to reject');

      expect(order).toEqual(['aborted']);

      release.resolve();
      await Promise.all([first, aborted, third]);
      expect(order).toEqual(['aborted', 'first', 'third']);
    });

    it('rejects an already-aborted caller before it takes any lock', async () => {
      attachCounting();
      const controller = new AbortController();
      controller.abort();
      let ran = false;

      await expect(
        api.withTab(
          't1',
          async () => {
            ran = true;
          },
          { signal: controller.signal }
        )
      ).rejects.toThrow(/aborted while starting a command on tab t1/);
      expect(ran).toBe(false);
      expect(mockClient.send).not.toHaveBeenCalled();

      await api.withTab('t1', async () => undefined);
    });

    it('stops during the attach handshake, before the body runs', async () => {
      const seen: string[] = [];
      const controller = new AbortController();
      let bodyRan = false;
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
        seen.push(method);
        if (method === 'Target.attachToTarget') {
          controller.abort();
          return { sessionId: 'sess-1' };
        }
        return {};
      });

      await expect(
        api.withTab(
          't1',
          async () => {
            bodyRan = true;
          },
          { signal: controller.signal }
        )
      ).rejects.toThrow(/about to enable Page on tab t1/);

      expect(seen).toEqual(['Target.attachToTarget']);
      expect(bodyRan).toBe(false);

      await api.withTab('t2', async () => undefined);
    });

    it("rejects navigate's load wait as soon as the signal fires", async () => {
      attachCounting();
      const controller = new AbortController();

      const navigating = api
        .withTab('t1', async (tab) => tab.navigate('https://never-loads.example'), {
          signal: controller.signal,
        })
        .catch((e: unknown) => e);

      await until(
        () =>
          (mockClient.on as ReturnType<typeof vi.fn>).mock.calls.some(
            (c: unknown[]) => c[0] === 'Page.loadEventFired'
          ),
        'the load wait to be armed'
      );

      controller.abort();
      const err = (await navigating) as Error;
      expect(err.name).toBe('CommandAbortedError');
      expect(err.message).toContain('waiting for https://never-loads.example to fire its load');

      const t0 = Date.now();
      await api.withTab('t1', async () => undefined);
      expect(Date.now() - t0).toBeLessThan(1000);
    });

    it('stops a multi-step page operation between CDP round trips', async () => {
      const seen: string[] = [];
      const controller = new AbortController();
      let sessCount = 0;
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
        seen.push(method);
        if (method === 'Target.attachToTarget') return { sessionId: `sess-${++sessCount}` };

        if (method === 'Runtime.enable') controller.abort();
        return { result: { type: 'string', value: 'title' } };
      });

      await expect(
        api.withTab('t1', async (tab) => tab.evaluate('document.title'), {
          signal: controller.signal,
        })
      ).rejects.toThrow(/about to send Runtime.evaluate/);

      expect(seen).toContain('Runtime.enable');
      expect(seen).not.toContain('Runtime.evaluate');
    });

    it('stops a raw tab.send between round trips, like a handler does', async () => {
      const seen: string[] = [];
      const controller = new AbortController();
      let sessCount = 0;
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
        seen.push(method);
        if (method === 'Target.attachToTarget') return { sessionId: `sess-${++sessCount}` };

        if (method === 'DOM.enable') controller.abort();
        return {};
      });

      await expect(
        api.withTab(
          't1',
          async (tab) => {
            await tab.send('DOM.enable');
            await tab.send('DOM.getDocument', { depth: 0 });
          },
          { signal: controller.signal }
        )
      ).rejects.toThrow(/about to send DOM.getDocument/);

      expect(seen).toContain('DOM.enable');
      expect(seen).not.toContain('DOM.getDocument');
    });

    it('stops a waitForSelector poll loop and frees the tab', async () => {
      const controller = new AbortController();
      let sessCount = 0;
      let probes = 0;
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
        if (method === 'Target.attachToTarget') return { sessionId: `sess-${++sessCount}` };
        if (method === 'Runtime.evaluate') {
          probes += 1;
          return { result: { type: 'boolean', value: false } };
        }
        return {};
      });

      const waiting = api
        .withTab('t1', async (tab) => tab.waitForSelector('#never', { interval: 10 }), {
          signal: controller.signal,
        })
        .catch((e: unknown) => e);
      await settle();
      const probesAtAbort = probes;
      controller.abort();

      const err = (await waiting) as Error;
      expect(err.name).toBe('CommandAbortedError');
      expect(err.message).toContain('polling for selector #never');

      await settle();
      expect(probes).toBeLessThanOrEqual(probesAtAbort + 1);
    });

    it('never cancels a handle minted for a different command', async () => {
      attachCounting();
      const controller = new AbortController();

      const unsignalled = await api.withTab('t2', async (tab) => tab);
      const abandoned = api
        .withTab(
          't1',
          async (tab) => {
            controller.abort();
            await expect(unsignalled.send('Runtime.enable')).resolves.toEqual({});
            await tab.send('Runtime.enable');
          },
          { signal: controller.signal }
        )
        .catch((e: unknown) => (e as Error).name);

      expect(await abandoned).toBe('CommandAbortedError');
    });

    it('leaves the bridge usable after an abandoned body unwinds', async () => {
      attachCounting();
      const controller = new AbortController();

      const abandoned = api
        .withTab('t1', async (tab) => tab.navigate('https://never-loads.example'), {
          signal: controller.signal,
        })
        .catch(() => 'aborted');
      await settle();
      controller.abort();
      expect(await abandoned).toBe('aborted');

      await api.withTab('t2', async () => undefined);
      await api.withTab('t1', async () => undefined);
      expect(api.getTabLockStats().queueDepth).toBe(0);
    });

    it('is a no-op when no signal is supplied', async () => {
      attachCounting();
      const order: string[] = [];
      await api.withTab('t1', async () => order.push('ran'));
      await api.withTab('t1', async () => order.push('ran-again'), {});
      expect(order).toEqual(['ran', 'ran-again']);
    });
  });

  describe('createHarRecorder', () => {
    it('returns a HarRecorder bound to the browser transport', async () => {
      const fs = await VirtualFS.create({ dbName: `har-factory-${dbCounter++}`, wipe: true });

      const recorder = api.createHarRecorder(fs, api.getTransport());
      expect(recorder).toBeInstanceOf(HarRecorder);

      const recordingId = await recorder.startRecording('target-1', 'session-1');
      expect(recordingId).toMatch(/^rec-/);
      expect(mockClient.send).toHaveBeenCalledWith('Network.enable', {}, 'session-1');
      expect(mockClient.on).toHaveBeenCalledWith('Network.requestWillBeSent', expect.any(Function));
    });
  });
});
