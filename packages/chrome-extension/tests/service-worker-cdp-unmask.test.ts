import { mask } from '@slicc/shared-ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXTENSION_BRIDGE_PORT_NAME,
  EXTENSION_BRIDGE_PROTOCOL_VERSION,
} from '../../webapp/src/cdp/extension-bridge-protocol.js';

type MessageListener = (msg: any, sender: any, sendResponse: (r: any) => void) => boolean | void;

interface FakePort {
  name: string;
  sender: { origin: string; tab: { id: number }; frameId: number; url: string };
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (listener: (message: unknown) => void) => void };
  onDisconnect: { addListener: (listener: () => void) => void };
  receive: (message: unknown) => void;
}

function makeBridgePort(): FakePort {
  const messageListeners: Array<(message: unknown) => void> = [];
  return {
    name: EXTENSION_BRIDGE_PORT_NAME,
    sender: {
      origin: 'https://www.sliccy.ai',
      tab: { id: 7 },
      frameId: 0,
      url: 'https://www.sliccy.ai/?slicc=leader',
    },
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: { addListener: (listener) => messageListeners.push(listener) },
    onDisconnect: { addListener: vi.fn() },
    receive: (message) => {
      for (const listener of messageListeners) listener(message);
    },
  };
}

describe('service-worker CDP outgoing unmask', () => {
  let messageListeners: MessageListener[];
  let runtimeSentMessages: any[];
  let storageMap: Record<string, string>;
  let tabsMap: Record<number, { id: number; url: string }>;
  let debuggerSendCommand: ReturnType<typeof vi.fn>;
  let tabsGet: ReturnType<typeof vi.fn>;
  let connectExternalListeners: Array<(port: FakePort) => void>;
  let debuggerDetachListeners: Array<(source: { tabId: number }, reason: string) => void>;
  let debuggerAttached: boolean;

  const SESSION_ID = '11111111-2222-3333-4444-555555555555';
  const TAB_ID = 42;

  beforeEach(() => {
    messageListeners = [];
    runtimeSentMessages = [];
    connectExternalListeners = [];
    debuggerDetachListeners = [];
    debuggerAttached = false;
    storageMap = {
      '_session.id': SESSION_ID,
      GITHUB_TOKEN: 'ghp_realtoken',
      GITHUB_TOKEN_DOMAINS: 'api.github.com',
    };
    tabsMap = { [TAB_ID]: { id: TAB_ID, url: 'https://api.github.com/user' } };
    debuggerSendCommand = vi.fn(async () => ({}));
    tabsGet = vi.fn(async (id: number) => {
      const tab = tabsMap[id];
      if (!tab) throw new Error(`No tab with id ${id}`);
      return tab;
    });

    (globalThis as any).chrome = {
      runtime: {
        onConnect: { addListener: vi.fn() },
        onConnectExternal: {
          addListener: (listener: (port: FakePort) => void) =>
            connectExternalListeners.push(listener),
        },
        onMessage: { addListener: (fn: MessageListener) => messageListeners.push(fn) },
        onInstalled: { addListener: vi.fn() },
        onStartup: { addListener: vi.fn() },
        onUpdateAvailable: { addListener: vi.fn() },
        reload: vi.fn(),
        getContexts: vi.fn(async () => []),
        id: 'test-id',
        sendMessage: vi.fn(async (m: any) => {
          runtimeSentMessages.push(m);
        }),
      },
      storage: {
        local: {
          get: vi.fn(async (key?: string | string[] | null) => {
            if (key == null) return { ...storageMap };
            if (typeof key === 'string') return key in storageMap ? { [key]: storageMap[key] } : {};
            const out: Record<string, string> = {};
            for (const k of key as string[]) if (k in storageMap) out[k] = storageMap[k];
            return out;
          }),
          set: vi.fn(async (obj: Record<string, string>) => Object.assign(storageMap, obj)),
          remove: vi.fn(async (keys: string | string[]) => {
            const arr = Array.isArray(keys) ? keys : [keys];
            for (const k of arr) delete storageMap[k];
          }),
        },
        session: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
        },
      },
      sidePanel: {
        setPanelBehavior: vi.fn(async () => {}),
        setOptions: vi.fn(async () => {}),
        open: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      },
      offscreen: { hasDocument: vi.fn(async () => true) },
      action: {
        setBadgeText: vi.fn(),
        setBadgeBackgroundColor: vi.fn(),
        onClicked: { addListener: vi.fn() },
      },
      tabs: {
        get: tabsGet,
        query: vi.fn(async () => []),
        create: vi.fn(),
        reload: vi.fn(async () => {}),
        remove: vi.fn(),
        group: vi.fn(),
        onCreated: { addListener: vi.fn() },
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
      },
      tabGroups: { update: vi.fn() },
      debugger: {
        attach: vi.fn(async () => {
          debuggerAttached = true;
        }),
        detach: vi.fn(async () => {
          debuggerAttached = false;
        }),
        sendCommand: debuggerSendCommand,
        onEvent: { addListener: vi.fn() },
        onDetach: {
          addListener: (listener: (source: { tabId: number }, reason: string) => void) =>
            debuggerDetachListeners.push(listener),
        },
      },
      identity: { launchWebAuthFlow: vi.fn(), getRedirectURL: vi.fn() },
      notifications: { create: vi.fn(), onClicked: { addListener: vi.fn() } },
      webRequest: { onHeadersReceived: { addListener: vi.fn() } },
    };
    (globalThis as any).WebSocket = class {
      addEventListener() {}
      send() {}
      close() {}
    };
    vi.resetModules();
  });

  async function dispatchOffscreen(payload: unknown): Promise<void> {
    for (const l of messageListeners) {
      l({ source: 'offscreen', payload }, {}, () => {});
    }
    // Let the async handleCdpCommand chain run.
    await new Promise((r) => setTimeout(r, 30));
  }

  async function attach(): Promise<void> {
    await dispatchOffscreen({
      type: 'cdp-command',
      id: 1,
      method: 'Target.attachToTarget',
      params: { targetId: String(TAB_ID), flatten: true },
    });
  }

  it('unmasks Runtime.evaluate expression when tab URL matches secret domain', async () => {
    await import('../src/service-worker.js');
    await attach();

    const masked = await mask(SESSION_ID, 'GITHUB_TOKEN', 'ghp_realtoken');
    await dispatchOffscreen({
      type: 'cdp-command',
      id: 2,
      method: 'Runtime.evaluate',
      params: { expression: `fetch('/user', { headers: { Authorization: 'token ${masked}' } })` },
      sessionId: String(TAB_ID),
    });

    expect(tabsGet).toHaveBeenCalledWith(TAB_ID);
    const evalCalls = debuggerSendCommand.mock.calls.filter((c) => c[1] === 'Runtime.evaluate');
    expect(evalCalls).toHaveLength(1);
    const sentParams = evalCalls[0][2] as { expression: string };
    expect(sentParams.expression).toContain('ghp_realtoken');
    expect(sentParams.expression).not.toContain(masked);
  });

  it('leaves Runtime.evaluate frame untouched when tab URL does not match secret domain', async () => {
    tabsMap[TAB_ID] = { id: TAB_ID, url: 'https://evil.example.com/' };
    await import('../src/service-worker.js');
    await attach();

    const masked = await mask(SESSION_ID, 'GITHUB_TOKEN', 'ghp_realtoken');
    await dispatchOffscreen({
      type: 'cdp-command',
      id: 2,
      method: 'Runtime.evaluate',
      params: { expression: `console.log('${masked}')` },
      sessionId: String(TAB_ID),
    });

    const evalCalls = debuggerSendCommand.mock.calls.filter((c) => c[1] === 'Runtime.evaluate');
    expect(evalCalls).toHaveLength(1);
    const sentParams = evalCalls[0][2] as { expression: string };
    expect(sentParams.expression).toContain(masked);
    expect(sentParams.expression).not.toContain('ghp_realtoken');
  });

  it('fails closed when the target tab cannot be resolved', async () => {
    tabsGet.mockImplementation(async () => {
      throw new Error('No tab with that id');
    });
    await import('../src/service-worker.js');
    await attach();

    const masked = await mask(SESSION_ID, 'GITHUB_TOKEN', 'ghp_realtoken');
    await dispatchOffscreen({
      type: 'cdp-command',
      id: 2,
      method: 'Input.insertText',
      params: { text: masked },
      sessionId: String(TAB_ID),
    });

    const calls = debuggerSendCommand.mock.calls.filter((c) => c[1] === 'Input.insertText');
    expect(calls).toHaveLength(1);
    const sentParams = calls[0][2] as { text: string };
    expect(sentParams.text).toBe(masked);
  });

  it('does not call chrome.tabs.get for non-unmask CDP methods', async () => {
    await import('../src/service-worker.js');
    await attach();
    tabsGet.mockClear();

    await dispatchOffscreen({
      type: 'cdp-command',
      id: 2,
      method: 'Page.reload',
      params: { ignoreCache: false },
      sessionId: String(TAB_ID),
    });

    expect(tabsGet).not.toHaveBeenCalled();
    const calls = debuggerSendCommand.mock.calls.filter((c) => c[1] === 'Page.reload');
    expect(calls).toHaveLength(1);
  });

  it('does not detach a legacy-owned debugger session when the bridge releases it', async () => {
    await import('../src/service-worker.js');
    await attach();
    expect(debuggerAttached).toBe(true);
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(1);

    const port = makeBridgePort();
    for (const listener of connectExternalListeners) listener(port);
    await new Promise((resolve) => setTimeout(resolve, 0));
    port.receive({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: 'ownership-test',
      kind: 'handshake.hello',
    });
    port.receive({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: 'ownership-test',
      kind: 'cdp.request',
      id: 2,
      method: 'Target.attachToTarget',
      params: { targetId: String(TAB_ID) },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    port.receive({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: 'ownership-test',
      kind: 'cdp.request',
      id: 3,
      method: 'Target.detachFromTarget',
      params: { sessionId: String(TAB_ID) },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chrome.debugger.attach).toHaveBeenCalledTimes(1);
    expect(chrome.debugger.detach).not.toHaveBeenCalled();
    expect(debuggerAttached).toBe(true);

    await dispatchOffscreen({
      type: 'cdp-command',
      id: 4,
      method: 'Target.detachFromTarget',
      params: { sessionId: String(TAB_ID) },
    });
    expect(chrome.debugger.detach).toHaveBeenCalledTimes(1);
    expect(debuggerAttached).toBe(false);
  });

  it('does not detach a bridge-owned debugger session when the legacy path releases it', async () => {
    await import('../src/service-worker.js');
    const port = makeBridgePort();
    for (const listener of connectExternalListeners) listener(port);
    await new Promise((resolve) => setTimeout(resolve, 0));
    port.receive({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: 'inverse-ownership-test',
      kind: 'handshake.hello',
    });
    port.receive({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: 'inverse-ownership-test',
      kind: 'cdp.request',
      id: 2,
      method: 'Target.attachToTarget',
      params: { targetId: String(TAB_ID) },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(debuggerAttached).toBe(true);
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(1);

    await attach();
    await dispatchOffscreen({
      type: 'cdp-command',
      id: 3,
      method: 'Target.detachFromTarget',
      params: { sessionId: String(TAB_ID) },
    });

    expect(chrome.debugger.attach).toHaveBeenCalledTimes(1);
    expect(chrome.debugger.detach).not.toHaveBeenCalled();
    expect(debuggerAttached).toBe(true);

    port.receive({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: 'inverse-ownership-test',
      kind: 'cdp.request',
      id: 4,
      method: 'Target.detachFromTarget',
      params: { sessionId: String(TAB_ID) },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chrome.debugger.detach).toHaveBeenCalledTimes(1);
    expect(debuggerAttached).toBe(false);
  });

  it('reacquires a bridge debugger attachment after an external detach', async () => {
    await import('../src/service-worker.js');
    const port = makeBridgePort();
    for (const listener of connectExternalListeners) listener(port);
    await new Promise((resolve) => setTimeout(resolve, 0));
    port.receive({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: 'external-detach-test',
      kind: 'handshake.hello',
    });

    const attachThroughBridge = (id: number): void => {
      port.receive({
        bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
        channelId: 'external-detach-test',
        kind: 'cdp.request',
        id,
        method: 'Target.attachToTarget',
        params: { targetId: String(TAB_ID) },
      });
    };

    attachThroughBridge(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(1);

    debuggerAttached = false;
    for (const listener of debuggerDetachListeners) {
      listener({ tabId: TAB_ID }, 'canceled_by_user');
    }

    port.receive({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: 'external-detach-test',
      kind: 'cdp.request',
      id: 2,
      method: 'Runtime.evaluate',
      params: { expression: '1 + 1' },
      sessionId: String(TAB_ID),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 2,
        error: expect.stringContaining('No tab attached'),
      })
    );

    attachThroughBridge(3);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(2);
    expect(debuggerAttached).toBe(true);

    port.receive({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: 'external-detach-test',
      kind: 'cdp.request',
      id: 4,
      method: 'Target.detachFromTarget',
      params: { sessionId: String(TAB_ID) },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chrome.debugger.detach).toHaveBeenCalledTimes(1);
    expect(debuggerAttached).toBe(false);
  });
});
