/// <reference lib="webworker" />

import {
  handlePreviewRequest,
  isSliccAppPath,
  pathnameOf,
  projectServeVfsPath,
} from './preview-sw-handler.js';

let projectRoot: string | null = null;

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

  if (url.origin !== sw.location.origin) return;

  if (url.pathname.startsWith('/preview/')) {
    const root = url.searchParams.get('projectRoot');
    if (root) {
      projectRoot = root;
      console.log('[preview-sw] Project root:', projectRoot);
    }

    const vfsPath = url.pathname.slice('/preview'.length);

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
            requesterPath = pathnameOf(event.request.referrer);
            requesterIsProjectDocument =
              requesterPath !== null && projectClientPaths.has(requesterPath);
          } else {
            const client = await sw.clients.get(event.clientId);
            requesterPath = pathnameOf(client?.url);

            requesterIsProjectDocument =
              (client !== undefined && projectClientIds.has(client.id)) ||
              (requesterPath !== null && projectClientPaths.has(requesterPath));
          }
        } catch {
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
          projectClientPaths.add(url.pathname);
          if (resultingClientId) projectClientIds.add(resultingClientId);
        }
        return handlePreviewRequest(getVfsBroadcast(), vfsPath);
      })()
    );
  }
});
