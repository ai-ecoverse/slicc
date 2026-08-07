/**
 * Routing policy for a delegated OAuth login (#1915): WHERE the interactive
 * hop runs, and — the part that matters most — that a leader with no human of
 * its own never quietly falls back to prompting itself.
 */

import { describe, expect, it, vi } from 'vitest';
import type { LeaderSyncManagerOptions } from '../../src/scoops/tray-leader-sync.js';
import { LeaderSyncManager } from '../../src/scoops/tray-leader-sync.js';
import type { TrayDataChannelLike } from '../../src/scoops/tray-webrtc.js';

class FakeChannel implements TrayDataChannelLike {
  readyState: 'open' | 'closed' = 'open';
  readonly sent: string[] = [];
  private handler: ((event: { data: string }) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 'closed';
  }
  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    if (type === 'message') this.handler = listener;
  }
  removeEventListener(): void {
    this.handler = null;
  }
  simulate(message: unknown): void {
    this.handler?.({ data: JSON.stringify(message) });
  }
}

function createManager(overrides: Partial<LeaderSyncManagerOptions> = {}) {
  return new LeaderSyncManager({
    getMessages: () => [],
    getScoopJid: () => 'cone',
    onFollowerMessage: vi.fn(),
    onFollowerAbort: vi.fn(),
    sendControl: vi.fn(),
    ...overrides,
  } as LeaderSyncManagerOptions);
}

/** Join a follower and let it advertise whether it can host a popup. */
function addFollower(
  manager: LeaderSyncManager,
  bootstrapId: string,
  opts: { oauthPopup: boolean }
): FakeChannel {
  const channel = new FakeChannel();
  manager.addFollower(bootstrapId, channel, { runtime: 'slicc-standalone' });
  channel.simulate({
    type: 'hello',
    protocolVersion: 6,
    runtime: 'slicc-standalone',
    capabilities: { browser: true, ...(opts.oauthPopup ? { oauthPopup: true } : {}) },
  });
  return channel;
}

describe('delegated OAuth routing', () => {
  it('does not delegate when the leader has its own human and sent the last message', () => {
    const manager = createManager();
    addFollower(manager, 'b1', { oauthPopup: true });
    manager.noteLeaderUserMessage();

    expect(manager.shouldDelegateOAuthLogin()).toBe(false);
  });

  it('delegates when the last user message came from a follower', () => {
    const manager = createManager();
    const channel = addFollower(manager, 'b1', { oauthPopup: true });
    channel.simulate({ type: 'user_message', text: 'log into github', messageId: 'm1' });

    expect(manager.shouldDelegateOAuthLogin()).toBe(true);
  });

  it('never prompts locally on a headless leader, even with no capable follower', async () => {
    // The #1915 failure mode: a hosted/cloud leader has no human, so falling
    // back to its own popup puts the login in a sandbox nobody is watching.
    // It must delegate — and, finding nowhere to delegate to, fail fast.
    const manager = createManager({ headlessLeader: true });
    expect(manager.hasDelegatableFollower()).toBe(false);
    expect(manager.shouldDelegateOAuthLogin()).toBe(true);

    await expect(
      manager.delegateOAuthLogin('https://github.com/login/oauth/authorize')
    ).resolves.toEqual({
      redirectUrl: null,
      error: 'no connected follower can show an interactive login',
    });
  });

  it('a leader WITH a human still declines to delegate when nowhere can host it', () => {
    const manager = createManager();
    // An exec-only follower: connected, but it never claims oauthPopup.
    addFollower(manager, 'b1', { oauthPopup: false });
    manager.noteLeaderUserMessage();

    expect(manager.hasDelegatableFollower()).toBe(false);
    expect(manager.shouldDelegateOAuthLogin()).toBe(false);
  });

  it('drives a CDP-capable follower rather than asking it for a popup', async () => {
    // The driven path needs no user activation, is immune to COOP severing
    // window.opener, and needs no shared origin — so it wins whenever the
    // follower can actually be driven.
    const browserAPI = {
      createRemotePage: vi.fn(async () => 'tab-1'),
      attachToPage: vi.fn(async () => {}),
      sendCDP: vi.fn(async () => ({})),
      evaluate: vi.fn(async () => 'https://www.sliccy.ai/auth/callback?code=driven'),
      closePage: vi.fn(async () => {}),
      getTransport: vi.fn(() => ({ on: vi.fn(), off: vi.fn() })),
      // Mirrors the real `BrowserAPI.withTab` (attach, then run): the login
      // driver holds this tab for minutes and polls it, so every attach is
      // serialized rather than swapping the shared client's session directly.
      withTab: vi.fn(async (_targetId: string, fn: (sessionId: string) => Promise<unknown>) => {
        await browserAPI.attachToPage();
        return await fn('session-1');
      }),
    };
    const manager = createManager({ browserAPI: browserAPI as never });
    const channel = addFollower(manager, 'b1', { oauthPopup: true });
    channel.simulate({ type: 'user_message', text: 'log in', messageId: 'm1' });
    // Advertising a network-capable target is what makes it driveable.
    channel.simulate({
      type: 'targets.advertise',
      runtimeId: 'runtime-1',
      targets: [
        {
          targetId: 'tab0',
          title: 'Tab',
          url: 'https://example.com',
          kind: 'browser',
          capabilities: { navigate: true, network: true, screenshot: true },
        },
      ],
    });

    const authorize =
      'https://github.com/login/oauth/authorize?client_id=abc&redirect_uri=' +
      encodeURIComponent('https://www.sliccy.ai/auth/callback');
    await expect(manager.delegateOAuthLogin(authorize)).resolves.toEqual({
      redirectUrl: 'https://www.sliccy.ai/auth/callback?code=driven',
    });
    expect(browserAPI.createRemotePage).toHaveBeenCalledWith('runtime-1', authorize);
    // No popup request went out on the wire.
    expect(channel.sent.map((raw) => JSON.parse(raw) as { type: string })).not.toContainEqual(
      expect.objectContaining({ type: 'oauth.popup.request' })
    );
  });

  it('falls back to the popup for a follower that cannot be driven', () => {
    // A plain browser tab at a join URL has no CDP surface of its own.
    const manager = createManager();
    const channel = addFollower(manager, 'b1', { oauthPopup: true });
    channel.simulate({ type: 'user_message', text: 'log in', messageId: 'm1' });

    void manager.delegateOAuthLogin('https://github.com/login/oauth/authorize?client_id=abc');
    expect(channel.sent.map((raw) => JSON.parse(raw) as { type: string })).toContainEqual(
      expect.objectContaining({ type: 'oauth.popup.request' })
    );
  });

  it('routes to the follower whose human sent the most recent message', () => {
    const manager = createManager();
    const first = addFollower(manager, 'b1', { oauthPopup: true });
    const second = addFollower(manager, 'b2', { oauthPopup: true });

    first.simulate({ type: 'user_message', text: 'hi', messageId: 'm1' });
    second.simulate({ type: 'user_message', text: 'log into github', messageId: 'm2' });

    void manager.delegateOAuthLogin('https://github.com/login/oauth/authorize');
    const request = second.sent
      .map((raw) => JSON.parse(raw) as { type: string })
      .find((message) => message.type === 'oauth.popup.request');
    expect(request).toBeDefined();
    expect(first.sent.map((raw) => JSON.parse(raw) as { type: string })).not.toContainEqual(
      expect.objectContaining({ type: 'oauth.popup.request' })
    );
  });
});
