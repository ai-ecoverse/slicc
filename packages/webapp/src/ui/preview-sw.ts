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
 * Built as a separate IIFE entry point (not bundled with the main app).
 * All reads go through the page-side `preview-vfs` BroadcastChannel
 * responder, which serves the live OPFS-backed `VirtualFS` — no IDB
 * fast-path, no SW-side cache. See `preview-sw-handler.ts` for the
 * pure logic.
 */

/// <reference lib="webworker" />

import { handlePreviewRequest, isSliccAppPath } from './preview-sw-handler.js';

/**
 * Active project root in VFS (e.g., "/shared/my-project").
 * When set, root-relative requests resolve against this path.
 */
let projectRoot: string | null = null;

const sw = self as unknown as ServiceWorkerGlobalScope;

let vfsBroadcast: BroadcastChannel | null = null;
function getVfsBroadcast(): BroadcastChannel {
  if (!vfsBroadcast) vfsBroadcast = new BroadcastChannel('preview-vfs');
  return vfsBroadcast;
}

sw.addEventListener('install', () => {
  sw.skipWaiting();
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(sw.clients.claim());
});

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
    event.respondWith(handlePreviewRequest(getVfsBroadcast(), vfsPath));
    return;
  }

  // Mode 2: Project serve mode — resolve root-relative paths against project root
  if (projectRoot && !isSliccAppPath(url.pathname)) {
    const vfsPath = projectRoot + url.pathname;
    event.respondWith(handlePreviewRequest(getVfsBroadcast(), vfsPath));
  }
});
