#!/usr/bin/env node
/**
 * Tiny caching mirror for huggingface.co, for CI.
 *
 * Serves the same paths the `hf` shell command requests — `/api/models/...`
 * tree listings and `/<repo>/resolve/<rev>/<file>` downloads — from an
 * on-disk store, fetching from upstream (and following its CDN redirects)
 * on a miss. Point the virtual shell at it with `HF_ENDPOINT=http://127.0.0.1:<port>`
 * and persist `--dir` with `actions/cache`: the 92 MB of Kokoro weights the
 * speech e2e stages then come off local disk instead of the CDN.
 *
 * Zero dependencies, Node 22+. Only GET/HEAD; anything else is 405. Only
 * 200 upstream responses are stored; errors are relayed uncached so a
 * transient CDN failure never poisons the store.
 *
 * Usage:
 *   node packages/dev-tools/tools/hf-cache-mirror.mjs --port 8791 --dir .cache/hf-mirror
 *   node … --upstream http://127.0.0.1:9999   # tests: fake upstream
 *   node … --ready-file /tmp/mirror.ready       # written once listening
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const DEFAULT_UPSTREAM = 'https://huggingface.co';
/** Tree listings change as repos move; weights under a pinned revision do not. */
const LISTING_TTL_MS = 24 * 60 * 60 * 1000;

export function parseArgs(argv) {
  const opts = { port: 8791, dir: '.cache/hf-mirror', upstream: DEFAULT_UPSTREAM, readyFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--port') opts.port = Number(next());
    else if (a === '--dir') opts.dir = next();
    else if (a === '--upstream') opts.upstream = next().replace(/\/+$/, '');
    else if (a === '--ready-file') opts.readyFile = next();
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    throw new Error(`invalid --port: ${opts.port}`);
  }
  return opts;
}

/** Cache key for a request path: sha256 over the path+query, sharded by prefix. */
export function cachePathFor(dir, requestPath) {
  const hash = createHash('sha256').update(requestPath).digest('hex');
  return join(dir, hash.slice(0, 2), hash);
}

export function isListing(requestPath) {
  return requestPath.startsWith('/api/');
}

async function readMeta(file) {
  try {
    return JSON.parse(await readFile(`${file}.json`, 'utf8'));
  } catch {
    return null;
  }
}

async function serveFromDisk(res, file, meta, head, marker = 'hit') {
  const info = await stat(file);
  res.writeHead(200, {
    'content-type': meta.contentType,
    'content-length': String(info.size),
    'x-hf-mirror': marker,
  });
  if (head) {
    res.end();
    return;
  }
  await pipeline(createReadStream(file), res);
}

/**
 * Handle one request. Exported so the test can drive it without sockets.
 */
export async function handle(req, res, opts, fetchImpl = fetch) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end();
    return;
  }
  const requestPath = req.url ?? '/';
  const file = cachePathFor(opts.dir, requestPath);
  const meta = await readMeta(file);
  const fresh = meta && (!isListing(requestPath) || Date.now() - meta.storedAt < LISTING_TTL_MS);
  if (fresh) {
    try {
      await serveFromDisk(res, file, meta, req.method === 'HEAD');
      return;
    } catch {
      // Sidecar without body (interrupted write) — fall through to upstream.
    }
  }

  let upstream;
  try {
    upstream = await fetchImpl(`${opts.upstream}${requestPath}`, {
      method: req.method,
      redirect: 'follow',
      headers: { 'user-agent': 'slicc-hf-cache-mirror' },
    });
  } catch (err) {
    res.writeHead(502, { 'content-type': 'text/plain', 'x-hf-mirror': 'upstream-error' });
    res.end(`upstream fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
  if (upstream.status !== 200 || !upstream.body) {
    res.writeHead(upstream.status, { 'content-type': contentType, 'x-hf-mirror': 'bypass' });
    res.end(req.method === 'HEAD' ? undefined : Buffer.from(await upstream.arrayBuffer()));
    return;
  }
  if (req.method === 'HEAD') {
    res.writeHead(200, { 'content-type': contentType, 'x-hf-mirror': 'miss' });
    res.end();
    return;
  }

  // Stream to disk first (atomic rename), then serve from the file, so a
  // client that disconnects mid-download cannot leave a truncated entry and
  // the bytes on disk are exactly what upstream sent.
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.part-${process.pid}-${Date.now()}`;
  try {
    await pipeline(upstream.body, createWriteStream(tmp));
    await rename(tmp, file);
    await writeFile(
      `${file}.json`,
      JSON.stringify({ contentType, storedAt: Date.now(), path: requestPath })
    );
  } catch (err) {
    await rm(tmp, { force: true });
    res.writeHead(502, { 'content-type': 'text/plain', 'x-hf-mirror': 'store-error' });
    res.end(`storing upstream body failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  await serveFromDisk(res, file, { contentType }, false, 'miss');
}

export function createMirrorServer(opts, fetchImpl = fetch) {
  return http.createServer((req, res) => {
    handle(req, res, opts, fetchImpl).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`mirror error: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await mkdir(opts.dir, { recursive: true });
  const server = createMirrorServer(opts);
  await new Promise((resolve) => server.listen(opts.port, '127.0.0.1', resolve));
  const { port } = server.address();
  console.log(
    `hf-cache-mirror listening on http://127.0.0.1:${port} (dir ${opts.dir}, upstream ${opts.upstream})`
  );
  if (opts.readyFile) await writeFile(opts.readyFile, String(port));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
