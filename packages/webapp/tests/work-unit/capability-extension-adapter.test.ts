/**
 * The extension adapter over its REAL default transports (#2276 slice B).
 *
 * `capability-broker.test.ts` runs the conformance suite with the transports
 * injected; this file drives the production wiring instead — the
 * same-extension `chrome.runtime.sendMessage` path for `extension-direct` and
 * the externally-connectable `chrome.runtime.connect(<id>, { name })` Port for
 * `extension-delegate` — so a change to a Port name or a message shape is
 * caught here rather than in a float.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createExtensionCapabilityBroker,
  isCapabilityFailure,
} from '../../src/work-unit/capability/index.js';

/**
 * Set the delegate id on the module instance the adapter's LAZY import will
 * resolve to. `vi.resetModules()` between tests gives each one a fresh bridge
 * client (so a cached Port never leaks across cases), which also means a
 * statically-imported setter would write to a stale instance.
 */
async function setDelegateId(id: string | null): Promise<void> {
  const { setExtensionDelegateId } = await import('../../src/base/api-endpoint.js');
  setExtensionDelegateId(id);
}

interface SentMessage {
  message: Record<string, unknown>;
}

/** Messages the scripted service worker saw, in order. */
const sent: SentMessage[] = [];
/** Ports the page opened, by `chrome.runtime.connect` name. */
const openedPorts: string[] = [];
/** Scripted `fetch-proxy.fetch` reply, streamed head → chunk → end. */
let proxyResponse = {
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'text/plain' },
  body: 'proxied-body',
};

let lastError: { message?: string } | null = null;
let reply: unknown = { ok: true };

const originalChrome = (globalThis as { chrome?: unknown }).chrome;

function installChrome(options: { connect?: boolean } = {}): void {
  const runtime: Record<string, unknown> = {
    get lastError() {
      return lastError;
    },
    sendMessage: (message: Record<string, unknown>, callback?: (r: unknown) => void) => {
      sent.push({ message });
      callback?.(reply);
    },
  };
  if (options.connect) {
    // One stub for both connect shapes: `connect(id, { name })` from a
    // thin-bridge page, `connect({ name })` from a real extension page.
    runtime.connect = (first: unknown, second?: { name: string }) => {
      const info = (second ?? first) as { name: string };
      openedPorts.push(info.name);
      let onMessage: ((msg: unknown) => void) | undefined;
      return {
        onMessage: {
          addListener: (fn: (msg: unknown) => void) => {
            onMessage = fn;
          },
        },
        onDisconnect: { addListener: () => {} },
        postMessage: (msg: Record<string, unknown>) => {
          sent.push({ message: msg });
          if (info.name === 'fetch-proxy.fetch') {
            onMessage?.({
              type: 'response-head',
              status: proxyResponse.status,
              statusText: proxyResponse.statusText,
              headers: proxyResponse.headers,
            });
            onMessage?.({
              type: 'response-chunk',
              dataBase64: Buffer.from(proxyResponse.body, 'utf8').toString('base64'),
            });
            onMessage?.({ type: 'response-end' });
            return;
          }
          onMessage?.({ id: msg.id, response: reply });
        },
        disconnect: () => {},
      };
    };
  }
  (globalThis as { chrome?: unknown }).chrome = { runtime };
}

beforeEach(() => {
  sent.length = 0;
  openedPorts.length = 0;
  lastError = null;
  reply = { ok: true };
  proxyResponse = {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'text/plain' },
    body: 'proxied-body',
  };
});

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = originalChrome;
  vi.resetModules();
});

describe('extension-direct default transports', () => {
  it('sends secret CRUD as same-extension control messages', async () => {
    installChrome();
    const broker = createExtensionCapabilityBroker({ adapter: 'extension-direct' });
    await broker.secrets.set({ name: 'TOK', value: 'v', domains: ['api.test'] });
    await broker.secrets.set({ name: 'TOK', value: 'v', scope: 'session' });
    await broker.secrets.delete({ name: 'TOK' });
    expect(sent.map((s) => s.message)).toEqual([
      { type: 'secrets.set', name: 'TOK', value: 'v', domains: ['api.test'] },
      { type: 'secrets.session.set', name: 'TOK', value: 'v', domains: [] },
      { type: 'secrets.delete', name: 'TOK' },
    ]);
  });

  it('sends a sign-and-forward envelope under the mount message type', async () => {
    installChrome();
    reply = { ok: true, status: 200, headers: {}, bodyBase64: '' };
    const broker = createExtensionCapabilityBroker({ adapter: 'extension-direct' });
    const envelope = { profile: 'p', method: 'GET' as const, bucket: 'b', key: 'k' };
    const result = await broker.mounts.signRequest({ backend: 's3', envelope });
    expect(sent[0].message).toEqual({ type: 'mount.s3-sign-and-forward', envelope });
    expect(result).toEqual({ ok: true, value: reply });
  });

  it('turns a chrome.runtime.lastError into a typed failure, not a throw', async () => {
    installChrome();
    lastError = { message: 'service worker inactive' };
    const broker = createExtensionCapabilityBroker({ adapter: 'extension-direct' });
    const result = await broker.secrets.listMaskedEnv();
    expect(isCapabilityFailure(result)).toBe(true);
    if (isCapabilityFailure(result)) {
      expect(result.capability).toBe('secrets');
      expect(result.message).toBe('service worker inactive');
    }
  });
});

describe('cross-origin fetch over the fetch-proxy Port', () => {
  it('collects the streamed response from the id-less Port in the extension realm', async () => {
    installChrome({ connect: true });
    const broker = createExtensionCapabilityBroker({ adapter: 'extension-direct' });
    const result = await broker.network.crossOriginFetch({
      url: 'https://example.test/hello',
      method: 'GET',
    });
    expect(openedPorts).toEqual(['fetch-proxy.fetch']);
    expect(sent[0].message).toMatchObject({ type: 'request', url: 'https://example.test/hello' });
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        status: 200,
        ok: true,
        body: 'proxied-body',
        bodyEncoding: 'text',
        url: 'https://example.test/hello',
      }),
    });
  });

  it('base64-encodes a binary body and opens the delegate Port when there is an id', async () => {
    installChrome({ connect: true });
    await setDelegateId('delegate-extension-id');
    proxyResponse = {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/octet-stream' },
      body: 'raw-bytes',
    };
    const broker = createExtensionCapabilityBroker({ adapter: 'extension-delegate' });
    const result = await broker.network.crossOriginFetch({ url: 'https://example.test/bin' });
    expect(openedPorts).toEqual(['fetch-proxy.fetch']);
    expect(result.ok && result.value.bodyEncoding).toBe('base64');
    expect(result.ok && Buffer.from(result.value.body, 'base64').toString('utf8')).toBe(
      'raw-bytes'
    );
  });

  it('reports a Port that never opens as a failure, not as unavailable', async () => {
    installChrome();
    const broker = createExtensionCapabilityBroker({ adapter: 'extension-delegate' });
    const result = await broker.network.crossOriginFetch({ url: 'https://example.test/' });
    expect(isCapabilityFailure(result)).toBe(true);
  });
});

describe('approvals over the extension sudo relay', () => {
  it('relays a sudo request to the panel and normalizes the decision', async () => {
    installChrome();
    reply = { ok: true, decision: { decision: 'always', pattern: 'git *' } };
    const broker = createExtensionCapabilityBroker({ adapter: 'extension-direct' });
    const result = await broker.approvals.request({
      kind: 'command',
      detail: 'git status',
      suggestedPattern: 'git *',
    });
    expect(sent[0].message).toMatchObject({
      source: 'offscreen',
      payload: { type: 'sudo-request' },
    });
    expect(result).toEqual({ ok: true, value: { decision: 'always', pattern: 'git *' } });
  });

  it('fails an approval closed when the panel returns an error envelope', async () => {
    installChrome();
    reply = { ok: false, error: 'no responder' };
    const broker = createExtensionCapabilityBroker({ adapter: 'extension-direct' });
    const result = await broker.approvals.request({ kind: 'command', detail: 'ls' });
    expect(result).toEqual({ ok: true, value: { decision: 'deny' } });
  });
});

describe('extension-delegate default transports', () => {
  it('routes secret CRUD over the secrets.crud Port, correlated by id', async () => {
    installChrome({ connect: true });
    await setDelegateId('delegate-extension-id');
    const broker = createExtensionCapabilityBroker({ adapter: 'extension-delegate' });
    const result = await broker.secrets.set({ name: 'TOK', value: 'v', domains: ['api.test'] });
    expect(openedPorts).toEqual(['secrets.crud']);
    expect(sent[0].message).toEqual({
      id: 1,
      type: 'secrets.set',
      name: 'TOK',
      value: 'v',
      domains: ['api.test'],
    });
    expect(result).toEqual({ ok: true, value: undefined });
  });

  it('routes sign-and-forward over the mount.sign-and-forward Port', async () => {
    installChrome({ connect: true });
    await setDelegateId('delegate-extension-id');
    reply = { ok: true, status: 200, headers: {}, bodyBase64: '' };
    const broker = createExtensionCapabilityBroker({ adapter: 'extension-delegate' });
    const envelope = { imsToken: 't', method: 'GET' as const, path: '/source/x' };
    const result = await broker.mounts.signRequest({ backend: 'da', envelope });
    expect(openedPorts).toEqual(['mount.sign-and-forward']);
    expect(sent[0].message).toEqual({ id: 1, type: 'mount.da-sign-and-forward', envelope });
    expect(result).toEqual({ ok: true, value: reply });
  });

  it('reports a failure when no delegate id was ever configured', async () => {
    installChrome({ connect: true });
    await setDelegateId(null);
    const broker = createExtensionCapabilityBroker({ adapter: 'extension-delegate' });
    const result = await broker.mounts.signRequest({
      backend: 's3',
      envelope: { profile: 'p', method: 'GET', bucket: 'b', key: 'k' },
    });
    expect(isCapabilityFailure(result)).toBe(true);
    expect(openedPorts).toEqual([]);
  });
});
