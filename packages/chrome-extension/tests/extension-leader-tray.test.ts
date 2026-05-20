import { describe, it, expect, vi } from 'vitest';
import { startExtensionLeaderTray } from '../src/extension-leader-tray.js';
import type { LeaderSyncManagerOptions } from '../../webapp/src/scoops/tray-leader-sync.js';

function makeMockBridge(opts: { coneJid?: string; messages?: Record<string, any[]> } = {}) {
  const messages = opts.messages ?? {};
  return {
    getConeJid: vi.fn(() => opts.coneJid ?? null),
    getActiveScoopJid: vi.fn(() => null),
    setActiveScoopJid: vi.fn(),
    getMessagesForJid: vi.fn((jid: string) => messages[jid] ?? []),
    routeSprinkleLick: vi.fn(),
    notifyPanelIncomingMessage: vi.fn(),
    onAgentEvent: vi.fn(() => () => {}),
    persistScoop: vi.fn(),
    getBuffer: vi.fn((jid: string) => messages[jid] ?? []),
  };
}

function makeMockOrchestrator(scoops: any[] = []) {
  return {
    getScoops: vi.fn(() => scoops),
    handleMessage: vi.fn().mockResolvedValue(undefined),
    handleWebhookEvent: vi.fn(),
    stopScoop: vi.fn(),
    createScoopTab: vi.fn(),
  };
}

function makeMockSharedFs(files: Record<string, string> = {}) {
  return {
    readFile: vi.fn(async (path: string) => {
      if (path in files) return files[path];
      throw new Error('not found');
    }),
  };
}

function makeStubBrowser() {
  return {
    listPages: vi.fn().mockResolvedValue([]),
    setTrayTargetProvider: vi.fn(),
    getTransport: vi.fn(() => undefined),
  } as any;
}

describe('startExtensionLeaderTray — read-only callbacks', () => {
  function startWithCapture(
    overrides: Partial<Parameters<typeof startExtensionLeaderTray>[0]> = {}
  ) {
    let capturedOptions!: LeaderSyncManagerOptions;
    const orchestrator =
      overrides.orchestrator ??
      makeMockOrchestrator([{ jid: 'cone-1', name: 'cone', isCone: true, folder: 'cone' }]);
    const bridge = overrides.bridge ?? makeMockBridge({ coneJid: 'cone-1' });
    const handle = startExtensionLeaderTray({
      workerBaseUrl: 'wss://test',
      bridge: bridge as any,
      orchestrator: orchestrator as any,
      sharedFs: overrides.sharedFs ?? (makeMockSharedFs() as any),
      browser: overrides.browser ?? makeStubBrowser(),
      log: console as any,
      leaderBridge:
        overrides.leaderBridge ??
        ({
          getSprinkles: () => [],
          resolveSprinklePath: () => null,
          signalLeaderMode: vi.fn(),
          detach: vi.fn(),
        } as any),
      _trayLeaderFactory: () =>
        ({
          start: vi.fn().mockResolvedValue({}),
          stop: vi.fn(),
          clearSession: vi.fn().mockResolvedValue(undefined),
          sendControlMessage: vi.fn(),
        }) as any,
      _peerManagerFactory: () =>
        ({
          stop: vi.fn(),
          getPeers: vi.fn(() => []),
          handleControlMessage: vi.fn().mockResolvedValue(undefined),
        }) as any,
      _onSyncOptions: (opts) => {
        capturedOptions = opts;
      },
      ...overrides,
    });
    return { handle, options: capturedOptions, orchestrator, bridge };
  }

  it('getMessages reads from bridge.getMessagesForJid(activeJid)', () => {
    const bridge = makeMockBridge({
      coneJid: 'cone-1',
      messages: { 'cone-1': [{ id: 'm1', role: 'user', content: 'hi' }] },
    });
    const { handle, options } = startWithCapture({ bridge: bridge as any });
    expect(options.getMessages()).toHaveLength(1);
    handle.stop();
  });

  it('getScoops projects orchestrator scoops to ScoopSummary shape', () => {
    const orchestrator = makeMockOrchestrator([
      {
        jid: 'c',
        name: 'cone',
        isCone: true,
        folder: 'cone',
        assistantLabel: 'sliccy',
        trigger: undefined,
      },
      {
        jid: 's',
        name: 'helper',
        isCone: false,
        folder: 'helper',
        assistantLabel: 'helper',
        trigger: undefined,
      },
    ]);
    const { handle, options } = startWithCapture({ orchestrator: orchestrator as any });
    expect(options.getScoops?.()).toEqual([
      {
        jid: 'c',
        name: 'cone',
        folder: 'cone',
        isCone: true,
        assistantLabel: 'sliccy',
        trigger: undefined,
      },
      {
        jid: 's',
        name: 'helper',
        folder: 'helper',
        isCone: false,
        assistantLabel: 'helper',
        trigger: undefined,
      },
    ]);
    handle.stop();
  });

  it('readSprinkleContent looks up path via leaderBridge.resolveSprinklePath then reads sharedFs', async () => {
    const leaderBridge = {
      getSprinkles: () => [
        { name: 'w', title: 'W', path: '/welcome.shtml', open: false, autoOpen: false },
      ],
      resolveSprinklePath: (name: string) => (name === 'w' ? '/welcome.shtml' : null),
      signalLeaderMode: vi.fn(),
      detach: vi.fn(),
    };
    const sharedFs = makeMockSharedFs({ '/welcome.shtml': '<p>hi</p>' });
    const { handle, options } = startWithCapture({
      leaderBridge: leaderBridge as any,
      sharedFs: sharedFs as any,
    });
    expect(await options.readSprinkleContent?.('w')).toBe('<p>hi</p>');
    expect(await options.readSprinkleContent?.('nope')).toBeNull();
    handle.stop();
  });
});

describe('startExtensionLeaderTray onFollowerMessage', () => {
  function startWithCapture(
    overrides: Partial<Parameters<typeof startExtensionLeaderTray>[0]> = {}
  ) {
    let capturedOptions!: LeaderSyncManagerOptions;
    const orchestrator =
      overrides.orchestrator ??
      makeMockOrchestrator([{ jid: 'cone-1', name: 'cone', isCone: true, folder: 'cone' }]);
    const bridge = overrides.bridge ?? makeMockBridge({ coneJid: 'cone-1' });
    const handle = startExtensionLeaderTray({
      workerBaseUrl: 'wss://test',
      bridge: bridge as any,
      orchestrator: orchestrator as any,
      sharedFs: overrides.sharedFs ?? (makeMockSharedFs() as any),
      browser: overrides.browser ?? makeStubBrowser(),
      log: console as any,
      leaderBridge:
        overrides.leaderBridge ??
        ({
          getSprinkles: () => [],
          resolveSprinklePath: () => null,
          signalLeaderMode: vi.fn(),
          detach: vi.fn(),
        } as any),
      _trayLeaderFactory: () =>
        ({
          start: vi.fn().mockResolvedValue({}),
          stop: vi.fn(),
          clearSession: vi.fn().mockResolvedValue(undefined),
          sendControlMessage: vi.fn(),
        }) as any,
      _peerManagerFactory: () =>
        ({
          stop: vi.fn(),
          getPeers: vi.fn(() => []),
          handleControlMessage: vi.fn().mockResolvedValue(undefined),
        }) as any,
      _onSyncOptions: (opts) => {
        capturedOptions = opts;
      },
      ...overrides,
    });
    return { handle, options: capturedOptions, orchestrator, bridge };
  }

  it('emits panel echo, persists, rebroadcasts synchronously', () => {
    const bridge = makeMockBridge({ coneJid: 'cone-1' });
    const { handle, options } = startWithCapture({ bridge: bridge as any });
    // Spy BEFORE invoking — otherwise the synchronous broadcast call
    // happens before the spy is installed and the assertion can't catch it.
    const broadcastSpy = vi.spyOn(handle.sync, 'broadcastUserMessage');
    options.onFollowerMessage('hi', 'm-99', undefined);
    expect(bridge.notifyPanelIncomingMessage).toHaveBeenCalledWith(
      'cone-1',
      expect.objectContaining({ id: 'm-99', channel: 'web' })
    );
    expect(bridge.persistScoop).toHaveBeenCalledWith('cone-1');
    expect(broadcastSpy).toHaveBeenCalledWith('hi', 'm-99', undefined);
    handle.stop();
  });

  it('orchestrator.handleMessage runs in fire-and-forget IIFE (no await)', async () => {
    const bridge = makeMockBridge({ coneJid: 'cone-1' });
    let dispatchResolve!: () => void;
    const orchestrator = makeMockOrchestrator([
      { jid: 'cone-1', name: 'cone', isCone: true, folder: 'cone' },
    ]);
    orchestrator.handleMessage = vi.fn(
      () =>
        new Promise<void>((res) => {
          dispatchResolve = res;
        })
    );
    const { handle, options } = startWithCapture({
      bridge: bridge as any,
      orchestrator: orchestrator as any,
    });
    // The callback returns undefined synchronously even though
    // handleMessage hasn't resolved.
    const returned = options.onFollowerMessage('hi', 'm-99', undefined);
    expect(returned).toBeUndefined();
    expect(orchestrator.handleMessage).toHaveBeenCalled();
    expect(orchestrator.createScoopTab).not.toHaveBeenCalled();
    dispatchResolve();
    await Promise.resolve();
    expect(orchestrator.createScoopTab).toHaveBeenCalledWith('cone-1');
    handle.stop();
  });

  it('no active scoop → no-op', () => {
    const bridge = makeMockBridge({ coneJid: null as any });
    const orchestrator = makeMockOrchestrator([]);
    const { handle, options } = startWithCapture({
      bridge: bridge as any,
      orchestrator: orchestrator as any,
    });
    options.onFollowerMessage('hi', 'm-99', undefined);
    expect(bridge.notifyPanelIncomingMessage).not.toHaveBeenCalled();
    expect(orchestrator.handleMessage).not.toHaveBeenCalled();
    handle.stop();
  });
});

describe('startExtensionLeaderTray peer connection', () => {
  function startWithCapture(
    overrides: Partial<Parameters<typeof startExtensionLeaderTray>[0]> = {}
  ) {
    const orchestrator =
      overrides.orchestrator ??
      makeMockOrchestrator([{ jid: 'cone-1', name: 'cone', isCone: true, folder: 'cone' }]);
    const bridge = overrides.bridge ?? makeMockBridge({ coneJid: 'cone-1' });
    const handle = startExtensionLeaderTray({
      workerBaseUrl: 'wss://test',
      bridge: bridge as any,
      orchestrator: orchestrator as any,
      sharedFs: overrides.sharedFs ?? (makeMockSharedFs() as any),
      browser: overrides.browser ?? makeStubBrowser(),
      log: console as any,
      leaderBridge:
        overrides.leaderBridge ??
        ({
          getSprinkles: () => [],
          resolveSprinklePath: () => null,
          signalLeaderMode: vi.fn(),
          detach: vi.fn(),
        } as any),
      _trayLeaderFactory: () =>
        ({
          start: vi.fn().mockResolvedValue({}),
          stop: vi.fn(),
          clearSession: vi.fn().mockResolvedValue(undefined),
          sendControlMessage: vi.fn(),
        }) as any,
      _peerManagerFactory: () =>
        ({
          stop: vi.fn(),
          getPeers: vi.fn(() => []),
          handleControlMessage: vi.fn().mockResolvedValue(undefined),
        }) as any,
      ...overrides,
    });
    return { handle, orchestrator, bridge };
  }

  it('peer connected → sync.addFollower called with bootstrapId, channel, runtime, connectedAt', () => {
    const peerFactoryFn = vi.fn(() => ({
      stop: vi.fn(),
      getPeers: vi.fn(() => []),
      handleControlMessage: vi.fn().mockResolvedValue(undefined),
    }));
    const { handle } = startWithCapture({
      _peerManagerFactory: peerFactoryFn as any,
    });
    const addFollowerSpy = vi.spyOn(handle.sync, 'addFollower').mockImplementation(() => {});
    // Grab the config the factory passed to the peer manager constructor.
    const capturedCfg = peerFactoryFn.mock.calls[0]![0] as any;
    const fakeChannel = { send: vi.fn(), readyState: 'open' } as any;
    capturedCfg.onPeerConnected(
      {
        bootstrapId: 'boot-1',
        controllerId: 'ctl-1',
        attempt: 1,
        runtime: 'slicc-standalone',
        connectedAt: '2026-05-20T00:00:00Z',
      },
      fakeChannel
    );
    expect(addFollowerSpy).toHaveBeenCalledWith('boot-1', fakeChannel, {
      runtime: 'slicc-standalone',
      connectedAt: '2026-05-20T00:00:00Z',
    });
    handle.stop();
  });

  it('peer connected without connectedAt → addFollower receives undefined', () => {
    const peerFactoryFn = vi.fn(() => ({
      stop: vi.fn(),
      getPeers: vi.fn(() => []),
      handleControlMessage: vi.fn().mockResolvedValue(undefined),
    }));
    const { handle } = startWithCapture({ _peerManagerFactory: peerFactoryFn as any });
    const addFollowerSpy = vi.spyOn(handle.sync, 'addFollower').mockImplementation(() => {});
    const capturedCfg = peerFactoryFn.mock.calls[0]![0] as any;
    capturedCfg.onPeerConnected(
      {
        bootstrapId: 'boot-2',
        controllerId: 'ctl-2',
        attempt: 1,
        runtime: 'slicc-extension-offscreen',
      },
      { send: vi.fn(), readyState: 'open' } as any
    );
    expect(addFollowerSpy).toHaveBeenCalledWith('boot-2', expect.any(Object), {
      runtime: 'slicc-extension-offscreen',
      connectedAt: undefined,
    });
    handle.stop();
  });
});

describe('startExtensionLeaderTray webhook routing', () => {
  function startWithCapture(
    overrides: Partial<Parameters<typeof startExtensionLeaderTray>[0]> = {}
  ) {
    const orchestrator =
      overrides.orchestrator ??
      makeMockOrchestrator([{ jid: 'cone-1', name: 'cone', isCone: true, folder: 'cone' }]);
    const bridge = overrides.bridge ?? makeMockBridge({ coneJid: 'cone-1' });
    const handle = startExtensionLeaderTray({
      workerBaseUrl: 'wss://test',
      bridge: bridge as any,
      orchestrator: orchestrator as any,
      sharedFs: overrides.sharedFs ?? (makeMockSharedFs() as any),
      browser: overrides.browser ?? makeStubBrowser(),
      log: console as any,
      leaderBridge:
        overrides.leaderBridge ??
        ({
          getSprinkles: () => [],
          resolveSprinklePath: () => null,
          signalLeaderMode: vi.fn(),
          detach: vi.fn(),
        } as any),
      _trayLeaderFactory:
        overrides._trayLeaderFactory ??
        ((() =>
          ({
            start: vi.fn().mockResolvedValue({}),
            stop: vi.fn(),
            clearSession: vi.fn().mockResolvedValue(undefined),
            sendControlMessage: vi.fn(),
          }) as any) as any),
      _peerManagerFactory:
        overrides._peerManagerFactory ??
        ((() =>
          ({
            stop: vi.fn(),
            getPeers: vi.fn(() => []),
            handleControlMessage: vi.fn().mockResolvedValue(undefined),
          }) as any) as any),
      ...overrides,
    });
    return { handle, orchestrator, bridge };
  }

  it('webhook.event control message routes to orchestrator.handleWebhookEvent', () => {
    const trayLeaderFactoryFn = vi.fn(() => ({
      start: vi.fn().mockResolvedValue({}),
      stop: vi.fn(),
      clearSession: vi.fn().mockResolvedValue(undefined),
      sendControlMessage: vi.fn(),
    }));
    const orchestrator = makeMockOrchestrator([
      { jid: 'cone-1', isCone: true, name: 'cone', folder: 'cone' },
    ]);
    const { handle } = startWithCapture({
      orchestrator: orchestrator as any,
      _trayLeaderFactory: trayLeaderFactoryFn as any,
    });
    const capturedCfg = trayLeaderFactoryFn.mock.calls[0]![0] as any;
    capturedCfg.onControlMessage({
      type: 'webhook.event',
      webhookId: 'wh-1',
      headers: { 'x-test': '1' },
      body: { ok: true },
    });
    expect(orchestrator.handleWebhookEvent).toHaveBeenCalledWith(
      'wh-1',
      { 'x-test': '1' },
      { ok: true }
    );
    handle.stop();
  });

  it('non-webhook control messages route to trayPeers.handleControlMessage', async () => {
    const trayLeaderFactoryFn = vi.fn(() => ({
      start: vi.fn().mockResolvedValue({}),
      stop: vi.fn(),
      clearSession: vi.fn().mockResolvedValue(undefined),
      sendControlMessage: vi.fn(),
    }));
    const peerHandleSpy = vi.fn().mockResolvedValue(undefined);
    const peerFactoryFn = vi.fn(() => ({
      stop: vi.fn(),
      getPeers: vi.fn(() => []),
      handleControlMessage: peerHandleSpy,
    }));
    const { handle, orchestrator } = startWithCapture({
      _trayLeaderFactory: trayLeaderFactoryFn as any,
      _peerManagerFactory: peerFactoryFn as any,
    });
    const trayCfg = trayLeaderFactoryFn.mock.calls[0]![0] as any;
    const offer = { type: 'webrtc.offer', bootstrapId: 'b1', sdp: 'sdp-payload' };
    trayCfg.onControlMessage(offer);
    expect(peerHandleSpy).toHaveBeenCalledWith(offer);
    expect(orchestrator.handleWebhookEvent).not.toHaveBeenCalled();
    handle.stop();
  });
});

describe('startExtensionLeaderTray agent-event tap', () => {
  function startWithCapture(
    overrides: Partial<Parameters<typeof startExtensionLeaderTray>[0]> = {}
  ) {
    const orchestrator =
      overrides.orchestrator ??
      makeMockOrchestrator([{ jid: 'cone-1', name: 'cone', isCone: true, folder: 'cone' }]);
    const bridge = overrides.bridge ?? makeMockBridge({ coneJid: 'cone-1' });
    const handle = startExtensionLeaderTray({
      workerBaseUrl: 'wss://test',
      bridge: bridge as any,
      orchestrator: orchestrator as any,
      sharedFs: overrides.sharedFs ?? (makeMockSharedFs() as any),
      browser: overrides.browser ?? makeStubBrowser(),
      log: console as any,
      leaderBridge:
        overrides.leaderBridge ??
        ({
          getSprinkles: () => [],
          resolveSprinklePath: () => null,
          signalLeaderMode: vi.fn(),
          detach: vi.fn(),
        } as any),
      _trayLeaderFactory: () =>
        ({
          start: vi.fn().mockResolvedValue({}),
          stop: vi.fn(),
          clearSession: vi.fn().mockResolvedValue(undefined),
          sendControlMessage: vi.fn(),
        }) as any,
      _peerManagerFactory: () =>
        ({
          stop: vi.fn(),
          getPeers: vi.fn(() => []),
          handleControlMessage: vi.fn().mockResolvedValue(undefined),
        }) as any,
      ...overrides,
    });
    return { handle, orchestrator, bridge };
  }

  it('agent event for active scoop forwards to sync.broadcastEvent', () => {
    const bridge = makeMockBridge({ coneJid: 'cone-1' });
    let agentHandler!: (scoopJid: string, event: any) => void;
    bridge.onAgentEvent.mockImplementation((h: any) => {
      agentHandler = h;
      return () => {};
    });
    const { handle } = startWithCapture({ bridge: bridge as any });
    const broadcastSpy = vi.spyOn(handle.sync, 'broadcastEvent').mockImplementation(() => {});
    agentHandler('cone-1', { type: 'content_delta', messageId: 'm', text: 'hi' });
    expect(broadcastSpy).toHaveBeenCalledWith({
      type: 'content_delta',
      messageId: 'm',
      text: 'hi',
    });
    handle.stop();
  });

  it('agent event for a background scoop is dropped', () => {
    const bridge = makeMockBridge({ coneJid: 'cone-1' });
    let agentHandler!: (scoopJid: string, event: any) => void;
    bridge.onAgentEvent.mockImplementation((h: any) => {
      agentHandler = h;
      return () => {};
    });
    const { handle } = startWithCapture({ bridge: bridge as any });
    const broadcastSpy = vi.spyOn(handle.sync, 'broadcastEvent').mockImplementation(() => {});
    agentHandler('scoop-other', { type: 'content_delta', messageId: 'm', text: 'hi' });
    expect(broadcastSpy).not.toHaveBeenCalled();
    handle.stop();
  });

  it('teardown unsubscribes the tap', () => {
    const bridge = makeMockBridge({ coneJid: 'cone-1' });
    const unsubAgent = vi.fn();
    bridge.onAgentEvent.mockImplementation(() => unsubAgent);
    const { handle } = startWithCapture({ bridge: bridge as any });
    handle.stop();
    expect(unsubAgent).toHaveBeenCalled();
  });
});
