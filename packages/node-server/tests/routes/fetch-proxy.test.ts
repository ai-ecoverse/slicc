/**
 * Route-level coverage for the fetch proxy extracted from index.ts. Drives the
 * real registerFetchProxyRoute against a live upstream HTTP server so the
 * secret-injection (request) and secret-scrub (response) paths are exercised
 * end-to-end with a real SecretProxyManager.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import { registerFetchProxyRoute } from '../../src/routes/fetch-proxy.js';
import { EnvSecretStore } from '../../src/secrets/env-secret-store.js';
import { SecretProxyManager } from '../../src/secrets/proxy-manager.js';

const REAL_TOKEN = 'ghp_realtoken123456789abcdefghij';

type UpstreamHandler = (
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse
) => void;

let tmpDir: string;
let upstream: Server;
let proxy: Server;
let upstreamUrl = '';
let proxyBase = '';
let masked = '';
type LogMock = Mock<(...args: unknown[]) => void>;
let logger: { log: LogMock; warn: LogMock; error: LogMock };

function tempSecrets(domains = '127.0.0.1'): string {
  tmpDir = join(tmpdir(), `slicc-fp-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  const file = join(tmpDir, 'secrets.env');
  writeFileSync(
    file,
    [`GITHUB_TOKEN=${REAL_TOKEN}`, `GITHUB_TOKEN_DOMAINS=${domains}`].join('\n'),
    {
      mode: 0o600,
    }
  );
  return file;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  return typeof addr === 'object' && addr ? addr.port : 0;
}

async function setup(handler: UpstreamHandler, secretDomains?: string): Promise<void> {
  upstream = createServer(handler);
  const upstreamPort = await listen(upstream);
  upstreamUrl = `http://127.0.0.1:${upstreamPort}`;

  const proxyManager = new SecretProxyManager(
    new EnvSecretStore(tempSecrets(secretDomains)),
    'sess'
  );
  await proxyManager.reload();
  masked = proxyManager.getMaskedEntries().find((e) => e.name === 'GITHUB_TOKEN')!.maskedValue;

  const app = express();
  app.use(express.json({ type: () => false })); // never parse — proxy collects raw body
  logger = {
    log: vi.fn<(...args: unknown[]) => void>(),
    warn: vi.fn<(...args: unknown[]) => void>(),
    error: vi.fn<(...args: unknown[]) => void>(),
  };
  registerFetchProxyRoute(app, { secretProxy: proxyManager, logger });
  const proxyPort = await listen(proxy === undefined ? (proxy = createServer(app)) : proxy);
  proxyBase = `http://127.0.0.1:${proxyPort}`;
}

afterEach(async () => {
  await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
  await new Promise<void>((r) => (proxy ? proxy.close(() => r()) : r()));
  proxy = undefined as unknown as Server;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('registerFetchProxyRoute', () => {
  it('returns 400 + X-Proxy-Error when X-Target-URL is missing', async () => {
    await setup((_req, res) => res.end('ignored'));
    const res = await fetch(`${proxyBase}/api/fetch-proxy`);
    expect(res.status).toBe(400);
    expect(res.headers.get('x-proxy-error')).toBe('1');
  });

  it('proxies a GET and forwards the upstream status + body', async () => {
    await setup((_req, res) => {
      res.statusCode = 201;
      res.setHeader('content-type', 'text/plain');
      res.end('hello-from-upstream');
    });
    const res = await fetch(`${proxyBase}/api/fetch-proxy`, {
      headers: { 'x-target-url': upstreamUrl },
    });
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('hello-from-upstream');
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('strips www-authenticate and relays set-cookie as X-Proxy-Set-Cookie', async () => {
    await setup((_req, res) => {
      res.setHeader('www-authenticate', 'Basic realm="x"');
      res.setHeader('set-cookie', ['a=1', 'b=2']);
      res.setHeader('content-type', 'text/plain');
      res.end('ok');
    });
    const res = await fetch(`${proxyBase}/api/fetch-proxy`, {
      headers: { 'x-target-url': upstreamUrl },
    });
    expect(res.headers.get('www-authenticate')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-proxy-set-cookie')).toContain('a=1');
  });

  it('unmasks a masked token in the request body before forwarding upstream', async () => {
    let received = '';
    await setup((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received = Buffer.concat(chunks).toString('utf-8');
        res.setHeader('content-type', 'text/plain');
        res.end('done');
      });
    });
    const res = await fetch(`${proxyBase}/api/fetch-proxy`, {
      method: 'POST',
      headers: { 'x-target-url': upstreamUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ token: masked }),
    });
    expect(res.status).toBe(200);
    expect(received).toContain(REAL_TOKEN);
    expect(received).not.toContain(masked);
  });

  it('scrubs real secret values out of the streamed response body', async () => {
    await setup((_req, res) => {
      res.setHeader('content-type', 'text/plain');
      res.end(`leaked: ${REAL_TOKEN} end`);
    });
    const res = await fetch(`${proxyBase}/api/fetch-proxy`, {
      headers: { 'x-target-url': upstreamUrl },
    });
    const text = await res.text();
    expect(text).not.toContain(REAL_TOKEN);
    expect(text).toContain(masked);
  });

  it('returns 403 when a masked header secret is used against an out-of-scope domain', async () => {
    // Secret is scoped to api.github.com only; the request targets 127.0.0.1.
    await setup((_req, res) => res.end('should-not-reach'), 'api.github.com');
    const res = await fetch(`${proxyBase}/api/fetch-proxy`, {
      headers: { 'x-target-url': upstreamUrl, authorization: `Bearer ${masked}` },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('x-proxy-error')).toBe('1');
    expect(await res.text()).toContain('not allowed for domain');
  });

  it('returns 502 when the upstream cannot be reached', async () => {
    await setup((_req, res) => res.end('unused'));
    const res = await fetch(`${proxyBase}/api/fetch-proxy`, {
      headers: { 'x-target-url': 'http://127.0.0.1:1/nope' },
    });
    expect(res.status).toBe(502);
    expect(res.headers.get('x-proxy-error')).toBe('1');
  });

  it('logs the method, target URL, and upstream status on a successful proxy', async () => {
    await setup((_req, res) => {
      res.setHeader('content-type', 'text/plain');
      res.end('ok');
    });
    await fetch(`${proxyBase}/api/fetch-proxy`, {
      method: 'GET',
      headers: { 'x-target-url': upstreamUrl },
    });
    // Entry log + completion log.
    const logLines = logger.log.mock.calls.map((c) => c[0]).join('\n');
    expect(logLines).toContain(`GET ${upstreamUrl}`);
    expect(logLines).toContain(`← 200`);
  });

  it('warns when X-Target-URL is missing', async () => {
    await setup((_req, res) => res.end('ignored'));
    await fetch(`${proxyBase}/api/fetch-proxy`);
    expect(logger.warn.mock.calls.map((c) => c[0]).join('\n')).toContain('missing X-Target-URL');
  });

  it('errors when the upstream fetch throws', async () => {
    await setup((_req, res) => res.end('unused'));
    await fetch(`${proxyBase}/api/fetch-proxy`, {
      headers: { 'x-target-url': 'http://127.0.0.1:1/nope' },
    });
    const errLines = logger.error.mock.calls.map((c) => c[0]).join('\n');
    expect(errLines).toContain('← 502');
  });

  it('warns when a masked secret is rejected for an out-of-scope domain', async () => {
    await setup((_req, res) => res.end('should-not-reach'), 'api.github.com');
    await fetch(`${proxyBase}/api/fetch-proxy`, {
      headers: { 'x-target-url': upstreamUrl, authorization: `Bearer ${masked}` },
    });
    expect(logger.warn.mock.calls.map((c) => c[0]).join('\n')).toContain('not allowed');
  });

  it('strips upstream access-control-* headers so the bridge owns CORS', async () => {
    // Regression: an upstream that emits its own CORS headers (e.g. HF
    // hub returning `access-control-allow-origin: *`) would
    // `res.setHeader`-clobber the bridge middleware's authoritative
    // ACAO, leaving the browser with an opaque `TypeError: Failed to
    // fetch`. The route must drop the whole access-control-* family.
    await setup((_req, res) => {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-credentials', 'true');
      res.setHeader('access-control-allow-methods', 'GET, POST');
      res.setHeader('access-control-expose-headers', 'X-Custom');
      res.setHeader('access-control-max-age', '600');
      res.setHeader('content-type', 'text/plain');
      res.end('ok');
    });
    const res = await fetch(`${proxyBase}/api/fetch-proxy`, {
      headers: { 'x-target-url': upstreamUrl },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    expect(res.headers.get('access-control-allow-methods')).toBeNull();
    expect(res.headers.get('access-control-expose-headers')).toBeNull();
    expect(res.headers.get('access-control-max-age')).toBeNull();
  });

  it('strips the thin-bridge auth header before forwarding upstream', async () => {
    // Regression: the bridge token authenticates the browser->local hop
    // (validated by `createThinBridgeCorsMiddleware`); if it leaks onward
    // to `targetUrl` a hostile or curious upstream can replay it. The
    // route must filter `x-bridge-token` out of the forwarded headers
    // alongside the other proxy-internal markers.
    let receivedHeaders: Record<string, string | string[] | undefined> = {};
    await setup((req, res) => {
      receivedHeaders = req.headers;
      res.setHeader('content-type', 'text/plain');
      res.end('ok');
    });
    const res = await fetch(`${proxyBase}/api/fetch-proxy`, {
      headers: {
        'x-target-url': upstreamUrl,
        'x-bridge-token': 'secret-token',
      },
    });
    expect(res.status).toBe(200);
    expect(receivedHeaders['x-bridge-token']).toBeUndefined();
  });
});
