/**
 * Tests for the page-side delegated-fetch relay. Verifies it opens a
 * `chrome.runtime` Port to the extension with the envelope's id, re-adds the
 * `request` discriminator, pipes each `ResponseMsg` onto the SW-supplied
 * response port, and tears both down on terminal messages / disconnect.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { installExtensionFetchDelegate } from '../../../src/ui/boot/setup-extension-fetch-delegate.js';
import {
  type ExtensionFetchDelegateRequest,
  SW_EXTENSION_FETCH_MESSAGE,
} from '../../../src/ui/llm-proxy-sw-config.js';

function makeChromePort() {
  let msgHandler: ((msg: unknown) => void) | null = null;
  let disconnectHandler: (() => void) | null = null;
  return {
    posted: [] as unknown[],
    disconnected: false,
    onMessage: { addListener: (fn: (msg: unknown) => void) => (msgHandler = fn) },
    onDisconnect: { addListener: (fn: () => void) => (disconnectHandler = fn) },
    postMessage(msg: unknown) {
      this.posted.push(msg);
    },
    disconnect() {
      this.disconnected = true;
    },
    emit: (msg: unknown) => msgHandler?.(msg),
    emitDisconnect: () => disconnectHandler?.(),
  };
}

function makeResponsePort() {
  return {
    posted: [] as unknown[],
    closed: false,
    postMessage(msg: unknown) {
      this.posted.push(msg);
    },
    close() {
      this.closed = true;
    },
  };
}

function setup() {
  let messageHandler: ((event: MessageEvent) => void) | null = null;
  vi.stubGlobal('navigator', {
    serviceWorker: {
      addEventListener: (_type: string, fn: (event: MessageEvent) => void) => {
        messageHandler = fn;
      },
    },
  });
  const chromePort = makeChromePort();
  const connect = vi.fn(() => chromePort);
  vi.stubGlobal('chrome', { runtime: { connect } });
  installExtensionFetchDelegate('boot-ext-id');
  return {
    chromePort,
    connect,
    dispatch: (event: MessageEvent) => messageHandler?.(event),
  };
}

const envelope: ExtensionFetchDelegateRequest = {
  type: SW_EXTENSION_FETCH_MESSAGE,
  requestId: 'r1',
  extensionId: 'envelope-ext-id',
  request: { url: 'https://api.example/v1', method: 'POST', headers: { 'x-a': '1' } },
};

afterEach(() => vi.unstubAllGlobals());

describe('installExtensionFetchDelegate', () => {
  it('connects with the envelope id and forwards the request', () => {
    const { connect, chromePort, dispatch } = setup();
    const responsePort = makeResponsePort();
    dispatch({ data: envelope, ports: [responsePort] } as unknown as MessageEvent);

    expect(connect).toHaveBeenCalledWith('envelope-ext-id', { name: 'fetch-proxy.fetch' });
    expect(chromePort.posted).toEqual([
      { type: 'request', url: 'https://api.example/v1', method: 'POST', headers: { 'x-a': '1' } },
    ]);
  });

  it('pipes response messages back and tears down on response-end', () => {
    const { chromePort, dispatch } = setup();
    const responsePort = makeResponsePort();
    dispatch({ data: envelope, ports: [responsePort] } as unknown as MessageEvent);

    chromePort.emit({ type: 'response-head', status: 200, statusText: 'OK', headers: {} });
    chromePort.emit({ type: 'response-chunk', dataBase64: 'aGk=' });
    chromePort.emit({ type: 'response-end' });

    expect(responsePort.posted).toEqual([
      { type: 'response-head', status: 200, statusText: 'OK', headers: {} },
      { type: 'response-chunk', dataBase64: 'aGk=' },
      { type: 'response-end' },
    ]);
    expect(chromePort.disconnected).toBe(true);
    expect(responsePort.closed).toBe(true);
  });

  it('synthesizes a response-error when the chrome port disconnects early', () => {
    const { chromePort, dispatch } = setup();
    const responsePort = makeResponsePort();
    dispatch({ data: envelope, ports: [responsePort] } as unknown as MessageEvent);

    chromePort.emitDisconnect();
    expect(responsePort.posted).toEqual([
      { type: 'response-error', error: 'extension-delegate: fetch-proxy port disconnected' },
    ]);
    expect(responsePort.closed).toBe(true);
  });

  it('ignores unrelated messages and envelopes without a port', () => {
    const { connect, dispatch } = setup();
    dispatch({ data: { type: 'other' }, ports: [makeResponsePort()] } as unknown as MessageEvent);
    dispatch({ data: envelope, ports: [] } as unknown as MessageEvent);
    expect(connect).not.toHaveBeenCalled();
  });
});
