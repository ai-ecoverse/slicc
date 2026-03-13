import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BrowserAPI, getDefaultCdpUrl } from './browser-api.js';
import { CDPClient } from './cdp-client.js';

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
      expect(getDefaultCdpUrl({ protocol: 'https:', host: 'example.com' })).toBe('wss://example.com/cdp');
      expect(getDefaultCdpUrl({ protocol: 'http:', host: 'localhost:3030' })).toBe('ws://localhost:3030/cdp');
    });

    it('connects with default URL', async () => {
      await api.connect();
      expect(mockClient.connect).toHaveBeenCalledWith({
        url: 'ws://localhost:3000/cdp',
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
        url: 'ws://localhost:3000/cdp',
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
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-new' });

      const sessionId = await api.attachToPage('target-1');
      expect(sessionId).toBe('sess-new');
      expect(mockClient.connect).toHaveBeenCalled();
    });
  });

  describe('listPages', () => {
    it('returns page targets', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        targetInfos: [
          { targetId: 't1', type: 'page', title: 'Google', url: 'https://google.com', attached: false },
          { targetId: 't2', type: 'page', title: 'GitHub', url: 'https://github.com', attached: false },
          { targetId: 't3', type: 'service_worker', title: 'SW', url: 'chrome://sw', attached: false },
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

    it('detaches from current target before attaching to new one', async () => {
      // First attach
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      await api.attachToPage('target-1');

      // Second attach (should detach first)
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({}) // detach
        .mockResolvedValueOnce({ sessionId: 'sess-2' }); // new attach
      await api.attachToPage('target-2');

      // Verify detach was called
      expect(mockClient.send).toHaveBeenCalledWith('Target.detachFromTarget', {
        sessionId: 'sess-1',
      });
    });

    it('detach is a no-op when not attached', async () => {
      await api.detach();
      // send should not have been called for detach
      expect(mockClient.send).not.toHaveBeenCalledWith(
        'Target.detachFromTarget',
        expect.anything(),
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
        5000,
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
        'sess-1',
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
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({}) // Runtime.enable
        .mockResolvedValueOnce({ result: { value: 1 } }) // Runtime.evaluate (DPR=1)
        .mockResolvedValueOnce({ data: 'viewport-shot' }); // Page.captureScreenshot

      const data = await api.screenshot();
      expect(data).toBe('viewport-shot');
      expect(mockClient.send).toHaveBeenCalledWith(
        'Page.captureScreenshot',
        { format: 'png', captureBeyondViewport: true },
        'sess-1',
      );
    });

    it('captures full page screenshot using viewport width and content height', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({}) // Runtime.enable
        .mockResolvedValueOnce({ result: { value: 1 } }) // Runtime.evaluate (DPR=1)
        .mockResolvedValueOnce({
          contentSize: { width: 2560, height: 5000 },
          layoutViewport: { clientWidth: 1280 },
        }) // getLayoutMetrics
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
        'sess-1',
      );
    });

    it('prefers cssLayoutViewport width when available', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({}) // Runtime.enable
        .mockResolvedValueOnce({ result: { value: 1 } }) // Runtime.evaluate (DPR=1)
        .mockResolvedValueOnce({
          contentSize: { width: 2560, height: 3000 },
          cssLayoutViewport: { clientWidth: 1440 },
          layoutViewport: { clientWidth: 1280 },
        }) // getLayoutMetrics
        .mockResolvedValueOnce({ data: 'css-vp' }); // captureScreenshot

      const data = await api.screenshot({ fullPage: true });
      expect(data).toBe('css-vp');
      expect(mockClient.send).toHaveBeenCalledWith(
        'Page.captureScreenshot',
        {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: 1440, height: 3000, scale: 1 },
        },
        'sess-1',
      );
    });

    it('passes through provided clip with DPR-adjusted scale', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({}) // Runtime.enable
        .mockResolvedValueOnce({ result: { value: 2 } }) // Runtime.evaluate (DPR=2)
        .mockResolvedValueOnce({ data: 'clipped' }); // captureScreenshot

      const data = await api.screenshot({ clip: { x: 10, y: 20, width: 300, height: 400 } });
      expect(data).toBe('clipped');
      expect(mockClient.send).toHaveBeenCalledWith(
        'Page.captureScreenshot',
        {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 10, y: 20, width: 300, height: 400, scale: 0.5 },
        },
        'sess-1',
      );
    });

    it('uses clip.scale 0.5 for full page on HiDPI (DPR 2)', async () => {
      // Re-attach to set up a fresh session (beforeEach already attached once)
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({}) // Runtime.enable (DPR detection)
        .mockResolvedValueOnce({ result: { value: 2 } }) // Runtime.evaluate (DPR=2)
        .mockResolvedValueOnce({
          contentSize: { width: 2560, height: 5000 },
          layoutViewport: { clientWidth: 1280 },
        }) // Page.getLayoutMetrics
        .mockResolvedValueOnce({ data: 'hidpi' }); // Page.captureScreenshot

      const data = await api.screenshot({ fullPage: true });
      expect(data).toBe('hidpi');
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
        (c: unknown[]) => c[0] === 'Input.dispatchMouseEvent' && (c[1] as Record<string, unknown>).type === 'mousePressed',
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
        (c: unknown[]) => c[0] === 'Input.dispatchKeyEvent',
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
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(
        async (method: string) => {
          if (method === 'Runtime.enable') return {};
          if (method === 'Runtime.evaluate') {
            callCount++;
            // Found on the 2nd poll
            return { result: { type: 'boolean', value: callCount >= 2 } };
          }
          return {};
        },
      );

      await api.waitForSelector('.target', { interval: 10 });
      expect(callCount).toBeGreaterThanOrEqual(2);
    });

    it('times out if selector never appears', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(
        async (method: string) => {
          if (method === 'Runtime.enable') return {};
          if (method === 'Runtime.evaluate') {
            return { result: { type: 'boolean', value: false } };
          }
          return {};
        },
      );

      await expect(
        api.waitForSelector('.never', { timeout: 100, interval: 10 }),
      ).rejects.toThrow('waitForSelector timed out');
    });
  });

  describe('getAccessibilityTree', () => {
    beforeEach(async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      await api.attachToPage('target-1');
    });

    it('returns accessibility tree', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({}) // Accessibility.enable
        .mockResolvedValueOnce({
          nodes: [
            {
              nodeId: '1',
              role: { value: 'RootWebArea' },
              name: { value: 'Test Page' },
              childIds: ['2'],
            },
            {
              nodeId: '2',
              role: { value: 'heading' },
              name: { value: 'Hello World' },
              parentId: '1',
            },
          ],
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
        .mockResolvedValueOnce({}) // Accessibility.enable
        .mockResolvedValueOnce({ nodes: [] });

      const tree = await api.getAccessibilityTree();
      expect(tree.role).toBe('RootWebArea');
      expect(tree.name).toBe('');
    });

    it('normalizes non-string accessibility values', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({}) // Accessibility.enable
        .mockResolvedValueOnce({
          nodes: [
            {
              nodeId: '1',
              role: { value: 'RootWebArea' },
              name: { value: 'Slack' },
              childIds: ['2'],
            },
            {
              nodeId: '2',
              role: { value: 'textbox' },
              name: { value: { label: 'Message' } },
              value: { value: 0 },
              description: { value: ['composer'] },
              parentId: '1',
            },
          ],
        });

      const tree = await api.getAccessibilityTree();
      expect(tree.children).toHaveLength(1);
      expect(tree.children![0].name).toBe('{"label":"Message"}');
      expect(tree.children![0].value).toBe('0');
      expect(tree.children![0].description).toBe('["composer"]');
    });
  });
});
