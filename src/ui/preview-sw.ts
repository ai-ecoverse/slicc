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
 *
 * For mounted directories (File System Access API), the SW can't access
 * the handles directly. On LFS miss (ENOENT), it falls back to asking
 * the main page's VirtualFS via postMessage.
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

const sw = self as unknown as ServiceWorkerGlobalScope;

/**
 * Ask the main page to read a file from VirtualFS (which knows about mounts).
 * Uses BroadcastChannel instead of client.postMessage because the main page
 * at `/` is outside the SW's `/preview/` scope, so clients.matchAll() can't
 * find it. BroadcastChannel works across all same-origin contexts.
 */
let vfsBroadcast: BroadcastChannel | null = null;

function getVfsBroadcast(): BroadcastChannel {
  if (!vfsBroadcast) vfsBroadcast = new BroadcastChannel('preview-vfs');
  return vfsBroadcast;
}

async function readViaMainPage(
  vfsPath: string,
  asText: boolean,
): Promise<string | Uint8Array | null> {
  const bc = getVfsBroadcast();
  const id = `pvfs-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return new Promise<string | Uint8Array | null>((resolve) => {
    const timer = setTimeout(() => {
      bc.removeEventListener('message', handler);
      resolve(null);
    }, 5000);

    function handler(event: MessageEvent): void {
      if (event.data?.type !== 'preview-vfs-response' || event.data.id !== id) return;
      bc.removeEventListener('message', handler);
      clearTimeout(timer);
      if (event.data.error) {
        resolve(null);
        return;
      }
      resolve(event.data.content ?? null);
    }

    bc.addEventListener('message', handler);
    bc.postMessage({ type: 'preview-vfs-read', id, path: vfsPath, asText });
  });
}

async function handlePreviewRequest(vfsPath: string): Promise<Response> {
  const mimeType = getMimeType(vfsPath);
  const isText = TEXT_TYPES.has(mimeType);

  // Try LightningFS first (fast path for non-mounted files)
  try {
    const fs = getLFS();

    // Check if path is a directory → serve index.html
    try {
      const stat = await fs.stat(vfsPath);
      if (stat.isDirectory()) {
        vfsPath = vfsPath.endsWith('/') ? vfsPath + 'index.html' : vfsPath + '/index.html';
      }
    } catch { /* stat failed — not a dir or doesn't exist yet, continue to readFile */ }

    const raw = isText
      ? await fs.readFile(vfsPath, { encoding: 'utf8' }) as string
      : new Uint8Array(await fs.readFile(vfsPath) as Uint8Array);

    return new Response(raw, {
      status: 200,
      headers: { 'Content-Type': mimeType, 'Cache-Control': 'no-cache' },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('ENOENT')) {
      console.error('[preview-sw] Error serving', vfsPath, msg);
      return new Response(`Preview error: ${msg}`, { status: 500, headers: { 'Content-Type': 'text/plain' } });
    }
    // Fall through to main-page fallback for mounted files
  }

  // Fallback: ask the main page's VirtualFS (handles mounted directories)
  const content = await readViaMainPage(vfsPath, isText);
  if (content !== null) {
    const body = typeof content === 'string' ? content : new Uint8Array(content as Uint8Array);
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': mimeType, 'Cache-Control': 'no-cache' },
    });
  }

  return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
}

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
