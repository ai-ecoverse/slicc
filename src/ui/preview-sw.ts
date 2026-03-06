/**
 * Preview Service Worker — intercepts /preview/* requests and serves VFS content.
 *
 * Built as a separate entry point (not bundled with the main app).
 * Reads directly from LightningFS IndexedDB (same DB as VirtualFS).
 */

/// <reference lib="webworker" />

import FS from '@isomorphic-git/lightning-fs';

const DB_NAME = 'slicc-fs';
let lfs: FS.PromisifiedFS | null = null;

function getLFS(): FS.PromisifiedFS {
  if (!lfs) {
    const fs = new FS(DB_NAME);
    lfs = fs.promises;
  }
  return lfs;
}

function getMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    html: 'text/html', htm: 'text/html',
    css: 'text/css',
    js: 'application/javascript', mjs: 'application/javascript',
    json: 'application/json',
    svg: 'image/svg+xml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
    mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm',
    pdf: 'application/pdf', txt: 'text/plain', xml: 'application/xml',
    wasm: 'application/wasm',
  };
  return map[ext] ?? 'application/octet-stream';
}

const TEXT_TYPES = new Set([
  'text/html', 'text/css', 'text/plain', 'application/javascript',
  'application/json', 'image/svg+xml', 'application/xml',
]);

async function handlePreviewRequest(vfsPath: string): Promise<Response> {
  try {
    const fs = getLFS();

    // Check if path is a directory → serve index.html
    try {
      const stat = await fs.stat(vfsPath);
      if (stat.isDirectory()) {
        vfsPath = vfsPath.endsWith('/') ? vfsPath + 'index.html' : vfsPath + '/index.html';
      }
    } catch { /* not a dir, continue */ }

    const mimeType = getMimeType(vfsPath);
    const isText = TEXT_TYPES.has(mimeType);

    // Read as text for text types, binary for everything else
    const raw = isText
      ? await fs.readFile(vfsPath, { encoding: 'utf8' }) as string
      : new Uint8Array(await fs.readFile(vfsPath) as Uint8Array);

    return new Response(raw, {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Cache-Control': 'no-cache',
      },
    });
  } catch {
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  }
}

const sw = self as unknown as ServiceWorkerGlobalScope;

sw.addEventListener('install', () => { sw.skipWaiting(); });

sw.addEventListener('activate', (event) => {
  event.waitUntil(sw.clients.claim());
});

sw.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith('/preview/')) return;

  const vfsPath = url.pathname.slice('/preview'.length);
  event.respondWith(handlePreviewRequest(vfsPath));
});
