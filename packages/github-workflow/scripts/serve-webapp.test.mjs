import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createWebappHandler,
  listenWebapp,
  parseServeArgs,
  proxyWorkerRequest,
  resolveWebappFile,
} from './serve-webapp.mjs';

describe('serve-webapp', () => {
  const roots = [];
  const closers = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'pin-webapp-'));
    roots.push(root);
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>ui</title>');
    writeFileSync(join(root, 'assets', 'app.js'), 'export {}');
    return root;
  }

  it('serves the SPA shell, assets, and refuses to leave the root', () => {
    const root = fixture();
    expect(resolveWebappFile(root, '/').file).toMatch(/index\.html$/);
    expect(resolveWebappFile(root, '/nope').spa).toBe(true);
    expect(resolveWebappFile(root, '/assets/app.js').file).toMatch(/app\.js$/);
    expect(resolveWebappFile(root, '/assets/missing.js').status).toBe(404);
    expect(resolveWebappFile(root, `/${encodeURIComponent('../etc/passwd')}`).status).toBe(403);
    expect(resolveWebappFile(root, '/%').status).toBe(400);
    expect(resolveWebappFile(join(root, 'empty'), '/').status).toBe(404);
    expect(() => parseServeArgs(['--root', root, '--port', '0'])).toThrow(/usage/);
    expect(parseServeArgs(['--root', root, '--port', '8080'])).toMatchObject({ port: 8080 });
  });

  it('answers on loopback with the production isolation header', async () => {
    const root = fixture();
    const server = await listenWebapp(root, 0);
    closers.push(server.close);
    const page = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('document-isolation-policy')).toBe('isolate-and-credentialless');
    expect(await page.text()).toContain('<title>ui</title>');
    const asset = await fetch(`http://127.0.0.1:${server.port}/assets/app.js`);
    expect(asset.headers.get('content-type')).toContain('javascript');
    const missing = await fetch(`http://127.0.0.1:${server.port}/assets/nope.js`);
    expect(missing.status).toBe(404);
    const head = await fetch(`http://127.0.0.1:${server.port}/`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('document-isolation-policy')).toBe('isolate-and-credentialless');
    const posted = await fetch(`http://127.0.0.1:${server.port}/`, { method: 'POST' });
    expect(posted.status).toBe(405);
    writeFileSync(join(root, 'blob.bin'), 'x');
    const blob = await fetch(`http://127.0.0.1:${server.port}/blob.bin`);
    expect(blob.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('refuses the port when IPv6 loopback is already taken', async () => {
    const root = fixture();
    const blocker = createServer();
    await new Promise((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '::1', () => resolve());
    });
    const port = blocker.address().port;
    await expect(listenWebapp(root, port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await new Promise((resolve) => blocker.close(() => resolve()));
  });

  it('proxies worker routes and keeps static files local', async () => {
    const root = fixture();
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({
        url: String(url),
        method: init.method,
        headers: Object.fromEntries(init.headers.entries()),
      });
      const path = new URL(url).pathname;
      if (path === '/api/missing') {
        return new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } });
      }
      return new Response(
        JSON.stringify({ float: 'hosted-leader', flags: { 'live-model-catalog': 'on' } }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'set-cookie': 'session=from-upstream',
            etag: '"flags"',
          },
        }
      );
    };
    const server = await listenWebapp(root, 0, {
      upstream: 'https://upstream.example',
      fetchImpl,
    });
    closers.push(server.close);
    const flags = await fetch(`http://127.0.0.1:${server.port}/api/flags?float=hosted-leader`, {
      headers: {
        accept: 'application/json',
        cookie: 'local=1',
        authorization: 'Bearer local-token',
      },
    });
    expect(flags.status).toBe(200);
    expect(flags.headers.get('set-cookie')).toBeNull();
    expect(flags.headers.get('etag')).toBe('"flags"');
    expect(await flags.json()).toMatchObject({ flags: { 'live-model-catalog': 'on' } });
    expect(calls[0].url).toBe('https://upstream.example/api/flags?float=hosted-leader');
    expect(calls[0].headers.accept).toBe('application/json');
    expect(calls[0].headers.cookie).toBeUndefined();
    expect(calls[0].headers.authorization).toBeUndefined();

    const missing = await fetch(`http://127.0.0.1:${server.port}/api/missing`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('nope');

    const page = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(await page.text()).toContain('<title>ui</title>');
    const asset = await fetch(`http://127.0.0.1:${server.port}/assets/nope.js`);
    expect(asset.status).toBe(404);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(['/api/flags', '/api/missing']);
  });

  it('follows an upstream redirect only while it stays on that origin', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push(`${init.method} ${url}`);
      const path = new URL(url).pathname;
      if (path === '/api/start') {
        return new Response(null, { status: 302, headers: { location: '/api/next' } });
      }
      if (path === '/api/next') {
        return new Response(null, { status: 303, headers: { location: '/api/done' } });
      }
      if (path === '/api/done') return new Response('done', { status: 200 });
      if (path === '/api/away') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example/steal' },
        });
      }
      if (path === '/api/bare') return new Response(null, { status: 302 });
      return new Response(null, { status: 302, headers: { location: '/api/loop' } });
    };
    const req = (url, method = 'GET') => ({
      url,
      method,
      headers: { accept: 'application/json' },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('body');
      },
    });
    const followed = await proxyWorkerRequest(
      req('/api/start', 'POST'),
      'https://upstream.example',
      fetchImpl
    );
    expect(followed.status).toBe(200);
    expect(followed.body.toString()).toBe('done');
    expect(seen[0]).toBe('POST https://upstream.example/api/start');
    expect(seen[1]).toBe('POST https://upstream.example/api/next');
    expect(seen[2]).toBe('GET https://upstream.example/api/done');
    const away = await proxyWorkerRequest(req('/api/away'), 'https://upstream.example', fetchImpl);
    expect(away.status).toBe(302);
    expect(seen.some((line) => line.includes('evil.example'))).toBe(false);
    const bare = await proxyWorkerRequest(req('/api/bare'), 'https://upstream.example', fetchImpl);
    expect(bare.status).toBe(302);
    const loop = await proxyWorkerRequest(req('/api/loop'), 'https://upstream.example', fetchImpl);
    expect(loop.status).toBe(302);
  });

  it('turns a worker failure into a bad gateway and rejects a bad request target', async () => {
    const root = fixture();
    const handler = createWebappHandler(root, {
      upstream: 'https://upstream.example/',
      fetchImpl: async () => {
        throw new Error('upstream down');
      },
    });
    const res = { headersSent: false, status: 0, body: '' };
    res.writeHead = (status) => {
      res.status = status;
      res.headersSent = true;
    };
    res.end = (body) => {
      res.body = body;
    };
    handler({ url: '/api/flags', method: 'GET', headers: {} }, res);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(res.status).toBe(502);
    expect(res.body).toBe('bad gateway');

    const bad = { headersSent: false, status: 0, body: '' };
    bad.writeHead = (status) => {
      bad.status = status;
      bad.headersSent = true;
    };
    bad.end = (body) => {
      bad.body = body;
    };
    handler({ url: 'http://[', method: 'GET', headers: {} }, bad);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bad.status).toBe(400);
    expect(
      parseServeArgs(['--root', root, '--port', '8080', '--upstream', 'https://staging.example/'])
    ).toMatchObject({
      upstream: 'https://staging.example',
    });
  });
});
