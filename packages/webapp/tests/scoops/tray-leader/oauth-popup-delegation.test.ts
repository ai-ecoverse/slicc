import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/base/logger.js';
import type { LeaderSyncContext } from '../../../src/scoops/tray-leader/context.js';
import {
  type ConnectedFollower,
  FollowerRegistry,
} from '../../../src/scoops/tray-leader/follower-registry.js';
import { OAuthPopupDelegation } from '../../../src/scoops/tray-leader/oauth-popup-delegation.js';
import type { LeaderSyncManagerOptions } from '../../../src/scoops/tray-leader-sync.js';
import type { LeaderToFollowerMessage } from '../../../src/scoops/tray-sync-protocol.js';

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize?client_id=abc';

function createHarness(opts: { sendFails?: boolean } = {}) {
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
        return !opts.sendFails;
      }),
      close: vi.fn(),
    },
  } as unknown as ConnectedFollower);

  const options = {
    getMessages: () => [],
    getScoopJid: () => 'cone',
    onFollowerMessage: vi.fn(),
    onFollowerAbort: vi.fn(),
    sendControl: vi.fn(),
  } as unknown as LeaderSyncManagerOptions;
  const context: LeaderSyncContext = {
    options,
    followers,
    log,
    sendControl: options.sendControl,
  };
  return { delegation: new OAuthPopupDelegation(context), followers, sent };
}

function lastRequestId(sent: LeaderToFollowerMessage[]): string {
  const request = sent.find((m) => m.type === 'oauth.popup.request');
  if (request?.type !== 'oauth.popup.request') throw new Error('no request sent');
  return request.requestId;
}

describe('OAuthPopupDelegation', () => {
  it('sends only the authorize URL and resolves with the captured callback', async () => {
    const { delegation, sent } = createHarness();
    const pending = delegation.requestPopup('boot-1', AUTHORIZE_URL);

    const request = sent[0];
    expect(request).toEqual({
      type: 'oauth.popup.request',
      requestId: expect.any(String),
      url: AUTHORIZE_URL,
    });

    delegation.handlePopupResponse(
      'boot-1',
      lastRequestId(sent),
      'https://www.sliccy.ai/auth/callback?code=abc123&nonce=n1',
      undefined
    );
    await expect(pending).resolves.toEqual({
      redirectUrl: 'https://www.sliccy.ai/auth/callback?code=abc123&nonce=n1',
      error: undefined,
    });
  });

  it('reports a cancel as a null redirect rather than an error', async () => {
    const { delegation, sent } = createHarness();
    const pending = delegation.requestPopup('boot-1', AUTHORIZE_URL);
    delegation.handlePopupResponse('boot-1', lastRequestId(sent), undefined, undefined);
    await expect(pending).resolves.toEqual({ redirectUrl: null, error: undefined });
  });

  it('propagates a follower-reported error', async () => {
    const { delegation, sent } = createHarness();
    const pending = delegation.requestPopup('boot-1', AUTHORIZE_URL);
    delegation.handlePopupResponse(
      'boot-1',
      lastRequestId(sent),
      undefined,
      'this follower cannot show an interactive login'
    );
    await expect(pending).resolves.toEqual({
      redirectUrl: null,
      error: 'this follower cannot show an interactive login',
    });
  });

  it('fails closed when the follower is already gone', async () => {
    const { delegation } = createHarness();
    await expect(delegation.requestPopup('ghost', AUTHORIZE_URL)).resolves.toEqual({
      redirectUrl: null,
      error: 'follower is no longer connected',
    });
  });

  it('fails closed when the request cannot be delivered', async () => {
    const { delegation } = createHarness({ sendFails: true });
    await expect(delegation.requestPopup('boot-1', AUTHORIZE_URL)).resolves.toEqual({
      redirectUrl: null,
      error: 'could not reach the follower',
    });
  });

  it('fails closed when the follower disconnects mid-login', async () => {
    const { delegation, followers } = createHarness();
    const pending = delegation.requestPopup('boot-1', AUTHORIZE_URL);
    followers.removeFollower('boot-1');
    await expect(pending).resolves.toEqual({
      redirectUrl: null,
      error: 'the follower handling this login disconnected',
    });
  });

  it('times out inside the panel-RPC budget instead of hanging', async () => {
    vi.useFakeTimers();
    try {
      const { delegation } = createHarness();
      const pending = delegation.requestPopup('boot-1', AUTHORIZE_URL);
      await vi.advanceTimersByTimeAsync(126_000);
      await expect(pending).resolves.toEqual({
        redirectUrl: null,
        error: 'the delegated login timed out',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a response for an unknown or already-settled request', async () => {
    const { delegation, sent } = createHarness();
    const pending = delegation.requestPopup('boot-1', AUTHORIZE_URL);
    const requestId = lastRequestId(sent);
    delegation.handlePopupResponse('boot-1', requestId, 'https://first', undefined);
    // A duplicate/late reply must not overwrite the settled result.
    delegation.handlePopupResponse('boot-1', requestId, 'https://second', undefined);
    delegation.handlePopupResponse('boot-1', 'never-issued', 'https://third', undefined);
    await expect(pending).resolves.toEqual({ redirectUrl: 'https://first', error: undefined });
  });
});
