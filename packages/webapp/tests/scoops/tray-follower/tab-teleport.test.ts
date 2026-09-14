import { describe, expect, it, vi } from 'vitest';
import { FollowerSyncManager } from '../../../src/scoops/tray-follower-sync.js';
import { FakeChannel } from './fake-channel.js';

describe('FollowerTabTeleport (via FollowerSyncManager)', () => {
  describe('tab.open handling', () => {
    it('handles incoming tab.open — creates local tab and sends tab.opened', async () => {
      const channel = new FakeChannel();
      const fakeBrowserTransport = {
        send: vi.fn().mockResolvedValue({ targetId: 'local-new-tab' }),
        connect: vi.fn(),
        disconnect: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        once: vi.fn(),
        state: 'connected' as const,
      };
      const follower = new FollowerSyncManager(channel, { browserTransport: fakeBrowserTransport });

      channel.simulateLeaderMessage({
        type: 'tab.open',
        requestId: 'tabopen-1',
        url: 'https://example.com',
      } as any);

      await vi.waitFor(() => {
        expect(channel.parseSent().length).toBeGreaterThan(0);
      });

      const sent = channel.parseSent();
      const response = sent.find((m) => m.type === 'tab.opened');
      expect(response).toBeDefined();
      if (response && response.type === 'tab.opened') {
        expect(response.requestId).toBe('tabopen-1');
        expect(response.targetId).toBe('local-new-tab');
      }
    });

    it('preview.open is dispatched through executeLocalTabOpen (same as tab.open)', async () => {
      const channel = new FakeChannel();
      const fakeBrowserTransport = {
        send: vi.fn().mockResolvedValue({ targetId: 'preview-tab' }),
        connect: vi.fn(),
        disconnect: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        once: vi.fn(),
        state: 'connected' as const,
      };
      const _follower = new FollowerSyncManager(channel, {
        browserTransport: fakeBrowserTransport,
      });

      channel.simulateLeaderMessage({
        type: 'preview.open',
        requestId: 'prv-1',
        url: 'https://abc--def.sliccy.now/index.html',
      } as any);

      await vi.waitFor(() => {
        expect(channel.parseSent().length).toBeGreaterThan(0);
      });

      const sent = channel.parseSent();
      const response = sent.find((m) => m.type === 'tab.opened');
      expect(response).toBeDefined();
      if (response && response.type === 'tab.opened') {
        expect(response.requestId).toBe('prv-1');
        expect(response.targetId).toBe('preview-tab');
      }
    });

    it('handles incoming tab.open — returns error when no browser transport', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      channel.simulateLeaderMessage({
        type: 'tab.open',
        requestId: 'tabopen-2',
        url: 'https://example.com',
      } as any);

      await vi.waitFor(() => {
        expect(channel.parseSent().length).toBeGreaterThan(0);
      });

      const sent = channel.parseSent();
      const response = sent.find((m) => m.type === 'tab.open.error');
      expect(response).toBeDefined();
      if (response && response.type === 'tab.open.error') {
        expect(response.requestId).toBe('tabopen-2');
        expect(response.error).toBe('Follower has no browser transport');
      }
    });

    it('handles incoming tab.open — returns error on transport failure', async () => {
      const channel = new FakeChannel();
      const fakeBrowserTransport = {
        send: vi.fn().mockRejectedValue(new Error('Target creation failed')),
        connect: vi.fn(),
        disconnect: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        once: vi.fn(),
        state: 'connected' as const,
      };
      const follower = new FollowerSyncManager(channel, { browserTransport: fakeBrowserTransport });

      channel.simulateLeaderMessage({
        type: 'tab.open',
        requestId: 'tabopen-3',
        url: 'https://example.com',
      } as any);

      await vi.waitFor(() => {
        expect(channel.parseSent().length).toBeGreaterThan(0);
      });

      const sent = channel.parseSent();
      const response = sent.find((m) => m.type === 'tab.open.error');
      expect(response).toBeDefined();
      if (response && response.type === 'tab.open.error') {
        expect(response.requestId).toBe('tabopen-3');
        expect(response.error).toBe('Target creation failed');
      }
    });

    it('calls onTargetsChanged after successfully creating a local tab', async () => {
      const channel = new FakeChannel();
      const onTargetsChanged = vi.fn();
      const fakeBrowserTransport = {
        send: vi.fn().mockResolvedValue({ targetId: 'new-tab-id' }),
        connect: vi.fn(),
        disconnect: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        once: vi.fn(),
        state: 'connected' as const,
      };
      const follower = new FollowerSyncManager(channel, {
        browserTransport: fakeBrowserTransport,
        onTargetsChanged,
      });

      channel.simulateLeaderMessage({
        type: 'tab.open',
        requestId: 'tabopen-cb',
        url: 'https://example.com',
      } as any);

      await vi.waitFor(() => {
        expect(channel.parseSent().some((m) => m.type === 'tab.opened')).toBe(true);
      });

      expect(onTargetsChanged).toHaveBeenCalledTimes(1);
    });

    it('does not call onTargetsChanged when tab creation fails', async () => {
      const channel = new FakeChannel();
      const onTargetsChanged = vi.fn();
      const fakeBrowserTransport = {
        send: vi.fn().mockRejectedValue(new Error('Creation failed')),
        connect: vi.fn(),
        disconnect: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        once: vi.fn(),
        state: 'connected' as const,
      };
      const follower = new FollowerSyncManager(channel, {
        browserTransport: fakeBrowserTransport,
        onTargetsChanged,
      });

      channel.simulateLeaderMessage({
        type: 'tab.open',
        requestId: 'tabopen-fail',
        url: 'https://example.com',
      } as any);

      await vi.waitFor(() => {
        expect(channel.parseSent().some((m) => m.type === 'tab.open.error')).toBe(true);
      });

      expect(onTargetsChanged).not.toHaveBeenCalled();
    });

    it('openRemoteTab sends request and resolves on tab.opened', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const promise = follower.openRemoteTab('leader', 'https://remote.com');

      const sent = channel.parseSent();
      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('tab.open');
      if (sent[0].type === 'tab.open') {
        expect((sent[0] as any).targetRuntimeId).toBe('leader');
        expect((sent[0] as any).url).toBe('https://remote.com');

        channel.simulateLeaderMessage({
          type: 'tab.opened',
          requestId: (sent[0] as any).requestId,
          targetId: 'leader:new-tab-1',
        } as any);
      }

      const targetId = await promise;
      expect(targetId).toBe('leader:new-tab-1');
    });

    it('openRemoteTab rejects on tab.open.error', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const promise = follower.openRemoteTab('unknown', 'https://remote.com');

      const sent = channel.parseSent();
      if (sent[0].type === 'tab.open') {
        channel.simulateLeaderMessage({
          type: 'tab.open.error',
          requestId: (sent[0] as any).requestId,
          error: 'Target runtime "unknown" not connected',
        } as any);
      }

      await expect(promise).rejects.toThrow('not connected');
    });

    it('requestTabTeleport asks the leader to pull a tab here and resolves on tab.opened', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const promise = follower.requestTabTeleport('leader:tab1');

      const sent = channel.parseSent().filter((m) => m.type === 'tab.teleport.request');
      expect(sent).toHaveLength(1);

      expect((sent[0] as any).targetId).toBe('leader:tab1');
      expect(sent[0]).not.toHaveProperty('targetRuntimeId');

      channel.simulateLeaderMessage({
        type: 'tab.opened',
        requestId: (sent[0] as any).requestId,
        targetId: 'follower-1:pulled',
      } as any);

      await expect(promise).resolves.toBe('follower-1:pulled');
    });

    it('requestTabTeleport rejects on tab.open.error', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const promise = follower.requestTabTeleport('leader:ghost');
      const sent = channel.parseSent().filter((m) => m.type === 'tab.teleport.request');
      channel.simulateLeaderMessage({
        type: 'tab.open.error',
        requestId: (sent[0] as any).requestId,
        error: 'source tab leader:ghost is not in the tray registry',
      } as any);

      await expect(promise).rejects.toThrow('not in the tray registry');
    });
  });
});
