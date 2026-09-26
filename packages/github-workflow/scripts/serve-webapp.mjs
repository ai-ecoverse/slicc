#!/usr/bin/env node

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { isMain } from './gh-io.mjs';
import { PRODUCTION_TRAY_ORIGIN } from './lib.mjs';

export const PIN_PROBE_PATH = '/__slicc_pin';

const FORWARD_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'content-type',
  'if-none-match',
  'if-modified-since',
];

const FORWARD_RESPONSE_HEADERS = ['content-type', 'cache-control', 'etag', 'vary', 'link'];

const WORKER_EXACT = new Set([
  '/status',
  '/privacy',
  '/llms.txt',
  '/handoff',
  '/tray',
  '/trays',
  '/session',
  '/cloud',
  '/install-cli',
  '/install-cli.ps1',
]);

const WORKER_PREFIXES = [
  '/api/',
  '/.well-known/',
  '/auth/',
  '/oauth/',
  '/download/',
  '/rel/',
  '/wh/',
  '/webhooks/',
  '/cloud/',
];

const MAX_PROXY_BODY = 16 * 1024 * 1024;

export function isWorkerRoute(pathname) {
  if (pathname.startsWith('/assets/')) return false;
  if (WORKER_EXACT.has(pathname)) return true;
  return WORKER_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function proxyRequestHeaders(headers) {
  const out = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = headers[name];
    if (typeof value === 'string' && value) out.set(name, value);
    else if (Array.isArray(value) && value.length) out.set(name, value.join(', '));
  }
  return out;
}

const MIME = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  map: 'application/json',
  wasm: 'application/wasm',
  svg: 'image/svg+xml',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
};

export function mimeForFile(filePath) {
  const ext = extname(filePath).slice(1).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

export function resolveWebappFile(root, urlPath) {
  const base = resolve(root);
  let pathname = '/';
  try {
    pathname = decodeURIComponent(new URL(urlPath, 'http://localhost').pathname);
  } catch {
    return { status: 400 };
  }
  const rel = pathname.replace(/^\/+/, '');
  const full = resolve(base, rel);
  if (full !== base && !full.startsWith(base + sep)) return { status: 403 };
  if (rel && existsSync(full) && statSync(full).isFile()) return { status: 200, file: full };
  if (rel.startsWith('assets/')) return { status: 404 };
  const index = join(base, 'index.html');
  if (!existsSync(index)) return { status: 404 };
  return { status: 200, file: index, spa: true };
}

async function fetchOnUpstream(upstream, start, init, fetchImpl) {
  const origin = new URL(upstream).origin;
  let current = start;
  let response = await fetchImpl(current, init);
  for (let hop = 0; hop < 3; hop += 1) {
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    const next = new URL(location, current);
    if (next.origin !== origin) return response;
    current = next.toString();
    const method = response.status === 303 ? 'GET' : init.method;
    response = await fetchImpl(current, {
      ...init,
      method,
      body: method === 'GET' ? undefined : init.body,
    });
  }
  return response;
}

export async function proxyWorkerRequest(req, upstream, fetchImpl) {
  const incoming = new URL(req.url ?? '/', 'http://localhost');
  const target = new URL(incoming.pathname + incoming.search, upstream);
  const init = {
    method: req.method ?? 'GET',
    headers: proxyRequestHeaders(req.headers),
    redirect: 'manual',
  };
  if (init.method !== 'GET' && init.method !== 'HEAD') {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_PROXY_BODY) {
        return {
          status: 413,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          body: Buffer.from('payload too large'),
        };
      }
      chunks.push(chunk);
    }
    init.body = Buffer.concat(chunks);
  }
  const response = await fetchOnUpstream(upstream, target.toString(), init, fetchImpl);
  const headers = {};
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  const body = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers, body };
}

export function createWebappHandler(root, options = {}) {
  const upstream = options.upstream ?? PRODUCTION_TRAY_ORIGIN;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const identity = options.identity ?? '';
  return (req, res) => {
    void handleWebappRequest(req, res, root, upstream, fetchImpl, identity).catch(() => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('bad gateway');
    });
  };
}

async function handleWebappRequest(req, res, root, upstream, fetchImpl, identity) {
  let pathname = '/';
  try {
    pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad request');
    return;
  }
  if (pathname === PIN_PROBE_PATH) {
    if (!identity || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : identity);
    return;
  }
  if (isWorkerRoute(pathname)) {
    const proxied = await proxyWorkerRequest(req, upstream, fetchImpl);
    res.writeHead(proxied.status, proxied.headers);
    res.end(proxied.body);
    return;
  }
  const target = resolveWebappFile(root, req.url ?? '/');
  if (!target.file) {
    res.writeHead(target.status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(target.status === 404 ? 'not found' : 'bad request');
    return;
  }
  const headers = {
    'content-type': mimeForFile(target.file),
    'cache-control': target.spa ? 'no-store' : 'public, max-age=31536000, immutable',
  };

  if (target.spa) headers['document-isolation-policy'] = 'isolate-and-credentialless';
  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end();
    return;
  }
  const stream = createReadStream(target.file);

  /* v8 ignore start */
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  /* v8 ignore stop */
  res.writeHead(200, headers);
  stream.pipe(res);
}

export function listenWebapp(root, port, options = {}) {
  const handler = createWebappHandler(root, options);
  const v4 = createServer(handler);
  const v6 = createServer(handler);
  const close = () => Promise.all([closeServer(v4), closeServer(v6)]).then(() => undefined);
  return new Promise((resolvePromise, reject) => {
    const fail = (err) => {
      void close();
      reject(err);
    };
    v4.once('error', fail);
    v4.listen(port, '127.0.0.1', () => {
      const bound = v4.address().port;
      v6.once('error', (err) => {
        if (err?.code === 'EADDRINUSE' || err?.code === 'EACCES') fail(err);
        else resolvePromise({ port: bound, close });
      });
      v6.listen(bound, '::1', () => resolvePromise({ port: bound, close }));
    });
  });
}

function closeServer(server) {
  return new Promise((resolvePromise) => {
    if (!server.listening) {
      resolvePromise();
      return;
    }
    server.close(() => resolvePromise());
  });
}

export function parseServeArgs(argv) {
  let root = '';
  let port = Number.NaN;
  let upstream = PRODUCTION_TRAY_ORIGIN;
  let identity = '';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') {
      root = argv[i + 1] ?? '';
      i += 1;
    } else if (argv[i] === '--port') {
      port = Number(argv[i + 1]);
      i += 1;
    } else if (argv[i] === '--upstream') {
      upstream = argv[i + 1] ?? '';
      i += 1;
    } else if (argv[i] === '--identity') {
      identity = argv[i + 1] ?? '';
      i += 1;
    }
  }
  if (!root || !Number.isInteger(port) || port < 1 || port > 65535 || !upstream) {
    throw new Error(
      'usage: serve-webapp.mjs --root <dist/ui> --port <port> [--upstream <origin>] [--identity <token>]'
    );
  }
  return { root: resolve(root), port, upstream: upstream.replace(/\/+$/, ''), identity };
}

/* v8 ignore start */
if (isMain(import.meta.url)) {
  const { root, port, upstream, identity } = parseServeArgs(process.argv.slice(2));
  listenWebapp(root, port, { upstream, identity })
    .then(() => {
      console.log(`[pin-webapp] serving ${root} at http://localhost:${port}`);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
/* v8 ignore stop */
