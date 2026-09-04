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

import {
  handlePreviewRequest,
  isSliccAppPath,
  pathnameOf,
  projectServeVfsPath,
} from './preview-sw-handler.js';

/**
 * Active project root in VFS (e.g., "/shared/my-project").
 * When set, root-relative requests resolve against this path.
 */
let projectRoot: string | null = null;

/**
 * Documents project serve mode itself delivered, by client id (for their
 * subresource fetches) and by pathname (for referrer-checked navigation
 * chains). Only these — plus `/preview/` pages — may pull further files
 * from the project root; app pages can never be misclassified because
 * membership is recorded at serve time, not inferred from the pathname.
 * Module-scoped like `projectRoot` itself: reset on SW eviction.
 */
const projectClientIds = new Set<string>();
const projectClientPaths = new Set<string>();

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
    // Forward `Range` so <video>/<audio> can seek; the handler answers 206.
    event.respondWith(
      handlePreviewRequest(
        getVfsBroadcast(),
        vfsPath,
        undefined,
        event.request.headers.get('range')
      )
    );
    return;
  }

  // Mode 2: Project serve mode — resolve root-relative paths against project
  // root, but only for requests made BY a project context (a /preview/ page
  // or a document this mode itself delivered). App fetches — the leader
  // page's chunks and workers, /cloud-style routes — fall back to the
  // network instead of the project VFS, whatever projectRoot a previous
  // preview left behind in SW state (#1981).
  if (projectRoot !== null && !isSliccAppPath(url.pathname)) {
    const root = projectRoot;
    const isNavigation = event.request.mode === 'navigate';
    const resultingClientId = event.resultingClientId;
    event.respondWith(
      (async () => {
        let requesterPath: string | null;
        let requesterIsProjectDocument: boolean;
        try {
          if (isNavigation) {
            // Navigations have no source client; the referrer names the
            // page the user navigated from.
            requesterPath = pathnameOf(event.request.referrer);
            requesterIsProjectDocument =
              requesterPath !== null && projectClientPaths.has(requesterPath);
          } else {
            const client = await sw.clients.get(event.clientId);
            requesterPath = pathnameOf(client?.url);
            // Fall back to the path set for browsers that don't surface a
            // resultingClientId at navigation-serve time.
            requesterIsProjectDocument =
              (client !== undefined && projectClientIds.has(client.id)) ||
              (requesterPath !== null && projectClientPaths.has(requesterPath));
          }
        } catch {
          // A failed client lookup must degrade to the network, never to a
          // rejected respondWith (which would fail the request outright).
          return fetch(event.request);
        }
        const vfsPath = projectServeVfsPath(
          root,
          url.pathname,
          requesterPath,
          requesterIsProjectDocument
        );
        if (vfsPath === null) return fetch(event.request);
        if (isNavigation) {
          // This response commits a project document — record it so its own
          // subresource fetches and onward navigations stay project-scoped.
          projectClientPaths.add(url.pathname);
          if (resultingClientId) projectClientIds.add(resultingClientId);
        }
        return handlePreviewRequest(getVfsBroadcast(), vfsPath);
      })()
    );
  }
});
