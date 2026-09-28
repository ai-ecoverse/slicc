/**
 * Raw mode of `/api/fetch-proxy` (#3571), driven end-to-end: a real Express
 * app with both handlers mounted (raw first, as `index.ts` does), a live
 * upstream, and a real `SecretProxyManager`. Every response is read back with
 * the shared frame decoder the webapp uses.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  decodeRawResponseFrame,
  encodeRawRequestHead,
  RAW_FETCH_CONTENT_TYPE,
  RAW_FETCH_REQUEST_HEADER,
  type RawFetchResponseHead,
  type RawHeaderList,
} from '@slicc/shared-ts';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { shouldParseGlobalJson } from '../../src/fetch-proxy-headers.js';
import { AgentActivityTracker } from '../../src/routes/agent-activity.js';
import { registerFetchProxyRoute } from '../../src/routes/fetch-proxy.js';
import { registerRawFetchProxyRoute } from '../../src/routes/fetch-proxy-raw.js';
import { EnvSecretStore } from '../../src/secrets/env-secret-store.js';
import { SecretProxyManager } from '../../src/secrets/proxy-manager.js';

const TOKEN = 'ghp_rawmode0123456789abcdefghijk';
const quiet = { log: () => {}, warn: () => {}, error: () => {} };

interface Harness {
  origin: string;
  bridge: string;
  masked: string;
  activity: AgentActivityTracker;
  seen: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: Buffer }>;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function serve(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

async function harness(
  respond: (req: IncomingMessage, res: ServerResponse) => void,
  options: { secretDomains?: string; maxRequestBodyBytes?: number } = {}
): Promise<Harness> {
  const seen: Harness['seen'] = [];
  const upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      respond(req, res);
    });
  });
  const origin = await serve(upstream);

  const dir = join(tmpdir(), `slicc-raw-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'secrets.env');
  writeFileSync(
    file,
    `GITHUB_TOKEN=${TOKEN}\nGITHUB_TOKEN_DOMAINS=${options.secretDomains ?? '127.0.0.1'}\n`,
    { mode: 0o600 }
  );
  const secretProxy = new SecretProxyManager(new EnvSecretStore(file), 'raw-session');
  await secretProxy.reload();
  const masked = secretProxy.getMaskedEntries()[0]!.maskedValue;

  const app = express();
  app.use(express.json({ limit: '50mb', type: shouldParseGlobalJson }));
  const activity = new AgentActivityTracker();
  registerRawFetchProxyRoute(app, {
    secretProxy,
    activityTracker: activity,
    logger: quiet,
    maxRequestBodyBytes: options.maxRequestBodyBytes,
  });
  registerFetchProxyRoute(app, { secretProxy, activityTracker: activity, logger: quiet });
  const bridge = await serve(createServer(app));
  return { origin, bridge, masked, activity, seen };
}

interface RawResult {
  status: number;
  contentType: string | null;
  head: RawFetchResponseHead;
  body: Buffer;
}

async function rawFetch(
  h: Harness,
  url: string,
  init: { method?: string; headers?: RawHeaderList; body?: Uint8Array | string } = {}
): Promise<RawResult> {
  const resp = await fetch(`${h.bridge}/api/fetch-proxy`, {
    method: 'POST',
    headers: {
      [RAW_FETCH_REQUEST_HEADER]: encodeRawRequestHead({
        url,
        method: init.method ?? 'GET',
        headers: init.headers ?? [],
      }),
      'Content-Type': 'application/octet-stream',
    },
    body: init.body,
  });
  const bytes = new Uint8Array(await resp.arrayBuffer());
  if (resp.headers.get('x-proxy-error') === '1') {
    throw Object.assign(new Error(new TextDecoder().decode(bytes)), { status: resp.status });
  }
  const split = decodeRawResponseFrame(bytes);
  if (!split) throw new Error('incomplete raw frame');
  return {
    status: resp.status,
    contentType: resp.headers.get('content-type'),
    head: split.head,
    body: Buffer.from(split.rest),
  };
}

function values(headers: RawHeaderList, name: string): string[] {
  return headers.filter(([n]) => n.toLowerCase() === name).map(([, v]) => v);
}

describe('raw /api/fetch-proxy', () => {
  it('hands the 3xx, Location and every Set-Cookie to the caller instead of following', async () => {
    const h = await harness((req, res) => {
      if (req.url === '/next') {
        res.end('followed');
        return;
      }
      res.writeHead(302, [
        ['Location', '/next'],
        ['Set-Cookie', 'a=1; Path=/'],
        ['Set-Cookie', 'b=2; HttpOnly'],
        ['Link', '</x>; rel=preload'],
        ['Link', '</y>; rel=preload'],
      ]);
      res.end('moved');
    });
    const result = await rawFetch(h, `${h.origin}/start`);
    expect(result.status).toBe(200);
    expect(result.contentType).toBe(RAW_FETCH_CONTENT_TYPE);
    expect(result.head.status).toBe(302);
    expect(result.head.url).toBe(`${h.origin}/start`);
    expect(values(result.head.headers, 'location')).toEqual(['/next']);
    expect(values(result.head.headers, 'set-cookie')).toEqual(['a=1; Path=/', 'b=2; HttpOnly']);
    expect(values(result.head.headers, 'link')).toEqual(['</x>; rel=preload, </y>; rel=preload']);
    expect(result.body.toString()).toBe('moved');
    expect(h.seen.map((s) => s.url)).toEqual(['/start']);
    expect(h.activity.isActiveInLastMinute()).toBe(true);
  });

  it('still follows redirects on the default route', async () => {
    const h = await harness((req, res) => {
      if (req.url === '/next') res.end('followed');
      else res.writeHead(302, { Location: '/next' }).end();
    });
    const resp = await fetch(`${h.bridge}/api/fetch-proxy`, {
      headers: { 'X-Target-URL': `${h.origin}/start` },
    });
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe('followed');
  });

  it('sends the caller method, headers and binary body, not the hop’s', async () => {
    const h = await harness((_req, res) => res.writeHead(201).end());
    const body = new Uint8Array([0, 0xff, 0xd8, 0x80, 0x0a]);
    const result = await rawFetch(h, `${h.origin}/upload`, {
      method: 'PROPFIND',
      headers: [
        ['User-Agent', 'curl/8.22.0'],
        ['Cookie', 'a=1'],
        ['Cookie', 'b=2'],
        ['Accept-Encoding', 'zstd'],
        ['Connection', 'X-Hop'],
        ['X-Hop', 'drop me'],
        ['Content-Type', 'application/octet-stream'],
      ],
      body,
    });
    expect(result.head.status).toBe(201);
    expect(result.body.byteLength).toBe(0);
    const [seen] = h.seen;
    expect(seen?.method).toBe('PROPFIND');
    expect(seen?.headers['user-agent']).toBe('curl/8.22.0');
    expect(seen?.headers.cookie).toBe('a=1; b=2');
    expect(seen?.headers['accept-encoding']).toBe('gzip, deflate, br');
    expect(seen?.headers['x-hop']).toBeUndefined();
    expect(seen?.headers['x-slicc-raw-request']).toBeUndefined();
    expect(seen?.headers.origin).toBeUndefined();
    expect([...(seen?.body ?? [])]).toEqual([...body]);
  });

  it('delivers a gzip body decoded, with Content-Encoding and Content-Length removed', async () => {
    const text = 'hello raw mode\n'.repeat(100);
    const gz = gzipSync(text);
    const h = await harness((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Encoding': 'gzip',
        'Content-Length': String(gz.byteLength),
      });
      res.end(gz);
    });
    const result = await rawFetch(h, `${h.origin}/gz`);
    expect(result.body.toString()).toBe(text);
    expect(values(result.head.headers, 'content-encoding')).toEqual([]);
    expect(values(result.head.headers, 'content-length')).toEqual([]);
  });

  it('inflates undeclared gzip text after the head frame is out (#3037 shape)', async () => {
    const text = 'export const aem = 1;\n';
    const gz = gzipSync(text);
    const h = await harness((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/javascript',
        'Content-Length': String(gz.byteLength),
      });
      res.end(gz);
    });
    const result = await rawFetch(h, `${h.origin}/cached.js`);
    expect(result.body.toString()).toBe(text);
    expect(values(result.head.headers, 'content-length')).toEqual([]);
  });

  it('keeps Content-Length on an identity binary body and passes its bytes exactly', async () => {
    const bytes = Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 7) % 256));
    const h = await harness((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(bytes.byteLength),
      });
      res.end(bytes);
    });
    const result = await rawFetch(h, `${h.origin}/bin`);
    expect(values(result.head.headers, 'content-length')).toEqual([String(bytes.byteLength)]);
    expect(result.body.equals(bytes)).toBe(true);
  });

  it('keeps the representation headers of a HEAD response', async () => {
    const h = await harness((_req, res) => {
      res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': '1234' });
      res.end();
    });
    const result = await rawFetch(h, `${h.origin}/head`, { method: 'HEAD' });
    expect(values(result.head.headers, 'content-encoding')).toEqual(['gzip']);
    expect(values(result.head.headers, 'content-length')).toEqual(['1234']);
    expect(result.body.byteLength).toBe(0);
  });

  it('unmasks a secret for an allowed domain and scrubs it from Location and the body', async () => {
    const h = await harness((req, res) => {
      res.writeHead(302, {
        Location: `/cb?token=${TOKEN}`,
        'Content-Type': 'text/plain',
      });
      res.end(`echo ${req.headers.authorization}`);
    });
    const result = await rawFetch(h, `${h.origin}/auth`, {
      headers: [['Authorization', `Bearer ${h.masked}`]],
    });
    expect(h.seen[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(values(result.head.headers, 'location')).toEqual([`/cb?token=${h.masked}`]);
    expect(result.body.toString()).toBe(`echo Bearer ${h.masked}`);
  });

  it('signs the body for x-slicc-hmac-sign and never forwards the directive', async () => {
    const h = await harness((_req, res) => res.end('ok'));
    await rawFetch(h, `${h.origin}/hook`, {
      method: 'POST',
      headers: [
        ['Content-Type', 'application/json'],
        ['X-Slicc-Hmac-Sign', 'GITHUB_TOKEN:x-signature'],
      ],
      body: '{"a":1}',
    });
    const expected = createHmac('sha256', TOKEN).update('{"a":1}').digest('hex');
    expect(h.seen[0]?.headers['x-signature']).toBe(expected);
    expect(h.seen[0]?.headers['x-slicc-hmac-sign']).toBeUndefined();
    expect(h.seen[0]?.body.toString()).toBe('{"a":1}');
  });

  it('keeps raw uploads away from the global JSON parser', () => {
    const req = { headers: { 'content-type': 'application/json', 'x-slicc-raw-request': '{}' } };
    expect(shouldParseGlobalJson(req as never)).toBe(false);
  });

  it('refuses a secret on a domain it is not scoped to', async () => {
    const h = await harness((_req, res) => res.end('should not be reached'), {
      secretDomains: 'api.github.com',
    });
    await expect(
      rawFetch(h, `${h.origin}/steal`, { headers: [['Authorization', `Bearer ${h.masked}`]] })
    ).rejects.toMatchObject({ status: 403 });
    expect(h.seen).toHaveLength(0);
  });

  it('answers 413 past the request-body limit without contacting upstream', async () => {
    const h = await harness((_req, res) => res.end('nope'), { maxRequestBodyBytes: 8 });
    await expect(
      rawFetch(h, `${h.origin}/big`, { method: 'PUT', body: new Uint8Array(9) })
    ).rejects.toMatchObject({ status: 413 });
    expect(h.seen).toHaveLength(0);
  });

  it('answers the capability probe without contacting upstream', async () => {
    const h = await harness((_req, res) => res.end());
    const resp = await fetch(`${h.bridge}/api/fetch-proxy`, {
      method: 'POST',
      headers: { 'X-Slicc-Raw-Probe': '1' },
    });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      rawFetch: 1,
      requestBodyStreaming: false,
      maxRequestBodyBytes: 256 * 1024 * 1024,
    });
    expect(h.seen).toHaveLength(0);
    expect(h.activity.isActiveInLastMinute()).toBe(false);
  });

  it('drops upstream fields named by Connection from the head', async () => {
    const h = await harness((_req, res) => {
      res.writeHead(200, [
        ['Connection', 'X-Hop'],
        ['X-Hop', 'hop-local'],
        ['X-End', 'kept'],
      ]);
      res.end();
    });
    const result = await rawFetch(h, `${h.origin}/hop`);
    expect(values(result.head.headers, 'x-hop')).toEqual([]);
    expect(values(result.head.headers, 'x-end')).toEqual(['kept']);
  });

  it('rejects a malformed request head and an unreachable upstream', async () => {
    const h = await harness((_req, res) => res.end());
    const malformed = await fetch(`${h.bridge}/api/fetch-proxy`, {
      method: 'POST',
      headers: { [RAW_FETCH_REQUEST_HEADER]: '{"url":1}' },
    });
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get('x-proxy-error')).toBe('1');
    await expect(rawFetch(h, 'http://127.0.0.1:1/unreachable')).rejects.toMatchObject({
      status: 502,
    });
  });

  it('streams a slow body chunk by chunk', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await harness((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.write('first');
      void gate.then(() => res.end('second'));
    });
    const resp = await fetch(`${h.bridge}/api/fetch-proxy`, {
      method: 'POST',
      headers: {
        [RAW_FETCH_REQUEST_HEADER]: encodeRawRequestHead({
          url: `${h.origin}/slow`,
          method: 'GET',
          headers: [],
        }),
      },
    });
    const reader = resp.body!.getReader();
    let buffered = new Uint8Array(0);
    let split: ReturnType<typeof decodeRawResponseFrame> = null;
    while (!split || new TextDecoder().decode(split.rest) !== 'first') {
      const { value } = await reader.read();
      buffered = new Uint8Array([...buffered, ...(value ?? [])]);
      split = decodeRawResponseFrame(buffered);
    }
    expect(split.head.status).toBe(200);
    release();
    let tail = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      tail += new TextDecoder().decode(value);
    }
    expect(tail).toBe('second');
  });
});
