import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/base/logger.js';
import type { LeaderSyncContext } from '../../../src/scoops/tray-leader/context.js';
import {
  FollowerDispatch,
  type FollowerDispatchCollaborators,
} from '../../../src/scoops/tray-leader/follower-dispatch.js';
import {
  type ConnectedFollower,
  FollowerRegistry,
} from '../../../src/scoops/tray-leader/follower-registry.js';
import type { LeaderSyncManagerOptions } from '../../../src/scoops/tray-leader-sync.js';
import type { FollowerToLeaderMessage } from '../../../src/scoops/tray-sync-protocol.js';

function createCollaborators(): FollowerDispatchCollaborators {
  return {
    broadcast: {
      sendSnapshotToFollower: vi.fn(async () => {}),
      sendModelCatalogToFollower: vi.fn(),
      broadcastModelState: vi.fn(),
      sendSprinklesListToFollower: vi.fn(),
      handleSprinkleFetch: vi.fn(async () => {}),
    },
    cdpRouter: {
      handleCDPRequest: vi.fn(),
      handleCDPResponse: vi.fn(),
      handleCDPEvent: vi.fn(),
    },
    remoteExec: { handleFollowerExecMessage: vi.fn() },
    fsRouter: {
      executeLocalFs: vi.fn(async () => {}),
      forwardFsRequest: vi.fn(),
      handleFsResponse: vi.fn(),
    },
    tabRouter: {
      executeLocalTabOpen: vi.fn(async () => {}),
      forwardTabOpen: vi.fn(),
      handleTabOpenResponse: vi.fn(),
      handleTabOpenError: vi.fn(),
    },
    teleportPool: { handleFollowerTargetsAdvertise: vi.fn() },
    transcriptExport: {
      handleTranscriptExportRequest: vi.fn(async () => {}),
      handleTranscriptExportCancel: vi.fn(),
      handleTranscriptExportAck: vi.fn(),
    },
    sudoDelegation: { handleResponse: vi.fn(), handleFollowerReady: vi.fn() },
    cherryRouter: { routeCherryHostEvent: vi.fn() },
    requesterTracker: { noteFollowerUserMessage: vi.fn() },
    tabTeleportRouter: { handleTeleportRequest: vi.fn(async () => {}) },
    oauthPopupDelegation: { handlePopupResponse: vi.fn() },
  };
}

function createHarness(overrides: Partial<LeaderSyncManagerOptions> = {}) {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as Logger;
  const options = {
    getMessages: () => [],
    getScoopJid: () => 'cone',
    onFollowerMessage: vi.fn(),
    onFollowerAbort: vi.fn(),
    onFollowerNewSession: vi.fn(),
    onSprinkleLick: vi.fn(),
    onForwardedLick: vi.fn(),
    onFollowerCountChanged: vi.fn(),
    sendControl: vi.fn(),
    ...overrides,
  } satisfies LeaderSyncManagerOptions;
  const followers = new FollowerRegistry({
    log,
    onMessage: vi.fn(),
    onFollowerCountChanged: options.onFollowerCountChanged,
  });
  const keepalive = { receivePing: vi.fn(), receivePong: vi.fn() };
  const send = vi.fn();
  followers.followers.set('follower', {
    bootstrapId: 'follower',
    floatType: 'extension',
    runtime: 'slicc-extension',
    lastActivity: 1,
    keepalive,
    sync: { send },
  } as unknown as ConnectedFollower);
  const context: LeaderSyncContext = {
    options,
    followers,
    log,
    sendControl: options.sendControl,
  };
  const collaborators = createCollaborators();
  return {
    collaborators,
    dispatch: new FollowerDispatch(context, collaborators),
    followers,
    keepalive,
    log,
    options,
    send,
  };
}

describe('FollowerDispatch', () => {
  it('waits for an asynchronous thinking update before broadcasting model state', async () => {
    let cachedThinkingLevel = 'off';
    let finishApply!: () => void;
    const onFollowerThinkingSet = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishApply = () => {
            cachedThinkingLevel = 'xhigh';
            resolve();
          };
        })
    );
    const { collaborators: c, dispatch, followers } = createHarness({ onFollowerThinkingSet });
    const follower = followers.followers.get('follower');
    if (!follower) throw new Error('missing follower');
    follower.selectedScoopJid = 'cone';
    const broadcastLevels: string[] = [];
    vi.mocked(c.broadcast.broadcastModelState).mockImplementation(() => {
      broadcastLevels.push(cachedThinkingLevel);
    });

    dispatch.dispatch('follower', {
      type: 'thinking.set',
      scoopJid: 'cone',
      thinkingLevel: 'xhigh',
      effortOverride: 'max',
    });

    expect(c.broadcast.broadcastModelState).not.toHaveBeenCalled();
    finishApply();
    await vi.waitFor(() => expect(broadcastLevels).toEqual(['xhigh']));
  });

  it('does not broadcast when an asynchronous thinking update is not acknowledged', async () => {
    const onFollowerThinkingSet = vi.fn(async () => false);
    const {
      collaborators: c,
      dispatch,
      followers,
      log,
    } = createHarness({
      onFollowerThinkingSet,
    });
    const follower = followers.followers.get('follower');
    if (!follower) throw new Error('missing follower');
    follower.selectedScoopJid = 'cone';

    dispatch.dispatch('follower', {
      type: 'thinking.set',
      scoopJid: 'cone',
      thinkingLevel: 'xhigh',
      effortOverride: 'max',
    });

    await vi.waitFor(() =>
      expect(log.warn).toHaveBeenCalledWith(
        'Follower thinking selection apply failed',
        expect.objectContaining({ scoopJid: 'cone' })
      )
    );
    expect(c.broadcast.broadcastModelState).not.toHaveBeenCalled();
  });

  it('dispatches model catalog, model selection, and max-effort thinking messages', () => {
    const onFollowerModelSelect = vi.fn(() => true);
    const onFollowerThinkingSet = vi.fn();
    const {
      collaborators: c,
      dispatch,
      followers,
    } = createHarness({
      onFollowerModelSelect,
      onFollowerThinkingSet,
    });
    const follower = followers.followers.get('follower');
    if (!follower) throw new Error('missing follower');
    follower.selectedScoopJid = 'selected-scoop';

    dispatch.dispatch('follower', { type: 'models.request' });
    expect(c.broadcast.sendModelCatalogToFollower).toHaveBeenCalledWith('follower');

    dispatch.dispatch('follower', { type: 'model.select', modelId: 'adobe:claude-opus-4-8' });
    expect(onFollowerModelSelect).toHaveBeenCalledWith('adobe:claude-opus-4-8');

    dispatch.dispatch('follower', {
      type: 'thinking.set',
      scoopJid: 'stale-scoop',
      thinkingLevel: 'xhigh',
      effortOverride: 'max',
    });
    expect(onFollowerThinkingSet).toHaveBeenCalledWith('selected-scoop', 'xhigh', 'max');
    expect(c.broadcast.broadcastModelState).toHaveBeenCalledTimes(2);
  });

  it('rejects an invalid model id without throwing or broadcasting state', () => {
    const onFollowerModelSelect = vi.fn(() => false);
    const { collaborators: c, dispatch, log } = createHarness({ onFollowerModelSelect });

    expect(() =>
      dispatch.dispatch('follower', { type: 'model.select', modelId: 'unknown:nope' })
    ).not.toThrow();

    expect(onFollowerModelSelect).toHaveBeenCalledWith('unknown:nope');
    expect(c.broadcast.broadcastModelState).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'Rejecting unknown or unresolvable follower model selection',
      expect.objectContaining({ modelId: 'unknown:nope' })
    );
  });

  it('routes every collaborator-owned message variant', () => {
    const { collaborators: c, dispatch } = createHarness();
    const route = (message: FollowerToLeaderMessage, spy: unknown, ...args: unknown[]) => {
      dispatch.dispatch('follower', message);
      expect(spy).toHaveBeenCalledWith(...args);
    };

    const snapshot = { type: 'request_snapshot', scoopJid: 'scoop' } as const;
    route(snapshot, c.broadcast.sendSnapshotToFollower, 'follower', 'scoop');
    route({ type: 'sprinkles.refresh' }, c.broadcast.sendSprinklesListToFollower, 'follower');
    route(
      { type: 'sprinkle.fetch', requestId: 'fetch', sprinkleName: 'status' },
      c.broadcast.handleSprinkleFetch,
      'follower',
      'fetch',
      'status'
    );
    const targets: FollowerToLeaderMessage = {
      type: 'targets.advertise',
      runtimeId: 'remote',
      targets: [],
    };
    route(targets, c.teleportPool.handleFollowerTargetsAdvertise, 'follower', targets);
    const cdpRequest = {
      type: 'cdp.request',
      requestId: 'cdp',
      targetRuntimeId: 'remote',
      localTargetId: 'tab',
      method: 'Page.enable',
    } as const;
    route(cdpRequest, c.cdpRouter.handleCDPRequest, 'follower', cdpRequest);
    const cdpResponse = { type: 'cdp.response', requestId: 'cdp', result: {} } as const;
    route(cdpResponse, c.cdpRouter.handleCDPResponse, cdpResponse);
    route(
      { type: 'cdp.event', method: 'Page.loadEventFired', params: {}, sessionId: 'session' },
      c.cdpRouter.handleCDPEvent,
      'follower',
      'Page.loadEventFired',
      {},
      'session'
    );
    route(
      { type: 'tab.open', requestId: 'tab', targetRuntimeId: 'remote', url: 'https://x' },
      c.tabRouter.forwardTabOpen,
      'tab',
      'remote',
      'https://x',
      'follower'
    );
    route(
      { type: 'tab.opened', requestId: 'tab', targetId: 'remote:tab' },
      c.tabRouter.handleTabOpenResponse,
      'tab',
      'remote:tab'
    );
    route(
      { type: 'tab.open.error', requestId: 'tab', error: 'failed' },
      c.tabRouter.handleTabOpenError,
      'tab',
      'failed'
    );
    const request = { op: 'stat', path: '/tmp' } as const;
    route(
      { type: 'fs.request', requestId: 'fs', targetRuntimeId: 'remote', request },
      c.fsRouter.forwardFsRequest,
      'fs',
      'remote',
      request,
      'follower'
    );
    route(
      { type: 'fs.response', requestId: 'fs', response: { ok: false, error: 'failed' } },
      c.fsRouter.handleFsResponse,
      'fs',
      { ok: false, error: 'failed' }
    );

    const execMessages: FollowerToLeaderMessage[] = [
      { type: 'exec.request', requestId: 'exec', command: 'pwd' },
      { type: 'exec.chunk', requestId: 'exec', stream: 'stdout', data: 'eA==' },
      { type: 'exec.response', requestId: 'exec', exitCode: 0 },
      { type: 'exec.signal', requestId: 'exec', signal: 'SIGINT' },
    ];
    for (const message of execMessages) {
      route(message, c.remoteExec.handleFollowerExecMessage, 'follower', message);
    }
    route(
      { type: 'transcript.export.request', requestId: 'export', selector: { kind: 'active' } },
      c.transcriptExport.handleTranscriptExportRequest,
      'follower',
      'export',
      { kind: 'active' }
    );
    route(
      { type: 'transcript.export.cancel', requestId: 'export' },
      c.transcriptExport.handleTranscriptExportCancel,
      'follower',
      'export'
    );
    route(
      { type: 'transcript.export.ack', requestId: 'export', index: 2 },
      c.transcriptExport.handleTranscriptExportAck,
      'follower',
      'export',
      2
    );
    route(
      {
        type: 'sudo.approve.response',
        requestId: 'sudo-1',
        decision: 'always',
        pattern: 'git push *',
        attestation: 'biometric',
      },
      c.sudoDelegation.handleResponse,
      'follower',
      'sudo-1',
      'always',
      'git push *',
      'biometric'
    );
    const cherry = {
      type: 'cherry.host_event',
      targetId: 'remote:host',
      name: 'updated',
    } as const;
    route(cherry, c.cherryRouter.routeCherryHostEvent, 'follower', cherry);
  });

  it('routes leader-local tab and fs requests', () => {
    const { collaborators: c, dispatch } = createHarness();
    dispatch.dispatch('follower', {
      type: 'tab.open',
      requestId: 'tab',
      targetRuntimeId: 'leader',
      url: 'https://x',
    });
    expect(c.tabRouter.executeLocalTabOpen).toHaveBeenCalledWith('tab', 'https://x', 'follower');

    const request = { op: 'stat', path: '/tmp' } as const;
    dispatch.dispatch('follower', {
      type: 'fs.request',
      requestId: 'fs',
      targetRuntimeId: 'leader',
      request,
    });
    expect(c.fsRouter.executeLocalFs).toHaveBeenCalledWith('fs', request, 'follower');
  });

  it('handles direct control and lifecycle variants without changing semantics', () => {
    const { collaborators: c, dispatch, followers, keepalive, options, send } = createHarness();
    dispatch.dispatch('follower', {
      type: 'hello',
      protocolVersion: 3,
      capabilities: { exec: true },
    });
    expect(followers.followers.get('follower')?.peerCapabilities).toEqual({ exec: true });
    expect(options.onFollowerCountChanged).toHaveBeenCalledWith(1);

    const activityBefore = followers.followers.get('follower')?.lastActivity ?? 0;
    dispatch.dispatch('follower', { type: 'user_message', text: 'hi', messageId: 'message' });
    expect(options.onFollowerMessage).toHaveBeenCalledWith('hi', 'message', undefined);
    // A user message is real human activity: it must bump lastActivity (the
    // fixture seeds it at 1) and record this follower as the requester origin.
    expect(followers.followers.get('follower')?.lastActivity ?? 0).toBeGreaterThan(activityBefore);
    expect(c.requesterTracker.noteFollowerUserMessage).toHaveBeenCalledWith('follower', undefined);
    dispatch.dispatch('follower', { type: 'abort' });
    expect(options.onFollowerAbort).toHaveBeenCalledOnce();
    dispatch.dispatch('follower', { type: 'new_session', action: 'save' });
    expect(options.onFollowerNewSession).toHaveBeenCalledWith('save', 'follower');

    dispatch.dispatch('follower', { type: 'scoops.select', scoopJid: 'scoop' });
    expect(followers.followers.get('follower')?.selectedScoopJid).toBe('scoop');
    expect(c.broadcast.sendSnapshotToFollower).toHaveBeenCalledWith('follower', 'scoop');
    dispatch.dispatch('follower', {
      type: 'sprinkle.lick',
      sprinkleName: 'status',
      body: { action: 'refresh' },
    });
    expect(options.onSprinkleLick).toHaveBeenCalledWith(
      'status',
      { action: 'refresh' },
      undefined,
      'extension follower'
    );
    dispatch.dispatch('follower', {
      type: 'lick',
      event: {
        type: 'navigate',
        timestamp: 'now',
        navigateUrl: 'https://x',
        targetScoop: 'dropped',
        body: {},
      },
    });
    expect(options.onForwardedLick).toHaveBeenCalledWith(
      expect.objectContaining({
        originFollowerId: 'follower',
        originLabel: 'extension follower',
      }),
      'follower'
    );
    const forwardedLick = options.onForwardedLick as ReturnType<typeof vi.fn>;
    expect(forwardedLick.mock.calls[0][0].targetScoop).toBeUndefined();

    dispatch.dispatch('follower', { type: 'ping' });
    expect(keepalive.receivePing).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({ type: 'pong' });
    dispatch.dispatch('follower', { type: 'pong' });
    expect(keepalive.receivePong).toHaveBeenCalledOnce();
  });
});
