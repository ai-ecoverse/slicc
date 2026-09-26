import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listenWebapp, parseServeArgs, resolveWebappFile } from './serve-webapp.mjs';

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
});
