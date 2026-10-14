/**
 * Tests for B-SEC1: sender identity checks in sw-message-router.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { routeSwMessage, type SwMessageHandler } from '../src/sw-message-router.js';

// Stub chrome.runtime.id for the sender check.
const FAKE_EXT_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const EXT_ORIGIN = `chrome-extension://${FAKE_EXT_ID}`;
(globalThis as any).chrome = {
  runtime: { id: FAKE_EXT_ID },
};

function trustedSender(): ChromeMessageSender {
  return { id: FAKE_EXT_ID, origin: EXT_ORIGIN };
}

function trustedSenderInTab(): ChromeMessageSender {
  // Extension page opened in a tab (e.g. secrets.html with open_in_tab: true).
  // Has sender.tab set but the origin is still the extension's.
  return { id: FAKE_EXT_ID, origin: EXT_ORIGIN, tab: { id: 1 } };
}

function contentScriptSender(): ChromeMessageSender {
  // Content scripts carry the PAGE's origin, not the extension's.
  return { id: FAKE_EXT_ID, origin: 'https://vault.sliccy.ai', tab: { id: 1 } };
}

function foreignExtensionSender(): ChromeMessageSender {
  return {
    id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    origin: 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  };
}

function noIdSender(): ChromeMessageSender {
  return {};
}

const echoHandler: SwMessageHandler = (msg, _sender, sendResponse) => {
  sendResponse(msg);
  return 'handled-async';
};

describe('B-SEC1: routeSwMessage sender check', () => {
  it('accepts messages from a trusted internal sender (no tab)', () => {
    const sendResponse = vi.fn();
    const result = routeSwMessage([echoHandler], { type: 'test' }, trustedSender(), sendResponse);
    expect(result).toBe(true);
    expect(sendResponse).toHaveBeenCalledWith({ type: 'test' });
  });

  it('accepts messages from the secrets page opened in a tab (extension origin)', () => {
    const sendResponse = vi.fn();
    const result = routeSwMessage(
      [echoHandler],
      { type: 'secrets.list' },
      trustedSenderInTab(),
      sendResponse
    );
    expect(result).toBe(true);
    expect(sendResponse).toHaveBeenCalledWith({ type: 'secrets.list' });
  });

  it('rejects messages from a content script (page origin, not extension origin)', () => {
    const sendResponse = vi.fn();
    const result = routeSwMessage(
      [echoHandler],
      { type: 'secrets.list-with-values-for-pipeline' },
      contentScriptSender(),
      sendResponse
    );
    expect(result).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('rejects messages from a foreign extension', () => {
    const sendResponse = vi.fn();
    const result = routeSwMessage(
      [echoHandler],
      { type: 'secrets.list-with-values-for-pipeline' },
      foreignExtensionSender(),
      sendResponse
    );
    expect(result).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('rejects messages with no sender.id', () => {
    const sendResponse = vi.fn();
    const result = routeSwMessage([echoHandler], { type: 'test' }, noIdSender(), sendResponse);
    expect(result).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });
});

describe('B-SEC1: onConnect Port sender check (integration)', () => {
  // These test the service-worker.ts onConnect listener's sender gate.
  // The actual gate runs at module-top-level, so we mock chrome and import.

  let connectListeners: Array<(port: any) => void>;

  beforeEach(async () => {
    connectListeners = [];
    (globalThis as any).chrome = {
      runtime: {
        id: FAKE_EXT_ID,
        onConnect: { addListener: (fn: any) => connectListeners.push(fn) },
        onConnectExternal: { addListener: vi.fn() },
        onMessage: { addListener: vi.fn() },
        onInstalled: { addListener: vi.fn() },
        onStartup: { addListener: vi.fn() },
        onUpdateAvailable: { addListener: vi.fn() },
        reload: vi.fn(),
        getContexts: vi.fn(async () => []),
        sendMessage: vi.fn(async () => {}),
      },
      sidePanel: { setPanelBehavior: vi.fn(async () => {}) },
      action: { setBadgeText: vi.fn(async () => {}) },
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => {}),
          remove: vi.fn(async () => {}),
        },
        session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
        onChanged: { addListener: vi.fn() },
      },
      tabs: {
        query: vi.fn(async () => []),
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
      },
      debugger: {
        attach: vi.fn(async () => {}),
        detach: vi.fn(async () => {}),
        sendCommand: vi.fn(async () => ({})),
        onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
        onDetach: { addListener: vi.fn() },
      },
      webRequest: { onHeadersReceived: { addListener: vi.fn() } },
      identity: { launchWebAuthFlow: vi.fn(), getRedirectURL: vi.fn() },
      notifications: { create: vi.fn(), onClicked: { addListener: vi.fn() } },
      declarativeNetRequest: { updateSessionRules: vi.fn(async () => {}) },
    };
    (globalThis as any).WebSocket = class {
      addEventListener() {}
      send() {}
      close() {}
    };
    vi.resetModules();
    await import('../src/service-worker.js');
  });

  it('disconnects a port from a content script (page origin)', () => {
    expect(connectListeners.length).toBeGreaterThan(0);
    const port = {
      name: 'fetch-proxy.fetch',
      sender: { id: FAKE_EXT_ID, origin: 'https://vault.sliccy.ai' },
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
      postMessage: vi.fn(),
      disconnect: vi.fn(),
    };
    for (const l of connectListeners) l(port);
    expect(port.disconnect).toHaveBeenCalled();
    expect(port.onMessage.addListener).not.toHaveBeenCalled();
  });

  it('disconnects a port from a foreign extension', () => {
    const port = {
      name: 'cherry-panel',
      sender: { id: 'foreign-ext-id', origin: 'chrome-extension://foreign-ext-id' },
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
      postMessage: vi.fn(),
      disconnect: vi.fn(),
    };
    for (const l of connectListeners) l(port);
    expect(port.disconnect).toHaveBeenCalled();
  });

  it('disconnects a port with no sender', () => {
    const port = {
      name: 'fetch-proxy.fetch',
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
      postMessage: vi.fn(),
      disconnect: vi.fn(),
    };
    for (const l of connectListeners) l(port);
    expect(port.disconnect).toHaveBeenCalled();
  });

  it('accepts a port from the extension itself', () => {
    const port = {
      name: 'fetch-proxy.fetch',
      sender: { id: FAKE_EXT_ID, origin: EXT_ORIGIN },
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
      postMessage: vi.fn(),
      disconnect: vi.fn(),
    };
    for (const l of connectListeners) l(port);
    expect(port.disconnect).not.toHaveBeenCalled();
    // fetch-proxy wires onMessage synchronously
    expect(port.onMessage.addListener).toHaveBeenCalled();
  });
});
