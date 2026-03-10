/**
 * Preview Service Worker — intercepts requests and serves VFS content.
 *
 * Two modes:
 * 1. /preview/* requests — always intercepted, VFS path = pathname minus "/preview"
 * 2. Project serve mode — when a ?projectRoot= query parameter is present on a
 *    /preview/ HTML request, the project root is extracted and stored. Subsequent
 *    root-relative requests (/styles/, /scripts/, etc.) resolve against the project
 *    root. This emulates a local dev server for any framework (EDS, Next.js, etc.).
 *
 * Built as a separate entry point (not bundled with the main app).
 * Reads directly from LightningFS IndexedDB (same DB as VirtualFS).
 */

/// <reference lib="webworker" />

import FS from '@isomorphic-git/lightning-fs';

const DB_NAME = 'slicc-fs';
let lfs: FS.PromisifiedFS | null = null;

/**
 * Active project root in VFS (e.g., "/shared/my-project").
 * When set, root-relative requests resolve against this path.
 */
let projectRoot: string | null = null;

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

/**
 * Paths that should NOT be intercepted in project serve mode — they
 * belong to the slicc app itself (Vite HMR, API endpoints, UI assets).
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

  // Skip cross-origin requests — let them pass through to the network.
  // Without this, external resources (fonts, CDN images) get intercepted
  // and served as 404 from VFS.
  if (url.origin !== sw.location.origin) return;

  // Mode 1: /preview/* requests — always serve from VFS
  if (url.pathname.startsWith('/preview/')) {
    // Check for projectRoot query parameter — set project root from the
    // page URL itself. The HTML page is always the first request, so
    // projectRoot is set before any sub-requests (scripts, styles) arrive.
    const root = url.searchParams.get('projectRoot');
    if (root) {
      projectRoot = root;
      console.log('[preview-sw] Project root:', projectRoot);
    }

    const vfsPath = url.pathname.slice('/preview'.length);
    event.respondWith(handlePreviewRequest(vfsPath));
    return;
  }

  // Mode 2: Project serve mode — resolve root-relative paths against project root
  if (projectRoot && !isSliccAppPath(url.pathname)) {
    const vfsPath = projectRoot + url.pathname;
    event.respondWith(handlePreviewRequest(vfsPath));
  }
});
