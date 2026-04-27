import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BrowserAPI, getDefaultCdpUrl } from '../../src/cdp/browser-api.js';
import { type CDPClient } from '../../src/cdp/cdp-client.js';

// ---------------------------------------------------------------------------
// Mock CDPClient
// ---------------------------------------------------------------------------

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

    // Test helper: fire an event
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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

  describe('ensureConnected (lazy auto-connect)', () => {
    it('auto-connects when client is disconnected on listPages', async () => {
      // Start disconnected
      (mockClient as unknown as { state: string }).state = 'disconnected';
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ targetInfos: [] });

      await api.listPages();

      // connect() should have been called
      expect(mockClient.connect).toHaveBeenCalledWith({
        url: 'ws://localhost:5710/cdp',
        timeout: undefined,
      });
    });

    it('does not reconnect when already connected', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ targetInfos: [] });

      await api.listPages();

      // connect() should NOT have been called (state is already 'connected')
      expect(mockClient.connect).not.toHaveBeenCalled();
    });

    it('resets sessionId and attachedTargetId on reconnect', async () => {
      // Attach to a page first
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      await api.attachToPage('target-1');

      // Simulate connection drop
      (mockClient as unknown as { state: string }).state = 'disconnected';

      // listPages should auto-connect and not try to use stale session
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

      // Attach to a remote target (switches this.client to remoteClient)
      (remoteClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ sessionId: 'remote-sess' })
        .mockResolvedValueOnce({});
      await api.attachToPage('follower-1:tab-1');

      // listPages should still query the local client, not the remote one
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
      // Verify the remote client was NOT called for Target.getTargets
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

      // listPages() always queries the local client, even when attached to a remote target.
      // The local client returns local browser tabs.
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

      // When attached to a remote target, leader registry entries are NOT deduplicated
      // (shouldDeduplicateLeaderTargets is false), so both local + leader entries appear.
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
      // First attach
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      await api.attachToPage('target-1');

      // Second attach (should NOT detach first — avoids Chrome focus steal)
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-2' }); // direct attach, no detach
      await api.attachToPage('target-2');

      // Verify detach was NOT called
      expect(mockClient.send).not.toHaveBeenCalledWith(
        'Target.detachFromTarget',
        expect.anything()
      );
    });

    it('detach is a no-op when not attached', async () => {
      await api.detach();
      // send should not have been called for detach
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

      // Attach to a remote target first
      (remoteClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ sessionId: 'remote-sess' })
        .mockResolvedValueOnce({});
      await api.attachToPage('follower-1:tab-1');

      // Now attach to a local target — should use localClient, not remoteClient
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ sessionId: 'local-sess' })
        .mockResolvedValueOnce({});
      const sessionId = await api.attachToPage('local-target-1');

      expect(sessionId).toBe('local-sess');
      expect(mockClient.send).toHaveBeenCalledWith('Target.attachToTarget', {
        targetId: 'local-target-1',
        flatten: true,
      });
      // Verify remote client was NOT used for the local attach
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
    beforeEach(async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      await api.attachToPage('target-1');
    });

    it('navigates and waits for load event', async () => {
      // Page.enable, navigate, and once for loadEventFired
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({}) // Page.enable
        .mockResolvedValueOnce({ frameId: 'f1' }); // Page.navigate
      (mockClient.once as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});

      await api.navigate('https://example.com');

      expect(mockClient.send).toHaveBeenCalledWith('Page.enable', {}, 'sess-1');
      expect(mockClient.send).toHaveBeenCalledWith(
        'Page.navigate',
        { url: 'https://example.com' },
        'sess-1'
      );
    });

    it('throws if not attached', async () => {
      await api.detach();
      // Reset mock for detach call
      await expect(api.navigate('https://example.com')).rejects.toThrow('Not attached');
    });
  });

  describe('screenshot', () => {
    beforeEach(async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      await api.attachToPage('target-1');
    });

    it('captures a viewport screenshot (no clip, Chrome default)', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: 'viewport-shot',
      }); // Page.captureScreenshot

      const data = await api.screenshot();
      expect(data).toBe('viewport-shot');
      expect(mockClient.send).toHaveBeenCalledWith(
        'Page.captureScreenshot',
        { format: 'png', captureBeyondViewport: true },
        'sess-1'
      );
      // bringToFront should NOT be called on success
      expect(mockClient.send).not.toHaveBeenCalledWith(
        'Page.bringToFront',
        expect.anything(),
        expect.anything()
      );
    });

    it('retries with bringToFront when capture fails on background tab', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('Unable to capture screenshot')) // first attempt fails
        .mockResolvedValueOnce({}) // Page.bringToFront
        .mockResolvedValueOnce({ data: 'woken-shot' }); // retry captureScreenshot

      const data = await api.screenshot();
      expect(data).toBe('woken-shot');
      expect(mockClient.send).toHaveBeenCalledWith('Page.bringToFront', {}, 'sess-1');
    });

    it('full page screenshot at DPR 1 uses CSS dimensions with scale 1', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({}) // Runtime.enable
        .mockResolvedValueOnce({ result: { value: '{"dpr":1,"w":1280,"h":5000}' } }) // Runtime.evaluate
        .mockResolvedValueOnce({ data: 'fullpage' }); // captureScreenshot

      const data = await api.screenshot({ fullPage: true });
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
        .mockResolvedValueOnce({}) // Runtime.enable
        .mockResolvedValueOnce({ result: { value: '{"w":1440,"h":3130}' } }) // Runtime.evaluate
        .mockResolvedValueOnce({ data: 'hidpi' }); // captureScreenshot

      const data = await api.screenshot({ fullPage: true });
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
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({}) // Runtime.enable
        .mockResolvedValueOnce({ result: { value: '{"w":1280,"h":3000}' } }) // Runtime.evaluate
        .mockResolvedValueOnce({ data: 'clipped' }); // captureScreenshot

      const data = await api.screenshot({ clip: { x: 10, y: 20, width: 300, height: 400 } });
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
    beforeEach(async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      await api.attachToPage('target-1');
    });

    it('evaluates an expression and returns result', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({}) // Runtime.enable
        .mockResolvedValueOnce({
          result: { type: 'number', value: 42 },
        });

      const result = await api.evaluate('1 + 41');
      expect(result).toBe(42);
    });

    it('evaluates string results', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({}) // Runtime.enable
        .mockResolvedValueOnce({
          result: { type: 'string', value: 'hello' },
        });

      const result = await api.evaluate('"hello"');
      expect(result).toBe('hello');
    });

    it('throws on evaluation errors', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({}) // Runtime.enable
        .mockResolvedValueOnce({
          result: { type: 'object' },
          exceptionDetails: {
            text: 'Uncaught ReferenceError',
            exception: { description: 'ReferenceError: foo is not defined' },
          },
        });

      await expect(api.evaluate('foo.bar')).rejects.toThrow('ReferenceError');
    });
  });

  describe('click', () => {
    beforeEach(async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      await api.attachToPage('target-1');
    });

    it('clicks an element by selector', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({}) // DOM.enable
        .mockResolvedValueOnce({ root: { nodeId: 1 } }) // DOM.getDocument
        .mockResolvedValueOnce({ nodeId: 5 }) // DOM.querySelector
        .mockResolvedValueOnce({
          model: { content: [100, 200, 200, 200, 200, 250, 100, 250], width: 100, height: 50 },
        }) // DOM.getBoxModel
        .mockResolvedValueOnce({}) // mousePressed
        .mockResolvedValueOnce({}); // mouseReleased

      await api.click('button.submit');

      // Verify mouse events were dispatched at center of element
      const pressCall = (mockClient.send as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) =>
          c[0] === 'Input.dispatchMouseEvent' &&
          (c[1] as Record<string, unknown>).type === 'mousePressed'
      );
      expect(pressCall).toBeDefined();
      expect((pressCall![1] as Record<string, unknown>).x).toBe(150); // 100 + 100/2
      expect((pressCall![1] as Record<string, unknown>).y).toBe(225); // 200 + 50/2
    });

    it('throws if element not found', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({}) // DOM.enable
        .mockResolvedValueOnce({ root: { nodeId: 1 } }) // DOM.getDocument
        .mockResolvedValueOnce({ nodeId: 0 }); // DOM.querySelector returns 0 = not found

      await expect(api.click('.missing')).rejects.toThrow('Element not found');
    });
  });

  describe('type', () => {
    beforeEach(async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      await api.attachToPage('target-1');
    });

    it('types text character by character', async () => {
      // Each char = 2 send calls (keyDown + keyUp)
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValue({});

      await api.type('hi');

      // Filter to Input.dispatchKeyEvent calls
      const keyCalls = (mockClient.send as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === 'Input.dispatchKeyEvent'
      );
      expect(keyCalls).toHaveLength(4); // 2 chars × 2 events
      expect((keyCalls[0][1] as Record<string, unknown>).type).toBe('keyDown');
      expect((keyCalls[0][1] as Record<string, unknown>).text).toBe('h');
      expect((keyCalls[1][1] as Record<string, unknown>).type).toBe('keyUp');
      expect((keyCalls[2][1] as Record<string, unknown>).text).toBe('i');
    });
  });

  describe('waitForSelector', () => {
    beforeEach(async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      await api.attachToPage('target-1');
    });

    it('resolves when selector is found', async () => {
      let callCount = 0;
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
        if (method === 'Runtime.enable') return {};
        if (method === 'Runtime.evaluate') {
          callCount++;
          // Found on the 2nd poll
          return { result: { type: 'boolean', value: callCount >= 2 } };
        }
        return {};
      });

      await api.waitForSelector('.target', { interval: 10 });
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

      await expect(api.waitForSelector('.never', { timeout: 100, interval: 10 })).rejects.toThrow(
        'waitForSelector timed out'
      );
    });
  });

  describe('getAccessibilityTree', () => {
    beforeEach(async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      await api.attachToPage('target-1');
    });

    it('returns accessibility tree', async () => {
      // The injected script approach uses Runtime.evaluate which returns the tree directly
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({}) // Runtime.enable
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

      const tree = await api.getAccessibilityTree();
      expect(tree.role).toBe('RootWebArea');
      expect(tree.name).toBe('Test Page');
      expect(tree.children).toHaveLength(1);
      expect(tree.children![0].role).toBe('heading');
      expect(tree.children![0].name).toBe('Hello World');
    });

    it('returns fallback for empty tree', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({}) // Runtime.enable
        .mockResolvedValueOnce({
          result: { type: 'undefined', value: undefined },
        });

      const tree = await api.getAccessibilityTree();
      expect(tree.role).toBe('RootWebArea');
      expect(tree.name).toBe('');
    });

    it('normalizes non-string accessibility values', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({}) // Runtime.enable
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

      const tree = await api.getAccessibilityTree();
      expect(tree.children).toHaveLength(1);
      expect(tree.children![0].name).toBe('{"label":"Message"}');
      expect(tree.children![0].value).toBe('0');
      expect(tree.children![0].description).toBe('["composer"]');
    });
  });

  describe('withTab mutex', () => {
    it('serializes two concurrent withTab calls with different targetIds', async () => {
      const order: string[] = [];

      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
        if (method === 'Target.attachToTarget') {
          // Simulate a slow attach to expose race conditions
          await new Promise((r) => setTimeout(r, 10));
        }
        if (method === 'Page.enable') {
          // Simulate page enable
          await new Promise((r) => setTimeout(r, 5));
        }
        return { sessionId: `sess-${order.length + 1}` };
      });

      // Fire two concurrent withTab calls
      const p1 = api
        .withTab('target-1', async (sessionId) => {
          order.push('op1-start');
          await new Promise((r) => setTimeout(r, 20));
          order.push('op1-end');
          return `result-1-${sessionId}`;
        })
        .catch((err) => {
          throw err;
        });

      // Let p1 start
      await new Promise((r) => setTimeout(r, 5));

      const p2 = api
        .withTab('target-2', async (sessionId) => {
          order.push('op2-start');
          await new Promise((r) => setTimeout(r, 15));
          order.push('op2-end');
          return `result-2-${sessionId}`;
        })
        .catch((err) => {
          throw err;
        });

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toContain('result-1-');
      expect(r2).toContain('result-2-');

      // Strict serialization: op1 fully completes before op2 starts.
      // The ordering check alone proves the mutex held — wall-clock margin
      // checks are prone to jitter on CI runners and add no extra coverage.
      expect(order).toEqual(['op1-start', 'op1-end', 'op2-start', 'op2-end']);
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

      // First call throws an error
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

      // Let p1 start and fail
      await new Promise((r) => setTimeout(r, 5));

      // Second call should proceed normally after the first completes
      const p2 = api
        .withTab('target-2', async () => {
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

      // Verify op2 only starts after op1 fully completes (error handled)
      expect(executionOrder).toEqual([
        'op1-start',
        'op1-error',
        'op1-caught',
        'op2-start',
        'op2-end',
      ]);
    });

    it('passes the correct sessionId to the callback', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ sessionId: 'sess-abc' })
        .mockResolvedValueOnce({}); // Page.enable

      const receivedSessionId = await api.withTab('target-1', async (sessionId) => {
        return sessionId;
      });

      expect(receivedSessionId).toBe('sess-abc');
    });

    it('calls attachToPage with the correct targetId', async () => {
      const attachSpy = vi.spyOn(api, 'attachToPage').mockResolvedValueOnce('sess-123');

      await api.withTab('target-xyz', async (sessionId) => {
        return sessionId;
      });

      expect(attachSpy).toHaveBeenCalledWith('target-xyz');
      attachSpy.mockRestore();
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

      // Stagger the start times
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

      // All three must execute in strict FIFO order
      expect(order).toEqual(['1-start', '1-end', '2-start', '2-end', '3-start', '3-end']);
    });
  });
});
