import { describe, expect, it, vi } from 'vitest';
import { FollowerSyncManager } from '../../../src/scoops/tray-follower-sync.js';
import { FakeChannel } from './fake-channel.js';

describe('FollowerRemoteCdp (via FollowerSyncManager)', () => {
  describe('CDP routing', () => {
    it('handles incoming cdp.request — executes locally and returns response', async () => {
      const channel = new FakeChannel();
      const fakeBrowserTransport = {
        send: vi.fn().mockResolvedValue({ sessionId: 'sess-local' }),
        connect: vi.fn(),
        disconnect: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        once: vi.fn(),
        state: 'connected' as const,
      };
      const follower = new FollowerSyncManager(channel, { browserTransport: fakeBrowserTransport });

      channel.simulateLeaderMessage({
        type: 'cdp.request',
        requestId: 'req-1',
        localTargetId: 'tab1',
        method: 'Target.attachToTarget',
        params: { targetId: 'tab1', flatten: true },
      } as any);

      // Wait for async execution
      await vi.waitFor(() => {
        expect(channel.parseSent().length).toBeGreaterThan(0);
      });

      const sent = channel.parseSent();
      const response = sent.find((m) => m.type === 'cdp.response');
      expect(response).toBeDefined();
      if (response && response.type === 'cdp.response') {
        expect(response.requestId).toBe('req-1');
        expect(response.result).toEqual({ sessionId: 'sess-local' });
      }
    });

    it('handles incoming cdp.request — returns error when no browser transport', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      channel.simulateLeaderMessage({
        type: 'cdp.request',
        requestId: 'req-2',
        localTargetId: 'tab1',
        method: 'Page.navigate',
      } as any);

      // Wait for async execution
      await vi.waitFor(() => {
        expect(channel.parseSent().length).toBeGreaterThan(0);
      });

      const sent = channel.parseSent();
      const response = sent.find((m) => m.type === 'cdp.response');
      expect(response).toBeDefined();
      if (response && response.type === 'cdp.response') {
        expect(response.requestId).toBe('req-2');
        expect(response.error).toBe('Follower has no browser transport');
      }
    });

    it('handles incoming cdp.request — returns error on transport failure', async () => {
      const channel = new FakeChannel();
      const fakeBrowserTransport = {
        send: vi.fn().mockRejectedValue(new Error('CDP timeout')),
        connect: vi.fn(),
        disconnect: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        once: vi.fn(),
        state: 'connected' as const,
      };
      const follower = new FollowerSyncManager(channel, { browserTransport: fakeBrowserTransport });

      channel.simulateLeaderMessage({
        type: 'cdp.request',
        requestId: 'req-3',
        localTargetId: 'tab1',
        method: 'Page.navigate',
        params: { url: 'https://example.com' },
      } as any);

      await vi.waitFor(() => {
        expect(channel.parseSent().length).toBeGreaterThan(0);
      });

      const sent = channel.parseSent();
      const response = sent.find((m) => m.type === 'cdp.response');
      expect(response).toBeDefined();
      if (response && response.type === 'cdp.response') {
        expect(response.requestId).toBe('req-3');
        expect(response.error).toBe('CDP timeout');
      }
    });

    it('createRemoteTransport sends requests to leader via data channel', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const transport = follower.createRemoteTransport('leader', 'tab1');

      // Send a CDP command through the remote transport
      void transport.send('Page.navigate', { url: 'https://example.com' });

      const sent = channel.parseSent();
      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('cdp.request');
      if (sent[0].type === 'cdp.request') {
        expect((sent[0] as any).targetRuntimeId).toBe('leader');
        expect((sent[0] as any).localTargetId).toBe('tab1');
        expect((sent[0] as any).method).toBe('Page.navigate');
      }
    });

    it('routes incoming cdp.response to correct RemoteCDPTransport', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const transport = follower.createRemoteTransport('leader', 'tab1');
      const promise = transport.send('Runtime.evaluate', { expression: '1+1' });

      // Get the requestId from the sent message
      const sent = channel.parseSent();
      const request = sent[0] as any;

      // Leader sends back a response
      channel.simulateLeaderMessage({
        type: 'cdp.response',
        requestId: request.requestId,
        result: { result: { value: 2 } },
      } as any);

      const result = await promise;
      expect(result).toEqual({ result: { value: 2 } });
    });

    it('routes incoming cdp.response error to correct RemoteCDPTransport', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const transport = follower.createRemoteTransport('other-follower', 'tab2');
      const promise = transport.send('Page.navigate', { url: 'chrome://crash' });

      const sent = channel.parseSent();
      const request = sent[0] as any;

      channel.simulateLeaderMessage({
        type: 'cdp.response',
        requestId: request.requestId,
        error: 'Target crashed',
      } as any);

      await expect(promise).rejects.toThrow('Target crashed');
    });

    it('removeRemoteTransport disconnects and cleans up', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const transport = follower.createRemoteTransport('leader', 'tab1');
      expect(transport.state).toBe('connected');

      follower.removeRemoteTransport('leader', 'tab1');
      expect(transport.state).toBe('disconnected');
    });
  });

  describe('CDP event forwarding', () => {
    it('forwards CDP events for remote-initiated sessions to the leader', async () => {
      const channel = new FakeChannel();
      const eventListeners = new Map<string, Set<Function>>();
      const fakeBrowserTransport = {
        send: vi.fn().mockImplementation((method: string) => {
          if (method === 'Target.attachToTarget')
            return Promise.resolve({ sessionId: 'sess-remote' });
          return Promise.resolve({});
        }),
        connect: vi.fn(),
        disconnect: vi.fn(),
        on: vi.fn((event: string, listener: Function) => {
          if (!eventListeners.has(event)) eventListeners.set(event, new Set());
          eventListeners.get(event)!.add(listener);
        }),
        off: vi.fn((event: string, listener: Function) => {
          eventListeners.get(event)?.delete(listener);
        }),
        once: vi.fn(),
        state: 'connected' as const,
      };
      const follower = new FollowerSyncManager(channel, { browserTransport: fakeBrowserTransport });

      // Simulate remote CDP request: leader attaches to a follower tab
      channel.simulateLeaderMessage({
        type: 'cdp.request',
        requestId: 'req-attach',
        localTargetId: 'tab1',
        method: 'Target.attachToTarget',
        params: { targetId: 'tab1', flatten: true },
      } as any);

      await vi.waitFor(() => {
        expect(channel.parseSent().some((m) => m.type === 'cdp.response')).toBe(true);
      });

      // Event listeners should have been registered on the local transport
      expect(fakeBrowserTransport.on).toHaveBeenCalled();

      channel.sent.length = 0;

      // Simulate a Page.frameNavigated event from the local browser for the remote session
      for (const listener of eventListeners.get('Page.frameNavigated') ?? []) {
        (listener as (params: Record<string, unknown>) => void)({
          sessionId: 'sess-remote',
          frame: { url: 'https://navigated.com', id: 'main' },
        });
      }

      // The follower should have forwarded the event to the leader
      const sent = channel.parseSent();
      const eventMsg = sent.find((m) => m.type === 'cdp.event');
      expect(eventMsg).toBeDefined();
      if (eventMsg && eventMsg.type === 'cdp.event') {
        expect(eventMsg.method).toBe('Page.frameNavigated');
        expect(eventMsg.sessionId).toBe('sess-remote');
        expect((eventMsg as any).params.frame).toEqual({
          url: 'https://navigated.com',
          id: 'main',
        });
        // sessionId should NOT be in the forwarded params (it's at message level)
        expect((eventMsg as any).params.sessionId).toBeUndefined();
      }

      const runtimeEvents = [
        [
          'Runtime.executionContextCreated',
          { context: { id: 42, auxData: { frameId: 'frame-1', isDefault: true } } },
        ],
        ['Runtime.executionContextDestroyed', { executionContextId: 42 }],
        ['Runtime.executionContextsCleared', {}],
      ] as const;
      for (const [method, params] of runtimeEvents) {
        channel.sent.length = 0;
        for (const listener of eventListeners.get(method) ?? []) {
          (listener as (event: Record<string, unknown>) => void)({
            sessionId: 'sess-remote',
            ...params,
          });
        }
        expect(channel.parseSent()).toContainEqual({
          type: 'cdp.event',
          method,
          params,
          sessionId: 'sess-remote',
        });
      }
    });

    it('does NOT forward events for non-remote sessions', async () => {
      const channel = new FakeChannel();
      const eventListeners = new Map<string, Set<Function>>();
      const fakeBrowserTransport = {
        send: vi.fn().mockImplementation((method: string) => {
          if (method === 'Target.attachToTarget')
            return Promise.resolve({ sessionId: 'sess-remote' });
          return Promise.resolve({});
        }),
        connect: vi.fn(),
        disconnect: vi.fn(),
        on: vi.fn((event: string, listener: Function) => {
          if (!eventListeners.has(event)) eventListeners.set(event, new Set());
          eventListeners.get(event)!.add(listener);
        }),
        off: vi.fn((event: string, listener: Function) => {
          eventListeners.get(event)?.delete(listener);
        }),
        once: vi.fn(),
        state: 'connected' as const,
      };
      const follower = new FollowerSyncManager(channel, { browserTransport: fakeBrowserTransport });

      // Remote session attach
      channel.simulateLeaderMessage({
        type: 'cdp.request',
        requestId: 'req-attach',
        localTargetId: 'tab1',
        method: 'Target.attachToTarget',
        params: { targetId: 'tab1', flatten: true },
      } as any);

      await vi.waitFor(() => {
        expect(channel.parseSent().some((m) => m.type === 'cdp.response')).toBe(true);
      });

      channel.sent.length = 0;

      // Fire event for a DIFFERENT session (the follower's own browsing)
      for (const listener of eventListeners.get('Page.frameNavigated') ?? []) {
        (listener as (params: Record<string, unknown>) => void)({
          sessionId: 'sess-local-own',
          frame: { url: 'https://local.com', id: 'main' },
        });
      }

      // Should NOT forward the event
      const sent = channel.parseSent();
      expect(sent.filter((m) => m.type === 'cdp.event')).toHaveLength(0);
    });

    it('cleans up event forwarding on close', async () => {
      const channel = new FakeChannel();
      const eventListeners = new Map<string, Set<Function>>();
      const fakeBrowserTransport = {
        send: vi.fn().mockResolvedValue({ sessionId: 'sess-remote' }),
        connect: vi.fn(),
        disconnect: vi.fn(),
        on: vi.fn((event: string, listener: Function) => {
          if (!eventListeners.has(event)) eventListeners.set(event, new Set());
          eventListeners.get(event)!.add(listener);
        }),
        off: vi.fn((event: string, listener: Function) => {
          eventListeners.get(event)?.delete(listener);
        }),
        once: vi.fn(),
        state: 'connected' as const,
      };
      const follower = new FollowerSyncManager(channel, { browserTransport: fakeBrowserTransport });

      // Remote session attach
      channel.simulateLeaderMessage({
        type: 'cdp.request',
        requestId: 'req-attach',
        localTargetId: 'tab1',
        method: 'Target.attachToTarget',
        params: { targetId: 'tab1', flatten: true },
      } as any);

      await vi.waitFor(() => {
        expect(channel.parseSent().some((m) => m.type === 'cdp.response')).toBe(true);
      });

      // Verify listeners were registered
      expect(fakeBrowserTransport.on).toHaveBeenCalled();
      const onCallCount = fakeBrowserTransport.on.mock.calls.length;

      // Close the follower
      follower.close();

      // off() should have been called to remove all registered listeners
      expect(fakeBrowserTransport.off).toHaveBeenCalledTimes(onCallCount);
    });

    it('routes Runtime lifecycle events from leader with the session identity restored', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const transport = follower.createRemoteTransport('other-runtime', 'tab2');

      // Register an event listener on the remote transport
      const events: Record<string, unknown>[] = [];
      transport.on('Runtime.executionContextCreated', (params) => events.push(params));

      // Simulate leader forwarding a cdp.event
      channel.simulateLeaderMessage({
        type: 'cdp.event',
        method: 'Runtime.executionContextCreated',
        params: { context: { id: 42, auxData: { frameId: 'frame-1', isDefault: true } } },
        sessionId: 'sess-1',
      } as any);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        context: { id: 42, auxData: { frameId: 'frame-1', isDefault: true } },
        sessionId: 'sess-1',
      });
    });
  });
});
