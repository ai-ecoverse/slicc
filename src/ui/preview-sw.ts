/**
 * Preview Service Worker — intercepts requests and serves VFS content.
 *
 * Two modes:
 * 1. /preview/* requests — always intercepted, VFS path = pathname minus "/preview"
 * 2. EDS project mode — when a project root is set via postMessage, ALL requests
 *    from the project's tab are intercepted. Root-relative paths (/styles/styles.css)
 *    resolve against the VFS project root. This emulates `aem up` for EDS previews.
 *
 * Built as a separate entry point (not bundled with the main app).
 * Reads directly from LightningFS IndexedDB (same DB as VirtualFS).
 */

/// <reference lib="webworker" />

import FS from '@isomorphic-git/lightning-fs';

const DB_NAME = 'slicc-fs';
let lfs: FS.PromisifiedFS | null = null;

/**
 * Active EDS project root in VFS (e.g., "/shared/vibemigrated").
 * When set, root-relative requests resolve against this path.
 */
let edsProjectRoot: string | null = null;

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
    gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', avif: 'image/avif',
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
    } catch { /* stat failed — not a dir or doesn't exist yet, continue to readFile */ }

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
  } catch (err: unknown) {
    // Distinguish "not found" from filesystem/system errors
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOENT')) {
      return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    }
    console.error('[preview-sw] Error serving', vfsPath, msg);
    return new Response(`Preview error: ${msg}`, { status: 500, headers: { 'Content-Type': 'text/plain' } });
  }
}

const sw = self as unknown as ServiceWorkerGlobalScope;

sw.addEventListener('install', () => { sw.skipWaiting(); });

sw.addEventListener('activate', (event) => {
  event.waitUntil(sw.clients.claim());
});

// Listen for project root configuration from the browser tool
sw.addEventListener('message', (event) => {
  if (event.data?.type === 'set-eds-project-root') {
    edsProjectRoot = event.data.root || null;
    console.log('[preview-sw] EDS project root:', edsProjectRoot);
  }
});

/**
 * Paths that should NOT be intercepted in EDS mode — they belong to
 * the slicc app itself (Vite HMR, API endpoints, slicc UI assets).
 */
function isSliccAppPath(pathname: string): boolean {
  return pathname.startsWith('/@') ||
    pathname.startsWith('/__') ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/src/') ||
    pathname.startsWith('/node_modules/') ||
    pathname === '/' ||
    pathname === '/index.html';
}

sw.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Mode 1: /preview/* requests — always serve from VFS
  if (url.pathname.startsWith('/preview/')) {
    const vfsPath = url.pathname.slice('/preview'.length);
    event.respondWith(handlePreviewRequest(vfsPath));
    return;
  }

  // Mode 2: EDS project mode — resolve root-relative paths against project root
  if (edsProjectRoot && !isSliccAppPath(url.pathname)) {
    const vfsPath = edsProjectRoot + url.pathname;
    event.respondWith(handlePreviewRequest(vfsPath));
  }
});
