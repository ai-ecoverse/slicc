import { describe, expect, it, vi } from 'vitest';
import { FollowerSyncManager } from '../../../src/scoops/tray-follower-sync.js';
import { FakeChannel } from './fake-channel.js';

describe('FollowerSprinkleCache (via FollowerSyncManager)', () => {
  describe('sprinkle handling', () => {
    it('dispatches sprinkles.list to onSprinklesList', () => {
      const channel = new FakeChannel();
      const onSprinklesList = vi.fn();
      const follower = new FollowerSyncManager(channel, { onSprinklesList });

      const sprinkles = [
        {
          name: 'welcome',
          title: 'Welcome',
          path: '/shared/sprinkles/welcome.shtml',
          open: true,
          autoOpen: true,
        },
        {
          name: 'todo',
          title: 'Todo',
          path: '/workspace/sprinkles/todo.shtml',
          open: false,
          autoOpen: false,
        },
      ];
      channel.simulateLeaderMessage({ type: 'sprinkles.list', sprinkles });

      expect(onSprinklesList).toHaveBeenCalledWith(sprinkles);
      expect(follower.getSprinkles()).toEqual(sprinkles);
    });

    it('dispatches sprinkle.update to onSprinkleUpdate', () => {
      const channel = new FakeChannel();
      const onSprinkleUpdate = vi.fn();
      new FollowerSyncManager(channel, { onSprinkleUpdate });

      const data = { kind: 'progress', step: 'install', percent: 42 };
      channel.simulateLeaderMessage({ type: 'sprinkle.update', sprinkleName: 'welcome', data });

      expect(onSprinkleUpdate).toHaveBeenCalledWith('welcome', data);
    });

    it('refreshSprinkles sends sprinkles.refresh to the leader', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      follower.refreshSprinkles();

      const sent = channel.parseSent();
      expect(sent).toEqual([{ type: 'sprinkles.refresh' }]);
    });

    it('sendSprinkleLick forwards lick to the leader with body and targetScoop', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      follower.sendSprinkleLick('welcome', { action: 'click', data: { button: 'go' } }, 'scoop-1');

      const sent = channel.parseSent();
      expect(sent).toEqual([
        {
          type: 'sprinkle.lick',
          sprinkleName: 'welcome',
          body: { action: 'click', data: { button: 'go' } },
          targetScoop: 'scoop-1',
        },
      ]);
    });

    it('sendSprinkleLick omits targetScoop when not provided', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      follower.sendSprinkleLick('welcome', { action: 'click' });

      const sent = channel.parseSent() as Array<Record<string, unknown>>;
      expect(sent[0].targetScoop).toBeUndefined();
    });

    it('forwardLick sends a generic lick to the leader and returns true', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);
      const ok = follower.forwardLick({
        type: 'navigate',
        navigateUrl: 'https://x',
        timestamp: 't',
        body: { v: 1 },
      });
      expect(ok).toBe(true);
      expect(channel.parseSent()).toEqual([
        {
          type: 'lick',
          event: { type: 'navigate', navigateUrl: 'https://x', timestamp: 't', body: { v: 1 } },
        },
      ]);
    });

    it('forwardLick returns false and sends nothing when the channel is closed', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);
      channel.close();
      const ok = follower.forwardLick({
        type: 'navigate',
        navigateUrl: 'https://x',
        timestamp: 't',
        body: {},
      });
      expect(ok).toBe(false);
      expect(channel.parseSent()).toHaveLength(0);
    });

    it('fetchSprinkleContent sends sprinkle.fetch and resolves with single-chunk content', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const pending = follower.fetchSprinkleContent('welcome');

      const sent = channel.parseSent();
      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('sprinkle.fetch');
      if (sent[0].type !== 'sprinkle.fetch') throw new Error('unreachable');
      const requestId = sent[0].requestId;
      expect(sent[0].sprinkleName).toBe('welcome');

      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId,
        sprinkleName: 'welcome',
        content: '<p>Hello</p>',
      });

      await expect(pending).resolves.toBe('<p>Hello</p>');
    });

    it('fetchSprinkleContent reassembles chunked sprinkle.content responses', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const pending = follower.fetchSprinkleContent('big');
      const sent = channel.parseSent();
      if (sent[0].type !== 'sprinkle.fetch') throw new Error('unreachable');
      const requestId = sent[0].requestId;

      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId,
        sprinkleName: 'big',
        content: '<p>One',
        chunkIndex: 0,
        totalChunks: 3,
      });
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId,
        sprinkleName: 'big',
        content: ' Two',
        chunkIndex: 1,
        totalChunks: 3,
      });
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId,
        sprinkleName: 'big',
        content: ' Three</p>',
        chunkIndex: 2,
        totalChunks: 3,
      });

      await expect(pending).resolves.toBe('<p>One Two Three</p>');
    });

    it('fetchSprinkleContent handles out-of-order chunks', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const pending = follower.fetchSprinkleContent('big');
      const sent = channel.parseSent();
      if (sent[0].type !== 'sprinkle.fetch') throw new Error('unreachable');
      const requestId = sent[0].requestId;

      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId,
        sprinkleName: 'big',
        content: 'C',
        chunkIndex: 2,
        totalChunks: 3,
      });
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId,
        sprinkleName: 'big',
        content: 'A',
        chunkIndex: 0,
        totalChunks: 3,
      });
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId,
        sprinkleName: 'big',
        content: 'B',
        chunkIndex: 1,
        totalChunks: 3,
      });

      await expect(pending).resolves.toBe('ABC');
    });

    it('fetchSprinkleContent rejects when sprinkle.content carries an error', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const pending = follower.fetchSprinkleContent('missing');
      const sent = channel.parseSent();
      if (sent[0].type !== 'sprinkle.fetch') throw new Error('unreachable');
      const requestId = sent[0].requestId;

      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId,
        sprinkleName: 'missing',
        content: '',
        error: 'Sprinkle not found: missing',
      });

      await expect(pending).rejects.toThrow('Sprinkle not found: missing');
    });

    it('fetchSprinkleContent dedupes concurrent calls for the same sprinkle', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const first = follower.fetchSprinkleContent('welcome');
      const second = follower.fetchSprinkleContent('welcome');

      const sent = channel.parseSent();
      expect(sent).toHaveLength(1);
      if (sent[0].type !== 'sprinkle.fetch') throw new Error('unreachable');
      const requestId = sent[0].requestId;

      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId,
        sprinkleName: 'welcome',
        content: '<p>Welcome</p>',
      });

      await expect(first).resolves.toBe('<p>Welcome</p>');
      await expect(second).resolves.toBe('<p>Welcome</p>');
    });

    it('fetchSprinkleContent caches resolved content and returns it without re-fetching', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const first = follower.fetchSprinkleContent('welcome');
      const sent = channel.parseSent();
      if (sent[0].type !== 'sprinkle.fetch') throw new Error('unreachable');
      const requestId = sent[0].requestId;
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId,
        sprinkleName: 'welcome',
        content: 'cached-content',
      });
      await expect(first).resolves.toBe('cached-content');

      const second = follower.fetchSprinkleContent('welcome');
      await expect(second).resolves.toBe('cached-content');
      expect(channel.parseSent()).toHaveLength(1);
    });

    it('clearSprinkleCache forces the next fetchSprinkleContent to re-request from the leader', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const first = follower.fetchSprinkleContent('welcome');
      let sent = channel.parseSent();
      if (sent[0].type !== 'sprinkle.fetch') throw new Error('unreachable');
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId: sent[0].requestId,
        sprinkleName: 'welcome',
        content: 'v1',
      });
      await first;

      follower.clearSprinkleCache('welcome');
      const second = follower.fetchSprinkleContent('welcome');
      sent = channel.parseSent();
      expect(sent).toHaveLength(2);
      if (sent[1].type !== 'sprinkle.fetch') throw new Error('unreachable');
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId: sent[1].requestId,
        sprinkleName: 'welcome',
        content: 'v2',
      });
      await expect(second).resolves.toBe('v2');
    });

    it('close rejects pending sprinkle fetches so callers do not hang', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const pending = follower.fetchSprinkleContent('welcome');

      follower.close();

      await expect(pending).rejects.toThrow(/closed|disconnect/i);
    });

    it('fetchSprinkleContent times out after sprinkleFetchTimeoutMs when the leader never replies', async () => {
      vi.useFakeTimers();
      try {
        const channel = new FakeChannel();
        const follower = new FollowerSyncManager(channel, { sprinkleFetchTimeoutMs: 1000 });
        const pending = follower
          .fetchSprinkleContent('stuck')
          .then((c) => ({ ok: true as const, c }))
          .catch((err: Error) => ({ ok: false as const, err }));

        await vi.advanceTimersByTimeAsync(1001);
        const result = await pending;
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('unreachable');
        expect(result.err.message).toMatch(/timed out after 1000ms/);

        const before = channel.sent.length;
        const second = follower.fetchSprinkleContent('stuck');

        expect(channel.sent.length).toBeGreaterThan(before);
        const sent = channel.parseSent();
        const lastSent = sent[sent.length - 1];
        if (lastSent.type !== 'sprinkle.fetch') throw new Error('expected sprinkle.fetch');

        channel.simulateLeaderMessage({
          type: 'sprinkle.content',
          requestId: lastSent.requestId,
          sprinkleName: 'stuck',
          content: '<p>finally</p>',
        });
        await expect(second).resolves.toBe('<p>finally</p>');
      } finally {
        vi.useRealTimers();
      }
    });

    it('fetchSprinkleContent timeout does not reject sibling waiters that joined the same fetch', async () => {
      vi.useFakeTimers();
      try {
        const channel = new FakeChannel();
        const follower = new FollowerSyncManager(channel, { sprinkleFetchTimeoutMs: 2000 });

        const first = follower
          .fetchSprinkleContent('big')
          .then((c) => ({ ok: true as const, c }))
          .catch((err: Error) => ({ ok: false as const, err }));

        await vi.advanceTimersByTimeAsync(500);
        const second = follower
          .fetchSprinkleContent('big')
          .then((c) => ({ ok: true as const, c }))
          .catch((err: Error) => ({ ok: false as const, err }));

        await vi.advanceTimersByTimeAsync(1501);
        const firstResult = await first;
        expect(firstResult.ok).toBe(false);

        const sent = channel.parseSent();
        const fetchMsg = sent.find((m) => m.type === 'sprinkle.fetch');
        if (fetchMsg?.type !== 'sprinkle.fetch') {
          throw new Error('expected sprinkle.fetch');
        }
        channel.simulateLeaderMessage({
          type: 'sprinkle.content',
          requestId: fetchMsg.requestId,
          sprinkleName: 'big',
          content: '<p>arrived just in time</p>',
        });

        const secondResult = await second;
        expect(secondResult.ok).toBe(true);
        if (!secondResult.ok) throw new Error('unreachable');
        expect(secondResult.c).toBe('<p>arrived just in time</p>');
      } finally {
        vi.useRealTimers();
      }
    });

    it('handleDisconnect (via channel close) rejects pending sprinkle fetches', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const pending = follower.fetchSprinkleContent('welcome');
      channel.simulateClose();

      await expect(pending).rejects.toThrow(/closed|disconnect/i);
    });

    it('close rejects pending openRemoteTab callers so they do not hang on reconnect', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const pending = follower
        .openRemoteTab('follower-1', 'https://example.test')
        .then((id) => ({ ok: true as const, id }))
        .catch((err: Error) => ({ ok: false as const, err }));
      follower.close();
      const result = await pending;
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.err.message).toMatch(/closed|disconnect/i);
    });

    it('manual close() is idempotent and does not trigger handleDisconnect side effects (status flip, onDisconnect)', () => {
      const channel = new FakeChannel();
      const onDisconnect = vi.fn();
      const onDeadFn = vi.fn();
      const follower = new FollowerSyncManager(channel, {
        onDisconnect,
        onDead: onDeadFn,
      });

      follower.close();

      channel.simulateClose();

      expect(onDisconnect).not.toHaveBeenCalled();

      expect(() => follower.close()).not.toThrow();
    });

    it('FollowerSyncManager throws when constructed with a negative or non-finite sprinkleFetchTimeoutMs', () => {
      const channel = new FakeChannel();
      expect(() => new FollowerSyncManager(channel, { sprinkleFetchTimeoutMs: -1 })).toThrow(
        RangeError
      );
      expect(
        () => new FollowerSyncManager(channel, { sprinkleFetchTimeoutMs: Number.NaN })
      ).toThrow(RangeError);
      expect(
        () => new FollowerSyncManager(channel, { sprinkleFetchTimeoutMs: Number.POSITIVE_INFINITY })
      ).toThrow(RangeError);

      expect(() => new FollowerSyncManager(channel, { sprinkleFetchTimeoutMs: 0 })).not.toThrow();

      expect(
        () => new FollowerSyncManager(channel, { sprinkleFetchTimeoutMs: 1000 })
      ).not.toThrow();
    });

    it('sprinkleFetchTimeoutMs: 0 disables the timer (fetchSprinkleContent never rejects on time)', async () => {
      vi.useFakeTimers();
      try {
        const channel = new FakeChannel();
        const follower = new FollowerSyncManager(channel, { sprinkleFetchTimeoutMs: 0 });
        let state: 'pending' | 'resolved' | 'rejected' = 'pending';
        let value: string | undefined;
        let error: Error | undefined;
        const pending = follower.fetchSprinkleContent('forever').then(
          (c) => {
            state = 'resolved';
            value = c;
          },
          (err: Error) => {
            state = 'rejected';
            error = err;
          }
        );

        await vi.advanceTimersByTimeAsync(25_000);
        expect(state).toBe('pending');

        const sent = channel.parseSent();
        const fetchMsg = sent.find((m) => m.type === 'sprinkle.fetch');
        if (fetchMsg?.type !== 'sprinkle.fetch') {
          throw new Error('expected sprinkle.fetch');
        }
        channel.simulateLeaderMessage({
          type: 'sprinkle.content',
          requestId: fetchMsg.requestId,
          sprinkleName: 'forever',
          content: '<p>resolved</p>',
        });
        await pending;

        expect({ state, error: error?.message }).toEqual({ state: 'resolved', error: undefined });
        expect(value).toBe('<p>resolved</p>');
      } finally {
        vi.useRealTimers();
      }
    });

    it('close rejects in-flight RemoteCDPTransport.send() calls (federated CDP cleanup)', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);
      const transport = follower.createRemoteTransport('follower-1', 'tab-1');
      const pending = transport
        .send('Page.navigate', { url: 'https://example.test' })
        .then((r) => ({ ok: true as const, r }))
        .catch((err: Error) => ({ ok: false as const, err }));
      follower.close();
      const result = await pending;
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.err.message).toMatch(/transport disconnected/i);

      expect(transport.state).toBe('disconnected');
    });

    it('handleDisconnect rejects pending sendFsRequest callers symmetrically', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const pending = follower
        .sendFsRequest('follower-1', {
          op: 'readFile',
          path: '/workspace/x',
        })
        .then((r) => ({ ok: true as const, r }))
        .catch((err: Error) => ({ ok: false as const, err }));
      channel.simulateClose();
      const result = await pending;
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.err.message).toMatch(/closed|disconnect/i);
    });

    it('does not crash on sprinkles.list when no callback is registered', () => {
      const channel = new FakeChannel();
      new FollowerSyncManager(channel);

      expect(() =>
        channel.simulateLeaderMessage({ type: 'sprinkles.list', sprinkles: [] })
      ).not.toThrow();
    });

    it('does not crash on sprinkle.update when no callback is registered', () => {
      const channel = new FakeChannel();
      new FollowerSyncManager(channel);

      expect(() =>
        channel.simulateLeaderMessage({ type: 'sprinkle.update', sprinkleName: 'x', data: {} })
      ).not.toThrow();
    });

    it('drops sprinkle.content that does not match a pending fetch (no crash)', () => {
      const channel = new FakeChannel();
      new FollowerSyncManager(channel);

      expect(() =>
        channel.simulateLeaderMessage({
          type: 'sprinkle.content',
          requestId: 'stale',
          sprinkleName: 'gone',
          content: 'ignored',
        })
      ).not.toThrow();
    });

    it('drops chunked sprinkle.content for an unknown requestId without poisoning the cache', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId: 'stale',
        sprinkleName: 'gone',
        content: 'poison-1',
        chunkIndex: 0,
        totalChunks: 1,
      });

      const pending = follower.fetchSprinkleContent('gone');
      const sent = channel.parseSent();
      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('sprinkle.fetch');
      if (sent[0].type !== 'sprinkle.fetch') throw new Error('unreachable');
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId: sent[0].requestId,
        sprinkleName: 'gone',
        content: 'fresh',
      });
      await expect(pending).resolves.toBe('fresh');
    });

    it('drops chunked sprinkle.content with chunkIndex out of bounds', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      void follower.fetchSprinkleContent('x').catch(() => {});
      const sent = channel.parseSent();
      if (sent[0].type !== 'sprinkle.fetch') throw new Error('unreachable');
      const requestId = sent[0].requestId;

      expect(() =>
        channel.simulateLeaderMessage({
          type: 'sprinkle.content',
          requestId,
          sprinkleName: 'x',
          content: 'bad',
          chunkIndex: 5,
          totalChunks: 3,
        })
      ).not.toThrow();

      expect(() =>
        channel.simulateLeaderMessage({
          type: 'sprinkle.content',
          requestId,
          sprinkleName: 'x',
          content: 'bad',
          chunkIndex: -1,
          totalChunks: 3,
        })
      ).not.toThrow();
    });

    it('does not double-count duplicate chunks (idempotent)', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const pending = follower.fetchSprinkleContent('big');
      const sent = channel.parseSent();
      if (sent[0].type !== 'sprinkle.fetch') throw new Error('unreachable');
      const requestId = sent[0].requestId;

      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId,
        sprinkleName: 'big',
        content: 'A',
        chunkIndex: 0,
        totalChunks: 3,
      });
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId,
        sprinkleName: 'big',
        content: 'A-dup',
        chunkIndex: 0,
        totalChunks: 3,
      });

      let resolved = false;
      void pending.then(() => {
        resolved = true;
      });
      await Promise.resolve();
      expect(resolved).toBe(false);

      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId,
        sprinkleName: 'big',
        content: 'B',
        chunkIndex: 1,
        totalChunks: 3,
      });
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId,
        sprinkleName: 'big',
        content: 'C',
        chunkIndex: 2,
        totalChunks: 3,
      });
      await expect(pending).resolves.toBe('ABC');
    });
  });
  describe('R2-IMP-2: cancelSprinkleFetch', () => {
    it('rejects every pending waiter for the named sprinkle', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const first = follower.fetchSprinkleContent('x');
      const second = follower.fetchSprinkleContent('x');

      follower.cancelSprinkleFetch('x', 'panel timeout');

      await expect(first).rejects.toThrow(/panel timeout/);
      await expect(second).rejects.toThrow(/panel timeout/);
    });

    it('does not affect waiters for other sprinkles', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const x = follower.fetchSprinkleContent('x');
      const y = follower.fetchSprinkleContent('y');

      follower.cancelSprinkleFetch('x');

      const ySent = channel
        .parseSent()
        .find((m) => m.type === 'sprinkle.fetch' && m.sprinkleName === 'y');
      if (ySent?.type !== 'sprinkle.fetch') throw new Error('unreachable');

      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId: ySent.requestId,
        sprinkleName: 'y',
        content: 'y-ok',
      });

      await expect(x).rejects.toThrow(/cancelled/);
      await expect(y).resolves.toBe('y-ok');
    });

    it('subsequent fetch for the cancelled sprinkle goes back on the wire', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const first = follower.fetchSprinkleContent('x');
      follower.cancelSprinkleFetch('x');
      const second = follower.fetchSprinkleContent('x');

      const fetches = channel.parseSent().filter((m) => m.type === 'sprinkle.fetch');
      expect(fetches).toHaveLength(2);
      await expect(first).rejects.toThrow();

      void second;
    });

    it('a late sprinkle.content for a cancelled requestId is dropped (does not poison cache)', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const first = follower.fetchSprinkleContent('x');
      const firstSent = channel.parseSent()[0];
      if (firstSent.type !== 'sprinkle.fetch') throw new Error('unreachable');
      follower.cancelSprinkleFetch('x');
      await expect(first).rejects.toThrow();

      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId: firstSent.requestId,
        sprinkleName: 'x',
        content: 'stale',
      });

      const second = follower.fetchSprinkleContent('x');
      const sent = channel.parseSent().filter((m) => m.type === 'sprinkle.fetch');
      expect(sent).toHaveLength(2);
      if (sent[1].type !== 'sprinkle.fetch') throw new Error('unreachable');
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId: sent[1].requestId,
        sprinkleName: 'x',
        content: 'fresh',
      });
      await expect(second).resolves.toBe('fresh');
    });
  });

  describe('R2-IMP-3: sprinkles.list invalidates sprinkleContentCache', () => {
    it('drops cached content for sprinkles named in the new list', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const first = follower.fetchSprinkleContent('welcome');
      const sent1 = channel.parseSent()[0];
      if (sent1.type !== 'sprinkle.fetch') throw new Error('unreachable');
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId: sent1.requestId,
        sprinkleName: 'welcome',
        content: 'v1',
      });
      await expect(first).resolves.toBe('v1');

      await expect(follower.fetchSprinkleContent('welcome')).resolves.toBe('v1');
      expect(channel.parseSent().filter((m) => m.type === 'sprinkle.fetch')).toHaveLength(1);

      channel.simulateLeaderMessage({
        type: 'sprinkles.list',
        sprinkles: [{ name: 'welcome', title: 'W', path: '/w.shtml', open: true, autoOpen: false }],
      });

      const second = follower.fetchSprinkleContent('welcome');
      const sent2 = channel.parseSent().filter((m) => m.type === 'sprinkle.fetch');
      expect(sent2).toHaveLength(2);
      if (sent2[1].type !== 'sprinkle.fetch') throw new Error('unreachable');
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId: sent2[1].requestId,
        sprinkleName: 'welcome',
        content: 'v2',
      });
      await expect(second).resolves.toBe('v2');
    });

    it('R3-IMP: cache write that races a sprinkles.list broadcast is discarded', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const first = follower.fetchSprinkleContent('x');
      const sent1 = channel.parseSent()[0];
      if (sent1.type !== 'sprinkle.fetch') throw new Error('unreachable');

      channel.simulateLeaderMessage({
        type: 'sprinkles.list',
        sprinkles: [{ name: 'x', title: 'X', path: '/x.shtml', open: true, autoOpen: false }],
      });

      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId: sent1.requestId,
        sprinkleName: 'x',
        content: 'stale-v1',
      });
      await expect(first).resolves.toBe('stale-v1');

      const second = follower.fetchSprinkleContent('x');
      const fetches = channel.parseSent().filter((m) => m.type === 'sprinkle.fetch');
      expect(fetches).toHaveLength(2);
      if (fetches[1].type !== 'sprinkle.fetch') throw new Error('unreachable');
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId: fetches[1].requestId,
        sprinkleName: 'x',
        content: 'fresh-v2',
      });
      await expect(second).resolves.toBe('fresh-v2');
    });

    it('also drops cache entries for sprinkles that disappeared from the list', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const first = follower.fetchSprinkleContent('gone');
      const sent = channel.parseSent()[0];
      if (sent.type !== 'sprinkle.fetch') throw new Error('unreachable');
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId: sent.requestId,
        sprinkleName: 'gone',
        content: 'cached',
      });
      await first;

      channel.simulateLeaderMessage({
        type: 'sprinkles.list',
        sprinkles: [{ name: 'other', title: 'O', path: '/o.shtml', open: false, autoOpen: false }],
      });

      const second = follower.fetchSprinkleContent('gone');
      const fetches = channel.parseSent().filter((m) => m.type === 'sprinkle.fetch');
      expect(fetches).toHaveLength(2);
      void second;
    });
  });
});
