import { mkdtemp, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cachePathFor, createMirrorServer, parseArgs } from './hf-cache-mirror.mjs';

/** A fake huggingface.co: counts hits, redirects weights to a "CDN" path like the real one. */
function startUpstream() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/api/models/acme/kokoro/tree/main?recursive=true') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ type: 'file', path: 'config.json', size: 2 }]));
    } else if (req.url === '/acme/kokoro/resolve/main/onnx/model.onnx') {
      res.writeHead(302, { location: '/cdn/blob-1' });
      res.end();
    } else if (req.url === '/cdn/blob-1') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.from([1, 2, 3, 4, 5]));
    } else if (req.url === '/acme/kokoro/resolve/main/onnx/truncated.onnx') {
      // Announce a 200 with more bytes than we deliver, then drop the socket:
      // the mirror's store must fail, clean up its temp file, and not cache.
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '1000' });
      res.write(Buffer.from([9, 9, 9]));
      setTimeout(() => res.destroy(), 20);
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('nope');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, hits, url: `http://127.0.0.1:${server.address().port}` })
    );
  });
}

describe('hf-cache-mirror', () => {
  let upstream;
  let mirror;
  let dir;
  let base;

  beforeAll(async () => {
    upstream = await startUpstream();
    dir = await mkdtemp(join(tmpdir(), 'hf-mirror-'));
    mirror = createMirrorServer({ dir, upstream: upstream.url });
    await new Promise((resolve) => mirror.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${mirror.address().port}`;
  });

  afterAll(async () => {
    mirror.close();
    upstream.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('parses arguments and rejects unknown ones', () => {
    expect(parseArgs(['--port', '9000', '--dir', 'x', '--upstream', 'http://u/'])).toEqual({
      port: 9000,
      dir: 'x',
      upstream: 'http://u',
      readyFile: null,
    });
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--port', 'abc'])).toThrow(/invalid --port/);
  });

  it('shards cache keys by path', () => {
    const p = cachePathFor('/c', '/a/resolve/main/x');
    expect(p.startsWith('/c/')).toBe(true);
    expect(p).not.toBe(cachePathFor('/c', '/a/resolve/main/y'));
  });

  it('fetches a weight through the redirect once, then serves it from disk', async () => {
    const first = await fetch(`${base}/acme/kokoro/resolve/main/onnx/model.onnx`);
    expect(first.status).toBe(200);
    expect(first.headers.get('x-hf-mirror')).toBe('miss');
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]));

    const second = await fetch(`${base}/acme/kokoro/resolve/main/onnx/model.onnx`);
    expect(second.headers.get('x-hf-mirror')).toBe('hit');
    expect(second.headers.get('content-length')).toBe('5');
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect(upstream.hits.filter((h) => h.includes('model.onnx'))).toHaveLength(1);

    const head = await fetch(`${base}/acme/kokoro/resolve/main/onnx/model.onnx`, {
      method: 'HEAD',
    });
    expect(head.status).toBe(200);
    expect(head.headers.get('x-hf-mirror')).toBe('hit');
  });

  it('caches tree listings too', async () => {
    const path = '/api/models/acme/kokoro/tree/main?recursive=true';
    expect(await (await fetch(`${base}${path}`)).json()).toEqual([
      { type: 'file', path: 'config.json', size: 2 },
    ]);
    const again = await fetch(`${base}${path}`);
    expect(again.headers.get('x-hf-mirror')).toBe('hit');
    expect(upstream.hits.filter((h) => h === path)).toHaveLength(1);
  });

  it('relays upstream errors without storing them', async () => {
    const res = await fetch(`${base}/acme/missing/resolve/main/x`);
    expect(res.status).toBe(404);
    expect(res.headers.get('x-hf-mirror')).toBe('bypass');
    const again = await fetch(`${base}/acme/missing/resolve/main/x`);
    expect(again.status).toBe(404);
    expect(upstream.hits.filter((h) => h.includes('missing'))).toHaveLength(2);
    const entries = await readdir(dir, { recursive: true });
    expect(entries.some((e) => e.includes('.part-'))).toBe(false);
  });

  it('drops the temp file and caches nothing when the upstream body dies mid-download', async () => {
    const path = '/acme/kokoro/resolve/main/onnx/truncated.onnx';
    const res = await fetch(`${base}${path}`);
    expect(res.status).toBe(502);
    expect(res.headers.get('x-hf-mirror')).toBe('store-error');
    const entries = await readdir(dir, { recursive: true });
    expect(entries.some((e) => e.includes('.part-'))).toBe(false);
    const key = cachePathFor(dir, path).slice(dir.length + 1);
    expect(entries).not.toContain(key);
    expect(entries).not.toContain(`${key}.json`);
    // A later request goes back upstream rather than serving a ghost entry.
    const again = await fetch(`${base}${path}`);
    expect(again.status).toBe(502);
    expect(upstream.hits.filter((h) => h === path)).toHaveLength(2);
  });

  it('rejects non-GET methods', async () => {
    const res = await fetch(`${base}/acme/kokoro/resolve/main/onnx/model.onnx`, { method: 'POST' });
    expect(res.status).toBe(405);
  });
});
