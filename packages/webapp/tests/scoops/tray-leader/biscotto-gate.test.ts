import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/base/logger.js';
import {
  BISCOTTO_ALLOWED,
  isMessageAllowedForTrust,
} from '../../../src/scoops/tray-leader/biscotto-gate.js';
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

/**
 * The exact set a guest seat may send. Spelled out as a literal rather than
 * derived from the table under test: a test that recomputed the allowlist from
 * the same source it is checking would pass no matter what got added to it.
 */
const EXPECTED_ALLOWED = ['hello', 'ping', 'pong', 'request_snapshot', 'user_message'];

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

function createHarness(trust: 'full' | 'biscotto') {
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
  } satisfies LeaderSyncManagerOptions;
  const followers = new FollowerRegistry({
    log,
    onMessage: vi.fn(),
    onFollowerCountChanged: options.onFollowerCountChanged,
  });
  followers.followers.set('peer', {
    bootstrapId: 'peer',
    floatType: 'standalone',
    runtime: 'slicc-standalone',
    lastActivity: 1,
    trust,
    biscotto: trust === 'biscotto' ? { id: 'seat1', label: 'Anna', gates: undefined } : undefined,
    keepalive: { receivePing: vi.fn(), receivePong: vi.fn() },
    sync: { send: vi.fn() },
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
    log,
    options,
  };
}

describe('BISCOTTO_ALLOWED', () => {
  it('permits exactly the guest-seat message set', () => {
    const allowed = Object.entries(BISCOTTO_ALLOWED)
      .filter(([, ok]) => ok)
      .map(([type]) => type)
      .sort();
    expect(allowed).toEqual(EXPECTED_ALLOWED);
  });

  it('denies every follower power that could escalate a guest', () => {
    // Spot-check the classes named in the module doc. The Record's totality is
    // enforced by the compiler; this pins the *decisions* so loosening one is a
    // deliberate, visible edit.
    for (const type of [
      'cdp.request',
      'fs.request',
      'exec.request',
      'tab.teleport.request',
      'sudo.approve.response',
      'transcript.export.request',
      'push.register',
      'sprinkle.lick',
      'lick',
      'cherry.host_event',
      'abort',
      'new_session',
      'scoops.select',
      'model.select',
    ] satisfies FollowerToLeaderMessage['type'][]) {
      expect(isMessageAllowedForTrust('biscotto', type)).toBe(false);
    }
  });

  it('leaves a full-trust follower unrestricted', () => {
    for (const type of Object.keys(BISCOTTO_ALLOWED) as FollowerToLeaderMessage['type'][]) {
      expect(isMessageAllowedForTrust('full', type)).toBe(true);
    }
  });

  it('denies a forged type that is not in the table', () => {
    expect(
      isMessageAllowedForTrust('biscotto', 'totally.made.up' as FollowerToLeaderMessage['type'])
    ).toBe(false);
  });
});

describe('FollowerDispatch biscotto boundary', () => {
  it('drops a denied message before it reaches any router', () => {
    const { collaborators: c, dispatch } = createHarness('biscotto');

    dispatch.dispatch('peer', {
      type: 'cdp.request',
      requestId: 'r1',
      targetRuntimeId: 'runtime-1',
      localTargetId: 'target-1',
      method: 'Page.navigate',
    });
    dispatch.dispatch('peer', { type: 'abort' });
    dispatch.dispatch('peer', {
      type: 'fs.request',
      requestId: 'r2',
      targetRuntimeId: 'runtime-1',
      request: { op: 'readFile', path: '/workspace/secrets.env' },
    });

    expect(c.cdpRouter.handleCDPRequest).not.toHaveBeenCalled();
    expect(c.fsRouter.forwardFsRequest).not.toHaveBeenCalled();
    expect(c.fsRouter.executeLocalFs).not.toHaveBeenCalled();
  });

  it('does not abort the owner turn when a guest asks it to', () => {
    const { dispatch, options } = createHarness('biscotto');
    dispatch.dispatch('peer', { type: 'abort' });
    expect(options.onFollowerAbort).not.toHaveBeenCalled();
  });

  it('still delivers a guest user message', () => {
    const { dispatch, options } = createHarness('biscotto');
    dispatch.dispatch('peer', { type: 'user_message', text: 'hi', messageId: 'm1' });
    expect(options.onFollowerMessage).toHaveBeenCalledWith('hi', 'm1', undefined);
  });

  it('lets a full-trust follower keep the surface a guest is denied', () => {
    const { collaborators: c, dispatch, options } = createHarness('full');
    dispatch.dispatch('peer', { type: 'abort' });
    dispatch.dispatch('peer', {
      type: 'cdp.request',
      requestId: 'r1',
      targetRuntimeId: 'runtime-1',
      localTargetId: 'target-1',
      method: 'Page.navigate',
    });
    expect(options.onFollowerAbort).toHaveBeenCalledTimes(1);
    expect(c.cdpRouter.handleCDPRequest).toHaveBeenCalledTimes(1);
  });

  it('drops a message from a peer with no registry entry', () => {
    const { collaborators: c, dispatch } = createHarness('full');
    dispatch.dispatch('ghost', { type: 'user_message', text: 'hi', messageId: 'm1' });
    expect(c.requesterTracker.noteFollowerUserMessage).not.toHaveBeenCalled();
  });

  it('clamps a guest hello: version kept, capabilities discarded', () => {
    const { collaborators: c, dispatch, followers } = createHarness('biscotto');

    dispatch.dispatch('peer', {
      type: 'hello',
      protocolVersion: 7,
      capabilities: { sudoApproval: true, biometric: true, exec: true, browser: true },
      motd: 'i am definitely a real follower',
    } as FollowerToLeaderMessage);

    const follower = followers.followers.get('peer');
    expect(follower?.peerProtocolVersion).toBe(7);
    // A guest that could advertise these would be handed the owner's sudo
    // prompts, teleport targets and exec requests.
    expect(follower?.peerCapabilities).toEqual({});
    expect(follower?.peerMotd).toBeUndefined();
    expect(c.sudoDelegation.handleFollowerReady).not.toHaveBeenCalled();
  });

  it('keeps a full follower hello intact', () => {
    const { collaborators: c, dispatch, followers } = createHarness('full');

    dispatch.dispatch('peer', {
      type: 'hello',
      protocolVersion: 7,
      capabilities: { sudoApproval: true, biometric: true },
      motd: 'iphone',
    } as FollowerToLeaderMessage);

    const follower = followers.followers.get('peer');
    expect(follower?.peerCapabilities).toEqual({ sudoApproval: true, biometric: true });
    expect(follower?.peerMotd).toBe('iphone');
    expect(c.sudoDelegation.handleFollowerReady).toHaveBeenCalledWith('peer');
  });
});
