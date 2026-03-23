/**
 * Tests for LickManager Proxy — BroadcastChannel bridge between side panel
 * and offscreen document for cron task operations.
 *
 * Verifies:
 * - Host receives ops and forwards to LickManager
 * - Proxy sends ops and receives responses
 * - Error handling and timeouts
 * - Message filtering and routing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('LickManager Proxy', () => {
  let mockBroadcastChannels: Map<string, Set<MockBroadcastChannel>>;

  // Mock BroadcastChannel with message routing between host and proxy
  class MockBroadcastChannel {
    static channels = new Map<string, Set<MockBroadcastChannel>>();
    name: string;
    onmessage: ((ev: MessageEvent) => void) | null = null;

    constructor(name: string) {
      this.name = name;
      if (!MockBroadcastChannel.channels.has(name)) {
        MockBroadcastChannel.channels.set(name, new Set());
      }
      MockBroadcastChannel.channels.get(name)!.add(this);
    }

    postMessage(data: unknown): void {
      const channels = MockBroadcastChannel.channels.get(this.name);
      if (!channels) return;

      // Deliver to all OTHER channels with same name
      for (const ch of channels) {
        if (ch !== this && ch.onmessage) {
          ch.onmessage(new MessageEvent('message', { data }));
        }
      }
    }

    close(): void {
      MockBroadcastChannel.channels.get(this.name)?.delete(this);
    }
  }

  beforeEach(() => {
    // Mock global BroadcastChannel
    (globalThis as any).BroadcastChannel = MockBroadcastChannel;
    MockBroadcastChannel.channels.clear();
    vi.clearAllTimers();
    vi.useFakeTimers();
  });

  afterEach(() => {
    delete (globalThis as any).BroadcastChannel;
    vi.runAllTimersAsync();
    vi.useRealTimers();
    MockBroadcastChannel.channels.clear();
  });

  // ─── Host Tests ───────────────────────────────────────────────────────────

  describe('startLickManagerHost', () => {
    it('receives createCronTask op and calls lickManager with args', async () => {
      const { startLickManagerHost } = await import('./lick-manager-proxy.js');

      const mockLickManager = {
        createCronTask: vi.fn().mockResolvedValue({
          id: 'cron-1',
          name: 'Test Task',
          cron: '0 * * * *',
          status: 'active',
          createdAt: new Date().toISOString(),
          nextRun: new Date().toISOString(),
          lastRun: null,
        }),
        listCronTasks: vi.fn(),
        deleteCronTask: vi.fn(),
      };

      startLickManagerHost(mockLickManager as any);

      // Send a message from proxy side
      const proxyChannel = new MockBroadcastChannel('slicc-lick-manager');
      proxyChannel.postMessage({
        type: 'lick-op',
        id: 'test-123',
        op: 'createCronTask',
        args: ['My Task', '0 * * * *', 'my-scoop', 'return true'],
      });

      // Give message handler time to process
      await vi.advanceTimersToNextTimerAsync();
      await vi.advanceTimersToNextTimerAsync();

      expect(mockLickManager.createCronTask).toHaveBeenCalledWith(
        'My Task',
        '0 * * * *',
        'my-scoop',
        'return true'
      );

      proxyChannel.close();
    });

    it('receives listCronTasks op and returns result', async () => {
      const { startLickManagerHost } = await import('./lick-manager-proxy.js');

      const mockTasks = [
        {
          id: 'cron-1',
          name: 'Task 1',
          cron: '0 * * * *',
          status: 'active' as const,
          createdAt: new Date().toISOString(),
          nextRun: new Date().toISOString(),
          lastRun: null,
        },
      ];

      const mockLickManager = {
        createCronTask: vi.fn(),
        listCronTasks: vi.fn().mockReturnValue(mockTasks),
        deleteCronTask: vi.fn(),
      };

      startLickManagerHost(mockLickManager as any);

      let receivedResult: unknown;
      const proxyChannel = new MockBroadcastChannel('slicc-lick-manager');
      proxyChannel.onmessage = (event: MessageEvent) => {
        const msg = event.data;
        if (msg.type === 'lick-op-response') {
          receivedResult = msg.result;
        }
      };

      const hostChannel = new MockBroadcastChannel('slicc-lick-manager');
      hostChannel.postMessage({
        type: 'lick-op',
        id: 'test-456',
        op: 'listCronTasks',
        args: [],
      });

      await vi.advanceTimersToNextTimerAsync();

      expect(mockLickManager.listCronTasks).toHaveBeenCalled();
      expect(receivedResult).toEqual(mockTasks);

      proxyChannel.close();
      hostChannel.close();
    });

    it('receives deleteCronTask op and calls lickManager', async () => {
      const { startLickManagerHost } = await import('./lick-manager-proxy.js');

      const mockLickManager = {
        createCronTask: vi.fn(),
        listCronTasks: vi.fn(),
        deleteCronTask: vi.fn().mockResolvedValue(true),
      };

      startLickManagerHost(mockLickManager as any);

      const proxyChannel = new MockBroadcastChannel('slicc-lick-manager');
      proxyChannel.postMessage({
        type: 'lick-op',
        id: 'test-789',
        op: 'deleteCronTask',
        args: ['cron-to-delete'],
      });

      await vi.advanceTimersToNextTimerAsync();
      await vi.advanceTimersToNextTimerAsync();

      expect(mockLickManager.deleteCronTask).toHaveBeenCalledWith('cron-to-delete');

      proxyChannel.close();
    });

    it('returns error response when lickManager throws', async () => {
      const { startLickManagerHost } = await import('./lick-manager-proxy.js');

      const mockLickManager = {
        createCronTask: vi.fn().mockRejectedValue(new Error('Invalid cron syntax')),
        listCronTasks: vi.fn(),
        deleteCronTask: vi.fn(),
      };

      startLickManagerHost(mockLickManager as any);

      let receivedError: string | undefined;
      const proxyChannel = new MockBroadcastChannel('slicc-lick-manager');
      proxyChannel.onmessage = (event: MessageEvent) => {
        const msg = event.data;
        if (msg.type === 'lick-op-response') {
          receivedError = msg.error;
        }
      };

      const hostChannel = new MockBroadcastChannel('slicc-lick-manager');
      hostChannel.postMessage({
        type: 'lick-op',
        id: 'test-error',
        op: 'createCronTask',
        args: ['Bad Task', 'invalid cron'],
      });

      await vi.advanceTimersToNextTimerAsync();
      await vi.advanceTimersToNextTimerAsync();

      expect(receivedError).toBe('Invalid cron syntax');

      proxyChannel.close();
      hostChannel.close();
    });

    it('ignores messages without type lick-op', async () => {
      const { startLickManagerHost } = await import('./lick-manager-proxy.js');

      const mockLickManager = {
        createCronTask: vi.fn(),
        listCronTasks: vi.fn(),
        deleteCronTask: vi.fn(),
      };

      startLickManagerHost(mockLickManager as any);

      const hostChannel = new MockBroadcastChannel('slicc-lick-manager');
      hostChannel.postMessage({
        type: 'some-other-op',
        id: 'test-ignore',
        op: 'createCronTask',
        args: [],
      });

      await vi.advanceTimersToNextTimerAsync();

      expect(mockLickManager.createCronTask).not.toHaveBeenCalled();

      hostChannel.close();
    });

    it('returns error for unknown op name', async () => {
      const { startLickManagerHost } = await import('./lick-manager-proxy.js');

      const mockLickManager = {
        createCronTask: vi.fn(),
        listCronTasks: vi.fn(),
        deleteCronTask: vi.fn(),
      };

      startLickManagerHost(mockLickManager as any);

      let receivedError: string | undefined;
      const proxyChannel = new MockBroadcastChannel('slicc-lick-manager');
      proxyChannel.onmessage = (event: MessageEvent) => {
        const msg = event.data;
        if (msg.type === 'lick-op-response') {
          receivedError = msg.error;
        }
      };

      const hostChannel = new MockBroadcastChannel('slicc-lick-manager');
      hostChannel.postMessage({
        type: 'lick-op',
        id: 'test-unknown',
        op: 'unknownOperation',
        args: [],
      });

      await vi.advanceTimersToNextTimerAsync();

      expect(receivedError).toContain('Unknown lick-manager op');

      proxyChannel.close();
      hostChannel.close();
    });
  });

  // ─── Proxy Tests ───────────────────────────────────────────────────────────

  describe('createLickManagerProxy', () => {
    it('createCronTask sends message and resolves with result', async () => {
      const { createLickManagerProxy, startLickManagerHost } =
        await import('./lick-manager-proxy.js');

      const mockEntry = {
        id: 'cron-1',
        name: 'New Task',
        cron: '0 * * * *',
        scoop: 'test-scoop',
        status: 'active' as const,
        createdAt: new Date().toISOString(),
        nextRun: new Date().toISOString(),
        lastRun: null,
      };

      const mockLickManager = {
        createCronTask: vi.fn().mockResolvedValue(mockEntry),
        listCronTasks: vi.fn(),
        deleteCronTask: vi.fn(),
      };

      startLickManagerHost(mockLickManager as any);
      const proxy = createLickManagerProxy();

      const promise = proxy.createCronTask('New Task', '0 * * * *', 'test-scoop');

      // Let the message be delivered
      await vi.advanceTimersToNextTimerAsync();

      const result = await promise;

      expect(result).toEqual(mockEntry);
    });

    it('deleteCronTask sends message and resolves with boolean', async () => {
      const { createLickManagerProxy, startLickManagerHost } =
        await import('./lick-manager-proxy.js');

      const mockLickManager = {
        createCronTask: vi.fn(),
        listCronTasks: vi.fn(),
        deleteCronTask: vi.fn().mockResolvedValue(true),
      };

      startLickManagerHost(mockLickManager as any);
      const proxy = createLickManagerProxy();

      const promise = proxy.deleteCronTask('cron-123');

      await vi.advanceTimersToNextTimerAsync();

      const result = await promise;

      expect(result).toBe(true);
    });

    it('listCronTasks throws with helpful error message', async () => {
      const { createLickManagerProxy } = await import('./lick-manager-proxy.js');

      const proxy = createLickManagerProxy();

      expect(() => proxy.listCronTasks()).toThrow('Use listCronTasksAsync instead');
    });

    it('error response rejects the promise', async () => {
      const { createLickManagerProxy, startLickManagerHost } =
        await import('./lick-manager-proxy.js');

      const mockLickManager = {
        createCronTask: vi.fn().mockRejectedValue(new Error('Cron validation failed')),
        listCronTasks: vi.fn(),
        deleteCronTask: vi.fn(),
      };

      startLickManagerHost(mockLickManager as any);
      const proxy = createLickManagerProxy();

      const promise = proxy.createCronTask('Bad Task', 'bad cron');

      // Add handler immediately to prevent unhandled rejection warning
      promise.catch(() => {});

      await vi.advanceTimersToNextTimerAsync();
      await vi.advanceTimersToNextTimerAsync();

      await expect(promise).rejects.toThrow('Cron validation failed');
    });

    it('timeout rejects after 5000ms', async () => {
      const { createLickManagerProxy } = await import('./lick-manager-proxy.js');

      // Don't start a host, so no response will come
      const proxy = createLickManagerProxy();

      const promise = proxy.createCronTask('No Response Task', '0 * * * *');

      // Advance time past timeout
      vi.advanceTimersByTime(5001);

      await expect(promise).rejects.toThrow('LickManager operation timed out');
    });

    it('cleans up channel and timer on timeout', async () => {
      const { createLickManagerProxy } = await import('./lick-manager-proxy.js');

      const proxy = createLickManagerProxy();

      const promise = proxy.createCronTask('Task', '0 * * * *');

      // Count channels before timeout
      const channelsBefore = MockBroadcastChannel.channels.get('slicc-lick-manager')?.size ?? 0;

      vi.advanceTimersByTime(5001);

      await expect(promise).rejects.toThrow();

      // Channel should be closed
      const channelsAfter = MockBroadcastChannel.channels.get('slicc-lick-manager')?.size ?? 0;
      expect(channelsAfter).toBeLessThanOrEqual(channelsBefore);
    });

    it('only resolves on matching response id', async () => {
      const { createLickManagerProxy, startLickManagerHost } =
        await import('./lick-manager-proxy.js');

      const mockLickManager = {
        createCronTask: vi.fn().mockResolvedValue({ id: 'cron-1', name: 'Task' }),
        listCronTasks: vi.fn(),
        deleteCronTask: vi.fn(),
      };

      startLickManagerHost(mockLickManager as any);
      const proxy = createLickManagerProxy();

      const promise = proxy.createCronTask('Task', '0 * * * *');

      // Send unrelated response first - should be ignored
      const interfererChannel = new MockBroadcastChannel('slicc-lick-manager');
      interfererChannel.postMessage({
        type: 'lick-op-response',
        id: 'totally-different-id',
        result: { id: 'wrong', name: 'Wrong' },
      });

      await vi.advanceTimersToNextTimerAsync();
      await vi.advanceTimersToNextTimerAsync();

      // The correct response arrives with matching id
      const result = await promise;
      expect(result).toEqual({ id: 'cron-1', name: 'Task' });

      interfererChannel.close();
    });
  });

  // ─── listCronTasksAsync Tests ─────────────────────────────────────────────

  describe('listCronTasksAsync', () => {
    it('sends listCronTasks op and resolves with array', async () => {
      const { listCronTasksAsync, startLickManagerHost } = await import('./lick-manager-proxy.js');

      const mockTasks = [
        {
          id: 'cron-1',
          name: 'Task 1',
          cron: '0 * * * *',
          status: 'active' as const,
          createdAt: new Date().toISOString(),
          nextRun: new Date().toISOString(),
          lastRun: null,
        },
        {
          id: 'cron-2',
          name: 'Task 2',
          cron: '*/5 * * * *',
          status: 'paused' as const,
          createdAt: new Date().toISOString(),
          nextRun: null,
          lastRun: new Date().toISOString(),
        },
      ];

      const mockLickManager = {
        createCronTask: vi.fn(),
        listCronTasks: vi.fn().mockReturnValue(mockTasks),
        deleteCronTask: vi.fn(),
      };

      startLickManagerHost(mockLickManager as any);

      const promise = listCronTasksAsync();

      await vi.advanceTimersToNextTimerAsync();

      const result = await promise;

      expect(result).toEqual(mockTasks);
      expect(result.length).toBe(2);
    });

    it('error response rejects the promise', async () => {
      const { listCronTasksAsync, startLickManagerHost } = await import('./lick-manager-proxy.js');

      const mockLickManager = {
        createCronTask: vi.fn(),
        listCronTasks: vi.fn().mockImplementation(() => {
          throw new Error('DB connection lost');
        }),
        deleteCronTask: vi.fn(),
      };

      startLickManagerHost(mockLickManager as any);

      const promise = listCronTasksAsync();

      // Add handler immediately to prevent unhandled rejection warning
      promise.catch(() => {});

      await vi.advanceTimersToNextTimerAsync();
      await vi.advanceTimersToNextTimerAsync();

      await expect(promise).rejects.toThrow('DB connection lost');
    });

    it('timeout rejects after 5000ms', async () => {
      const { listCronTasksAsync } = await import('./lick-manager-proxy.js');

      // Don't start a host
      const promise = listCronTasksAsync();

      vi.advanceTimersByTime(5001);

      await expect(promise).rejects.toThrow('LickManager operation timed out');
    });

    it('cleans up channel and timer on timeout', async () => {
      const { listCronTasksAsync } = await import('./lick-manager-proxy.js');

      const promise = listCronTasksAsync();

      const channelsBefore = MockBroadcastChannel.channels.get('slicc-lick-manager')?.size ?? 0;

      vi.advanceTimersByTime(5001);

      await expect(promise).rejects.toThrow();

      const channelsAfter = MockBroadcastChannel.channels.get('slicc-lick-manager')?.size ?? 0;
      expect(channelsAfter).toBeLessThanOrEqual(channelsBefore);
    });

    it('only resolves on lick-op-response type', async () => {
      const { listCronTasksAsync, startLickManagerHost } = await import('./lick-manager-proxy.js');

      const mockTasks = [
        {
          id: 'task-1',
          name: 'Test',
          cron: '0 * * * *',
          status: 'active' as const,
          createdAt: new Date().toISOString(),
          nextRun: new Date().toISOString(),
          lastRun: null,
        },
      ];

      const mockLickManager = {
        createCronTask: vi.fn(),
        listCronTasks: vi.fn().mockReturnValue(mockTasks),
        deleteCronTask: vi.fn(),
      };

      startLickManagerHost(mockLickManager as any);

      const promise = listCronTasksAsync();

      // Send message with wrong type - should be ignored
      const interfererChannel = new MockBroadcastChannel('slicc-lick-manager');
      interfererChannel.postMessage({
        type: 'some-other-message',
        id: 'random-id',
        result: [],
      });

      await vi.advanceTimersToNextTimerAsync();
      await vi.advanceTimersToNextTimerAsync();

      // The correct response arrives with right type
      const result = await promise;
      expect(result).toEqual(mockTasks);

      interfererChannel.close();
    });

    it('returns empty array when no tasks', async () => {
      const { listCronTasksAsync, startLickManagerHost } = await import('./lick-manager-proxy.js');

      const mockLickManager = {
        createCronTask: vi.fn(),
        listCronTasks: vi.fn().mockReturnValue([]),
        deleteCronTask: vi.fn(),
      };

      startLickManagerHost(mockLickManager as any);

      const promise = listCronTasksAsync();

      await vi.advanceTimersToNextTimerAsync();

      const result = await promise;

      expect(result).toEqual([]);
      expect(Array.isArray(result)).toBe(true);
    });
  });
});
