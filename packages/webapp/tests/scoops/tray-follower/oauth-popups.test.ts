import { describe, expect, it, vi } from 'vitest';
import { FollowerSyncManager } from '../../../src/scoops/tray-follower-sync.js';
import { FakeChannel } from './fake-channel.js';

describe('FollowerOAuthPopups (via FollowerSyncManager)', () => {
  it('replies with an error when no popup handler is wired', async () => {
    const channel = new FakeChannel();
    new FollowerSyncManager(channel);
    channel.simulateLeaderMessage({
      type: 'oauth.popup.request',
      requestId: 'oauth-1',
      url: 'https://id.example/authorize',
    });
    await vi.waitFor(() => {
      expect(channel.parseSent()).toContainEqual({
        type: 'oauth.popup.response',
        requestId: 'oauth-1',
        error: 'this follower cannot show an interactive login',
      });
    });
  });

  it('forwards the handler redirect URL to the leader', async () => {
    const channel = new FakeChannel();
    const onOAuthPopupRequest = vi.fn().mockResolvedValue('https://app.example/callback?code=1');
    new FollowerSyncManager(channel, { onOAuthPopupRequest });
    channel.simulateLeaderMessage({
      type: 'oauth.popup.request',
      requestId: 'oauth-2',
      url: 'https://id.example/authorize',
    });
    await vi.waitFor(() => {
      expect(channel.parseSent()).toContainEqual({
        type: 'oauth.popup.response',
        requestId: 'oauth-2',
        redirectUrl: 'https://app.example/callback?code=1',
      });
    });
    expect(onOAuthPopupRequest).toHaveBeenCalledWith(
      'https://id.example/authorize',
      expect.any(AbortSignal)
    );
  });

  it('reports a throwing handler as an error response', async () => {
    const channel = new FakeChannel();
    new FollowerSyncManager(channel, {
      onOAuthPopupRequest: async () => {
        throw new Error('popup blocked');
      },
    });
    channel.simulateLeaderMessage({
      type: 'oauth.popup.request',
      requestId: 'oauth-3',
      url: 'https://id.example/authorize',
    });
    await vi.waitFor(() => {
      expect(channel.parseSent()).toContainEqual({
        type: 'oauth.popup.response',
        requestId: 'oauth-3',
        error: 'popup blocked',
      });
    });
  });

  it('aborts an in-flight popup when the follower closes', async () => {
    const channel = new FakeChannel();
    let seenSignal: AbortSignal | undefined;
    const onOAuthPopupRequest = vi.fn(
      (_url: string, signal: AbortSignal) =>
        new Promise<string | null>((resolve) => {
          seenSignal = signal;
          signal.addEventListener('abort', () => resolve(null));
        })
    );
    const follower = new FollowerSyncManager(channel, { onOAuthPopupRequest });
    channel.simulateLeaderMessage({
      type: 'oauth.popup.request',
      requestId: 'oauth-4',
      url: 'https://id.example/authorize',
    });
    await vi.waitFor(() => expect(onOAuthPopupRequest).toHaveBeenCalled());
    follower.close();
    expect(seenSignal?.aborted).toBe(true);
  });
});
