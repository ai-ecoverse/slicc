import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeaderSyncManagerOptions } from '../../webapp/src/scoops/tray-leader-sync.js';
import { startExtensionLeaderTray } from '../src/extension-leader-tray.js';

const messageListeners: Array<
  (message: unknown, sender: unknown, sendResponse: (r?: unknown) => void) => void
> = [];
const sentMessages: unknown[] = [];
const mockChrome = {
  runtime: {
    id: 'test-extension-id',
    lastError: undefined as unknown,
    sendMessage: vi.fn(async (msg: unknown) => {
      sentMessages.push(msg);
    }),
    onMessage: {
      addListener: vi.fn((cb: any) => {
        messageListeners.push(cb);
      }),
      removeListener: vi.fn((cb: any) => {
        const idx = messageListeners.indexOf(cb);
        if (idx >= 0) messageListeners.splice(idx, 1);
      }),
    },
  },
};
(globalThis as any).chrome = mockChrome;

beforeEach(() => {
  messageListeners.length = 0;
  sentMessages.length = 0;
  mockChrome.runtime.sendMessage.mockClear();
  mockChrome.runtime.onMessage.addListener.mockClear();
  mockChrome.runtime.onMessage.removeListener.mockClear();
});

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
      lickManager: overrides.lickManager ?? ({ emitEvent: vi.fn() } as any),
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

  it('readSprinkleContent silently returns null on ENOENT (file deleted between snapshot and read)', async () => {
    // ENOENT is the expected race: the leader broadcasts a sprinkles
    // snapshot, a follower asks for the content, the file gets deleted
    // in between. That's not an error worth logging — it's normal
    // concurrent edits. Anything ELSE (disk full, permission denied,
    // etc.) IS an error and must surface.
    const leaderBridge = {
      getSprinkles: () => [
        { name: 'w', title: 'W', path: '/welcome.shtml', open: false, autoOpen: false },
      ],
      resolveSprinklePath: (_name: string) => '/welcome.shtml',
      signalLeaderMode: vi.fn(),
      detach: vi.fn(),
    };
    const sharedFs = {
      readFile: vi.fn(async () => {
        const err = new Error('not found') as Error & { code?: string };
        err.code = 'ENOENT';
        throw err;
      }),
    };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const { handle, options } = startWithCapture({
      leaderBridge: leaderBridge as any,
      sharedFs: sharedFs as any,
      log: log as any,
    });
    expect(await options.readSprinkleContent?.('w')).toBeNull();
    // ENOENT must NOT trip the error log — it's expected.
    expect(log.error).not.toHaveBeenCalled();
    handle.stop();
  });

  it('readSprinkleContent logs at error level on non-ENOENT failures (e.g. disk full)', async () => {
    const leaderBridge = {
      getSprinkles: () => [
        { name: 'w', title: 'W', path: '/welcome.shtml', open: false, autoOpen: false },
      ],
      resolveSprinklePath: (_name: string) => '/welcome.shtml',
      signalLeaderMode: vi.fn(),
      detach: vi.fn(),
    };
    const sharedFs = {
      readFile: vi.fn(async () => {
        throw new Error('disk full');
      }),
    };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const { handle, options } = startWithCapture({
      leaderBridge: leaderBridge as any,
      sharedFs: sharedFs as any,
      log: log as any,
    });
    expect(await options.readSprinkleContent?.('w')).toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      'readSprinkleContent failed',
      expect.objectContaining({ name: 'w', error: 'disk full' })
    );
    handle.stop();
  });

  it('onForwardedLick emits the event into the provided lickManager', () => {
    const emitEvent = vi.fn();
    const { options } = startWithCapture({ lickManager: { emitEvent } as any });
    const event = {
      type: 'navigate',
      navigateUrl: 'https://x',
      timestamp: 't',
      body: {},
      originFollowerId: 'b1',
      originLabel: 'standalone follower',
    };
    options.onForwardedLick!(event as any, 'b1');
    expect(emitEvent).toHaveBeenCalledWith(event);
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
      lickManager: overrides.lickManager ?? ({ emitEvent: vi.fn() } as any),
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
    // Pass a stable buffer through the messages map so getBuffer('cone-1')
    // returns the same array on every call — needed to inspect what the
    // BufferLike.push payload actually looks like.
    const coneBuffer: any[] = [];
    const bridge = makeMockBridge({ coneJid: 'cone-1', messages: { 'cone-1': coneBuffer } });
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

    // The push payload shape must match BufferLike — single source of truth
    // at the leader-factory boundary. Regression guard: if the shape drifts
    // (e.g., a field gets dropped or renamed), the panel-side chat persistence
    // breaks silently.
    expect(bridge.getBuffer).toHaveBeenCalledWith('cone-1');
    const pushedEntry = coneBuffer.find((m: any) => m.id === 'm-99');
    expect(pushedEntry).toMatchObject({
      id: 'm-99',
      role: 'user',
      content: 'hi',
      timestamp: expect.any(Number),
    });
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

  it('IIFE rejection logs at error level and does not throw out of the sync caller', async () => {
    const bridge = makeMockBridge({ coneJid: 'cone-1' });
    const orchestrator = makeMockOrchestrator([
      { jid: 'cone-1', name: 'cone', isCone: true, folder: 'cone' },
    ]);
    orchestrator.handleMessage = vi.fn().mockRejectedValue(new Error('orchestrator bork'));
    const errorSpy = vi.fn();
    const { handle, options } = startWithCapture({
      bridge: bridge as any,
      orchestrator: orchestrator as any,
      log: { info: vi.fn(), warn: vi.fn(), error: errorSpy } as any,
    });
    // Sync return is undefined even though dispatch rejects.
    expect(options.onFollowerMessage('hi', 'm-99', undefined)).toBeUndefined();
    // Microtask drain for the IIFE's reject path.
    await Promise.resolve();
    await Promise.resolve();
    // The error was logged at error level (not just warn).
    expect(errorSpy).toHaveBeenCalledWith(
      'Follower message dispatch failed',
      expect.objectContaining({ error: expect.stringContaining('orchestrator bork') })
    );
    // createScoopTab was not called because handleMessage rejected.
    expect(orchestrator.createScoopTab).not.toHaveBeenCalled();
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
      lickManager: overrides.lickManager ?? ({ emitEvent: vi.fn() } as any),
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
      lickManager: overrides.lickManager ?? ({ emitEvent: vi.fn() } as any),
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
    // No `as any` on the captured config: this proves the contextual typing
    // path through `_trayLeaderFactory: ConstructorParameters<typeof
    // LeaderTrayManager>[0]` is still alive. If a future change re-adds an
    // explicit `(cfg: any) => …` annotation on the factory and breaks the
    // narrowing, this line stops compiling.
    const capturedCfg = trayLeaderFactoryFn.mock.calls[0]![0];
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
      lickManager: overrides.lickManager ?? ({ emitEvent: vi.fn() } as any),
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

describe('startExtensionLeaderTray intervals', () => {
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
      lickManager: overrides.lickManager ?? ({ emitEvent: vi.fn() } as any),
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

  it('refreshLeaderTargets calls sync.setLocalTargets (NOT advertiseTargets)', async () => {
    const browser = makeStubBrowser();
    browser.listPages = vi
      .fn()
      .mockResolvedValue([{ targetId: 't1', title: 'A', url: 'about:blank' }]);
    const { handle } = startWithCapture({
      browser,
      _refreshIntervalMs: 50,
    } as any);
    const setLocalSpy = vi.spyOn(handle.sync, 'setLocalTargets').mockImplementation(() => {});
    // The factory calls refreshLeaderTargets immediately at startup.
    // Yield a microtask + a tick for the awaited listPages to resolve.
    await new Promise((r) => setTimeout(r, 10));
    expect(setLocalSpy).toHaveBeenCalledWith([{ targetId: 't1', title: 'A', url: 'about:blank' }]);
    handle.stop();
  });

  it('broadcasts scoops + sprinkles lists on interval', async () => {
    const { handle } = startWithCapture({ _refreshIntervalMs: 30 } as any);
    const scoopsSpy = vi.spyOn(handle.sync, 'broadcastScoopsList').mockImplementation(() => {});
    const sprinklesSpy = vi
      .spyOn(handle.sync, 'broadcastSprinklesList')
      .mockImplementation(() => {});
    await new Promise((r) => setTimeout(r, 100));
    expect(scoopsSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(sprinklesSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    handle.stop();
  });

  it('teardown clears intervals', async () => {
    const { handle } = startWithCapture({ _refreshIntervalMs: 20 } as any);
    handle.stop();
    const scoopsSpy = vi.spyOn(handle.sync, 'broadcastScoopsList').mockImplementation(() => {});
    await new Promise((r) => setTimeout(r, 80));
    expect(scoopsSpy).not.toHaveBeenCalled();
  });
});

describe('startExtensionLeaderTray host-command + reset', () => {
  function startWithCapture(
    overrides: Partial<Parameters<typeof startExtensionLeaderTray>[0]> = {}
  ) {
    let capturedOptions!: LeaderSyncManagerOptions;
    const orchestrator =
      overrides.orchestrator ??
      makeMockOrchestrator([{ jid: 'cone-1', name: 'cone', isCone: true, folder: 'cone' }]);
    const bridge = overrides.bridge ?? makeMockBridge({ coneJid: 'cone-1' });
    const leaderStub = {
      start: vi.fn().mockResolvedValue({}),
      stop: vi.fn(),
      clearSession: vi.fn().mockResolvedValue(undefined),
      sendControlMessage: vi.fn(),
    };
    const peersStub = {
      stop: vi.fn(),
      getPeers: vi.fn(() => []),
      handleControlMessage: vi.fn().mockResolvedValue(undefined),
    };
    const handle = startExtensionLeaderTray({
      workerBaseUrl: 'wss://test',
      bridge: bridge as any,
      orchestrator: orchestrator as any,
      sharedFs: overrides.sharedFs ?? (makeMockSharedFs() as any),
      browser: overrides.browser ?? makeStubBrowser(),
      log: console as any,
      lickManager: overrides.lickManager ?? ({ emitEvent: vi.fn() } as any),
      leaderBridge:
        overrides.leaderBridge ??
        ({
          getSprinkles: () => [],
          resolveSprinklePath: () => null,
          signalLeaderMode: vi.fn(),
          detach: vi.fn(),
        } as any),
      _trayLeaderFactory: () => leaderStub as any,
      _peerManagerFactory: () => peersStub as any,
      _onSyncOptions: (opts) => {
        capturedOptions = opts;
      },
      ...overrides,
    });
    return {
      handle: handle as any,
      options: capturedOptions,
      orchestrator,
      bridge,
    };
  }

  it('setConnectedFollowersGetter exposes the peer list', async () => {
    const { getConnectedFollowers } = await import(
      '../../webapp/src/shell/supplemental-commands/host-command.js'
    );
    const { handle } = startWithCapture();
    handle.peers.getPeers = vi.fn(
      () =>
        [
          {
            bootstrapId: 'b1',
            runtime: 'slicc-standalone',
            connectedAt: '2026-05-20T00:00:00Z',
          },
        ] as any
    );
    const followers = getConnectedFollowers();
    expect(followers).toEqual([
      {
        runtimeId: 'follower-b1',
        runtime: 'slicc-standalone',
        connectedAt: '2026-05-20T00:00:00Z',
      },
    ]);
    handle.stop();
  });

  it('leader-tray-reset envelope triggers reset + replies with status', async () => {
    const { handle } = startWithCapture();
    sentMessages.length = 0;
    // Multiple listeners are installed in the constructor flow (reset, preview).
    // Fan the envelope out to all of them — chrome.runtime fires every
    // registered listener in real life and each early-returns on mismatch.
    const env = { source: 'panel', payload: { type: 'leader-tray-reset', requestId: 'r-1' } };
    for (const listener of messageListeners) listener(env, {}, () => {});
    await new Promise((r) => setTimeout(r, 10));
    const reply = sentMessages.find(
      (m: any) => m?.payload?.type === 'leader-tray-reset-response'
    ) as any;
    expect(reply).toBeDefined();
    expect(reply.payload).toMatchObject({ requestId: 'r-1', ok: true });
    expect(handle.leader.clearSession).toHaveBeenCalled();
    // Factory doesn't call start() on boot — only reset's start fires.
    expect(handle.leader.start).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it('onFollowerCountChanged writes slicc.leaderTrayFollowers to localStorage', () => {
    const setItem = vi.fn();
    const originalWindow = (globalThis as any).window;
    (globalThis as any).window = { localStorage: { setItem } };
    try {
      const { handle, options } = startWithCapture();
      handle.peers.getPeers = vi.fn(
        () =>
          [
            {
              bootstrapId: 'b1',
              runtime: 'slicc-standalone',
              connectedAt: '2026-05-20T00:00:00Z',
            },
          ] as any
      );
      options.onFollowerCountChanged?.(1);
      expect(setItem).toHaveBeenCalledWith(
        'slicc.leaderTrayFollowers',
        JSON.stringify([
          {
            runtimeId: 'follower-b1',
            runtime: 'slicc-standalone',
            connectedAt: '2026-05-20T00:00:00Z',
          },
        ])
      );
      handle.stop();
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = originalWindow;
      }
    }
  });
});

describe('startExtensionLeaderTray teardown', () => {
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
      lickManager: overrides.lickManager ?? ({ emitEvent: vi.fn() } as any),
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

  it('stop() tears down in the standalone order', () => {
    const calls: string[] = [];
    const unsubAgent = vi.fn(() => calls.push('unsubAgent'));
    const bridge = makeMockBridge({ coneJid: 'cone-1' });
    bridge.onAgentEvent.mockImplementation(() => unsubAgent);
    const leaderBridge = {
      getSprinkles: () => [],
      resolveSprinklePath: () => null,
      signalLeaderMode: vi.fn(() => calls.push('signalLeaderMode(false)')),
      detach: vi.fn(() => calls.push('leaderBridge.detach')),
    };
    const removeListenerSpy = vi.fn(() => calls.push('removeListener'));
    mockChrome.runtime.onMessage.removeListener = removeListenerSpy as any;

    const { handle } = startWithCapture({
      bridge: bridge as any,
      leaderBridge: leaderBridge as any,
    });
    vi.spyOn(handle.sync, 'stop').mockImplementation(() => {
      calls.push('sync');
    });
    vi.spyOn(handle.peers, 'stop').mockImplementation(() => {
      calls.push('peers');
    });
    vi.spyOn(handle.leader, 'stop').mockImplementation(() => {
      calls.push('leader');
    });
    handle.stop();
    // Two listeners are removed (leader-tray-reset + tray-open-preview), so
    // removeListener appears twice in the call order between leader.stop and
    // signalLeaderMode(false).
    expect(calls).toEqual([
      'unsubAgent',
      'sync',
      'peers',
      'leader',
      'removeListener',
      'removeListener',
      'signalLeaderMode(false)',
      'leaderBridge.detach',
    ]);
    // signalLeaderMode receives `false`.
    expect(leaderBridge.signalLeaderMode).toHaveBeenCalledWith(false);
  });

  it('stop() also clears intervals + host-command setters', async () => {
    const { getConnectedFollowers } = await import(
      '../../webapp/src/shell/supplemental-commands/host-command.js'
    );
    const clearSpy = vi.spyOn(global, 'clearInterval');
    const { handle } = startWithCapture();
    handle.stop();
    expect(clearSpy).toHaveBeenCalled();
    expect(getConnectedFollowers()).toEqual([]); // setter cleared
    clearSpy.mockRestore();
  });

  it('stop() is idempotent', () => {
    const { handle } = startWithCapture();
    handle.stop();
    expect(() => handle.stop()).not.toThrow();
  });
});

describe('startExtensionLeaderTray start failure retry contract', () => {
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
      lickManager: overrides.lickManager ?? ({ emitEvent: vi.fn() } as any),
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

  it('handle.stop() is safe to call even before leader.start() resolves or rejects', () => {
    let startRejected!: (err: Error) => void;
    const trayLeaderFactoryFn = vi.fn(() => ({
      start: vi.fn(
        () =>
          new Promise<unknown>((_, reject) => {
            startRejected = reject;
          })
      ),
      stop: vi.fn(),
      clearSession: vi.fn().mockResolvedValue(undefined),
      sendControlMessage: vi.fn(),
    }));
    const { handle } = startWithCapture({
      _trayLeaderFactory: trayLeaderFactoryFn as any,
    });
    // offscreen.ts:490 fires `leader.start()` after the factory returns —
    // mirror that here so the start() promise actually exists when we
    // tear down. This is the precise path the catch handler exercises.
    void handle.leader.start().catch(() => {
      /* swallow — late rejection landing after stop must not bubble */
    });
    // Caller tears down the handle BEFORE leader.start() resolves/rejects.
    expect(() => handle.stop()).not.toThrow();
    // Even after stop, late-fired start() rejection must not throw.
    expect(() => startRejected(new Error('hub unreachable'))).not.toThrow();
  });

  it('a second startExtensionLeaderTray after the first stops cleanly (parallel-instance contract)', () => {
    // This pins the contract offscreen.ts:481-498 relies on: after the
    // catch handler stops + nulls the dead handle, a new
    // startExtensionLeaderTray with the same config must construct
    // cleanly without colliding on any module-level singleton.
    const { handle: handle1 } = startWithCapture();
    handle1.stop();
    const { handle: handle2 } = startWithCapture();
    expect(handle2).toBeDefined();
    expect(handle2.sync).toBeDefined();
    handle2.stop();
  });

  it('handle.stop() is idempotent after a leader.start() rejection', async () => {
    const trayLeaderFactoryFn = vi.fn(() => ({
      start: vi.fn().mockRejectedValue(new Error('hub unreachable')),
      stop: vi.fn(),
      clearSession: vi.fn().mockResolvedValue(undefined),
      sendControlMessage: vi.fn(),
    }));
    const { handle } = startWithCapture({
      _trayLeaderFactory: trayLeaderFactoryFn as any,
    });
    // Wait for the start() rejection to actually fire.
    await Promise.resolve();
    await Promise.resolve();
    // First stop tears down.
    handle.stop();
    // Second stop must not throw (idempotency contract).
    expect(() => handle.stop()).not.toThrow();
  });
});
