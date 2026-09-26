#!/usr/bin/env node
/**
 * Serve one sliccy package's `dist/ui` on loopback.
 *
 * node-server serves no UI. A benchmark that opts into `pin-webapp` points
 * Chrome here so the agent is the webapp shipped in that npm version, not
 * whatever production sliccy.ai is serving at boot time. The tray hub stays
 * on the worker (`SLICC_TRAY_WORKER_BASE_URL`); this process only serves
 * files.
 *
 * HTML responses carry the same `Document-Isolation-Policy` the worker sets,
 * so the pinned page gets SharedArrayBuffer the way production does.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { isMain } from './gh-io.mjs';

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

/** @param {string} filePath */
export function mimeForFile(filePath) {
  const ext = extname(filePath).slice(1).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

/**
 * Map a request path onto a file inside `root`, or onto `index.html` for
 * the SPA shell. Hashed `/assets/*` misses stay 404s so a broken package
 * does not come back as HTML.
 *
 * @param {string} root
 * @param {string} urlPath pathname plus optional query
 * @returns {{ status: number; file?: string; spa?: boolean }}
 */
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

/**
 * @param {string} root
 * @returns {import('node:http').RequestListener}
 */
export function createWebappHandler(root) {
  return (req, res) => {
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
    // Same isolation the worker applies to the SPA document. Assets do not
    // need it; the document policy covers the page and its workers.
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
    stream.on('error', () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    res.writeHead(200, headers);
    stream.pipe(res);
  };
}

/**
 * Listen on 127.0.0.1 and, when the stack has it, ::1. Chrome may resolve
 * `localhost` to either. Returns a close function.
 *
 * @param {string} root
 * @param {number} port
 */
export function listenWebapp(root, port) {
  const handler = createWebappHandler(root);
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
        // No IPv6 loopback (common in some containers). A port conflict is
        // fatal: macOS Chrome resolves localhost to ::1 first.
        const code = err?.code;
        if (code === 'EADDRINUSE' || code === 'EACCES') fail(err);
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

/**
 * @param {string[]} argv
 * @returns {{ root: string; port: number }}
 */
export function parseServeArgs(argv) {
  let root = '';
  let port = Number.NaN;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') {
      root = argv[i + 1] ?? '';
      i += 1;
    } else if (argv[i] === '--port') {
      port = Number(argv[i + 1]);
      i += 1;
    }
  }
  if (!root || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('usage: serve-webapp.mjs --root <dist/ui> --port <port>');
  }
  return { root: resolve(root), port };
}

/* v8 ignore start */
if (isMain(import.meta.url)) {
  const { root, port } = parseServeArgs(process.argv.slice(2));
  listenWebapp(root, port)
    .then(() => {
      console.log(`[pin-webapp] serving ${root} at http://localhost:${port}`);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
/* v8 ignore stop */
