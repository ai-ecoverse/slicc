/**
 * The two adapters must put the SAME bytes on the wire for the same
 * `NetworkFetchRequest` (#2276 slice B).
 *
 * They did not. The REST leg handed a `text` body to `fetch` (UTF-8) while
 * the extension leg handed it to `prepareRequestBody` (latin1 for a binary
 * content type), so a three-byte body went out as five bytes on one adapter
 * and three on the other, and a `base64` body was latin1-decoded as text.
 * A caller cannot write correct code against a contract whose bytes depend
 * on which float it happens to be running on.
 *
 * Both sides are read through the REAL adapter path — a recording `fetch` and
 * a recording port transport — rather than by calling the shared helper
 * directly, because a bypass would prove the helper works and not that the
 * adapters use it.
 */

import { describe, expect, it } from 'vitest';
import {
  createExtensionCapabilityBroker,
  createRestCapabilityBroker,
  type NetworkFetchRequest,
} from '../../src/work-unit/capability/index.js';
import { scriptedRestTransports } from './capability-transport-fixtures.js';

/** The bytes the `node-rest` adapter actually handed to `fetch`. */
async function restBytes(request: NetworkFetchRequest): Promise<Uint8Array> {
  let sent: BodyInit | null | undefined;
  const broker = createRestCapabilityBroker({
    resolveUrl: (path) => path,
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      sent = init?.body;
      return new Response('', { status: 200, headers: { 'content-type': 'text/plain' } });
    }) as typeof fetch,
  });
  const result = await broker.network.crossOriginFetch(request);
  expect(result.ok).toBe(true);
  return new Uint8Array(await new Response(sent ?? new Uint8Array()).arrayBuffer());
}

/**
 * The bytes the extension adapter actually handed to its port transport.
 * `defaultFetch` resolves them before the collector runs, which is the whole
 * point — the collector would otherwise re-decide the encoding.
 */
async function extensionBytes(request: NetworkFetchRequest): Promise<Uint8Array> {
  const { transports, captured } = scriptedRestTransports();
  const broker = createExtensionCapabilityBroker({
    adapter: 'extension-delegate',
    ...transports,
  });
  const result = await broker.network.crossOriginFetch(request);
  expect(result.ok).toBe(true);
  const seen = captured.fetches[0];
  const { capabilityRequestBytes } = await import('../../src/work-unit/capability/request-body.js');
  return capabilityRequestBytes(seen) ?? new Uint8Array();
}

const BINARY = new Uint8Array([0x00, 0x80, 0xff]);
const LATIN1 = String.fromCharCode(...BINARY);
const BASE64 = Buffer.from(BINARY).toString('base64');

describe('request-body parity across adapters', () => {
  const cases: Array<{ name: string; request: NetworkFetchRequest; bytes: Uint8Array }> = [
    {
      name: 'a plain text body is UTF-8',
      request: {
        url: 'https://example.test/',
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'héllo',
      },
      bytes: new TextEncoder().encode('héllo'),
    },
    {
      name: 'a latin1-threaded binary body keeps its bytes',
      request: {
        url: 'https://example.test/',
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: LATIN1,
      },
      bytes: BINARY,
    },
    {
      name: 'a base64 body decodes regardless of content type',
      request: {
        url: 'https://example.test/',
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: BASE64,
        bodyEncoding: 'base64',
      },
      bytes: BINARY,
    },
    {
      name: 'a GET never carries a body, whatever was supplied',
      request: { url: 'https://example.test/', method: 'GET', body: 'ignored' },
      bytes: new Uint8Array(),
    },
  ];

  for (const { name, request, bytes } of cases) {
    it(`${name} — identical on node-rest and extension`, async () => {
      const rest = await restBytes(request);
      const extension = await extensionBytes(request);
      expect(Array.from(rest)).toEqual(Array.from(bytes));
      expect(Array.from(extension)).toEqual(Array.from(bytes));
    });
  }

  it('would have caught the original divergence', async () => {
    // The regression this test exists for: `00 80 ff` sent as `text` with a
    // binary content type. UTF-8 encoding expands it to five bytes.
    const request: NetworkFetchRequest = {
      url: 'https://example.test/',
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: LATIN1,
    };
    const rest = await restBytes(request);
    expect(rest.byteLength).toBe(3);
    expect(Array.from(rest)).toEqual(Array.from(await extensionBytes(request)));
  });
});
