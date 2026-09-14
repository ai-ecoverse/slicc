/// <reference lib="webworker" />

import { BRIDGE_TOKEN_HEADER } from '@slicc/shared-ts';
import {
  SYNC_FS_NEED_NONCE_MSG,
  SYNC_FS_NONCE_MSG,
  SYNC_FS_NONCE_WAIT_MS,
  type SyncFsNeedNonceMsg,
  type SyncFsNonce,
  syncFsChannelName,
} from '../kernel/realm/sync-fs-wire.js';
import { encodeForbiddenRequestHeaders, headersToRecord } from '../shell/proxy-headers.js';
import { buildDelegatedResponseStream } from './llm-proxy-extension-delegate.js';
import { synthesizeForwardResponse } from './llm-proxy-response.js';
import {
  BridgeConfigCache,
  createNonceWaiter,
  ExtensionDelegateCache,
  type ExtensionFetchDelegateRequest,
  filterAuthorizedProxyClients,
  isBridgeConfigMessage,
  isBridgeLocalApiUrl,
  isExtensionDelegateMessage,
  isPassthroughDestination,
  maySetProxyConfig,
  maySetSyncFsNonce,
  parseExtensionDelegateFromClientUrl,
  type ResolvedExtensionDelegate,
  resolveBridgeFromClientUrls,
  resolveExtensionDelegate,
  resolveFetchProxyTarget,
  SW_EXTENSION_FETCH_MESSAGE,
} from './llm-proxy-sw-config.js';
import {
  handleSyncFsRequest,
  parseSyncFsRequest,
  SYNC_EXEC_ROUTE,
  SYNC_FS_ERRNO_HEADER,
  SYNC_FS_MARKER_HEADER,
  SYNC_FS_NO_RESPONDER_HEADER,
  SYNC_FS_ROUTE_PREFIX,
} from './sync-fs-sw-handler.js';

declare const self: ServiceWorkerGlobalScope;

const FETCH_PROXY_PATH = '/api/fetch-proxy';
const BYPASS_HEADER = 'x-bypass-llm-proxy';

const bridgeConfigCache = new BridgeConfigCache();

const extensionDelegateCache = new ExtensionDelegateCache();

const DELEGATE_REQUEST_BODY_CAP = 32 * 1024 * 1024;

self.importScripts('/preview-sw.js');

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  const source = event.source;

  if (!source || !('id' in source) || typeof source.id !== 'string') return;
  if (isBridgeConfigMessage(event.data) && maySetProxyConfig(source)) {
    bridgeConfigCache.set(source.id, {
      apiBaseUrl: event.data.apiBaseUrl,
      token: event.data.token,
    });
    return;
  }
  if (isExtensionDelegateMessage(event.data) && maySetProxyConfig(source)) {
    extensionDelegateCache.set(source.id, { extensionId: event.data.extensionId });
    return;
  }
  const d = event.data as { type?: string; nonce?: string } | undefined;
  if (d?.type === SYNC_FS_NONCE_MSG && typeof d.nonce === 'string') {
    if (maySetSyncFsNonce(source)) addSyncFsNonce(d.nonce);
    return;
  }
});

self.addEventListener('fetch', (event: FetchEvent) => {
  const req = event.request;
  if (req.headers.get(BYPASS_HEADER) === '1') return;
  if (isPassthroughDestination(req.destination)) return;

  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }

  if (url.origin === self.location.origin) return;

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  event.respondWith(forwardThroughProxy(req, event.clientId || null));
});

const syncFsChannels = new Map<string, BroadcastChannel>();

const syncFsNonceWaiter = createNonceWaiter();
function getSyncFsChannels(): BroadcastChannel[] {
  return [...syncFsChannels.values()];
}
function addSyncFsNonce(nonce: string): void {
  if (syncFsChannels.has(nonce)) return;
  syncFsChannels.set(nonce, new BroadcastChannel(syncFsChannelName(nonce as SyncFsNonce)));

  syncFsNonceWaiter.notify();
}
async function requestSyncFsNonce(): Promise<void> {
  const clients = await self.clients.matchAll({ type: 'window' });
  const msg: SyncFsNeedNonceMsg = { type: SYNC_FS_NEED_NONCE_MSG };
  for (const c of clients) c.postMessage(msg);
}

self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(SYNC_FS_ROUTE_PREFIX) && url.pathname !== SYNC_EXEC_ROUTE) return;
  event.respondWith(
    (async () => {
      const req = await parseSyncFsRequest(event.request);

      if (!req) {
        return new Response('sync bridge: malformed request', {
          status: 400,
          headers: { [SYNC_FS_ERRNO_HEADER]: 'EINVAL', [SYNC_FS_MARKER_HEADER]: '1' },
        });
      }
      let channels = getSyncFsChannels();
      if (channels.length === 0) {
        void requestSyncFsNonce();
        await syncFsNonceWaiter.wait(SYNC_FS_NONCE_WAIT_MS);
        channels = getSyncFsChannels();
        if (channels.length === 0) {
          return new Response('sync-fs bridge not ready', {
            status: 503,
            headers: { [SYNC_FS_ERRNO_HEADER]: 'EIO', [SYNC_FS_MARKER_HEADER]: '1' },
          });
        }
      }
      const response = await handleSyncFsRequest(channels, req);

      if (response.headers.get(SYNC_FS_NO_RESPONDER_HEADER) === '1') {
        void requestSyncFsNonce();
      }
      return response;
    })()
  );
});

async function forwardThroughProxy(req: Request, clientId: string | null): Promise<Response> {
  const targetUrl = req.url;
  const inboundHeaders: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    if (key.toLowerCase() === BYPASS_HEADER) return;
    inboundHeaders[key] = value;
  });
  const encoded = encodeForbiddenRequestHeaders(inboundHeaders);

  const proxyHeaders = new Headers();
  for (const [key, value] of Object.entries(encoded)) {
    proxyHeaders.set(key, value);
  }
  proxyHeaders.set('X-Target-URL', targetUrl);

  const cached = bridgeConfigCache.get(clientId);
  const cachedDelegate = extensionDelegateCache.get(clientId);
  const triggeringClientUrl = await readClientUrl(clientId);

  const windowClientUrls = cached || cachedDelegate ? [] : await readWindowClientUrls();
  const candidateUrls = [triggeringClientUrl, ...windowClientUrls];

  const delegate = resolveExtensionDelegate(cachedDelegate, candidateUrls);
  if (delegate) {
    const delegateClient = await pickDelegateWindowClient();
    if (delegateClient) {
      return forwardViaExtensionDelegate(req, delegate, delegateClient, targetUrl);
    }
  }

  const bridge = resolveBridgeFromClientUrls(cached, candidateUrls);

  if (bridge && isBridgeLocalApiUrl(req.url, bridge.apiBaseUrl)) {
    const passHeaders = new Headers(req.headers);
    passHeaders.set(BYPASS_HEADER, '1');
    const passInit: RequestInit = {
      method: req.method,
      headers: passHeaders,
      cache: 'no-store',
      credentials: req.credentials,
      redirect: 'manual',
      signal: req.signal,
      body: await readForwardBody(req),
    };
    return synthesizeForwardResponse(await fetch(req.url, passInit));
  }

  if (bridge) {
    proxyHeaders.set(BRIDGE_TOKEN_HEADER, bridge.token);
  }
  const forwardUrl = resolveFetchProxyTarget(FETCH_PROXY_PATH, bridge);

  const body = await readForwardBody(req);
  const init: RequestInit = {
    method: req.method,
    headers: proxyHeaders,
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'manual',
    signal: req.signal,
    body,
  };

  const response = await fetch(forwardUrl, init);

  return synthesizeForwardResponse(response);
}

async function readForwardBody(req: Request): Promise<BodyInit | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;

  const body = await req.arrayBuffer();
  return body.byteLength > 0 ? body : undefined;
}

async function readClientUrl(clientId: string | null): Promise<string | null> {
  if (!clientId) return null;
  try {
    const client = await self.clients.get(clientId);
    return filterAuthorizedProxyClients(client ? [client] : [])[0]?.url ?? null;
  } catch {
    return null;
  }
}

async function readWindowClientUrls(): Promise<string[]> {
  try {
    const clients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });
    return filterAuthorizedProxyClients(clients)
      .map((c) => c.url)
      .filter((u): u is string => !!u);
  } catch {
    return [];
  }
}

async function pickDelegateWindowClient(): Promise<Client | null> {
  try {
    const clients = filterAuthorizedProxyClients(
      await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    );
    if (clients.length === 0) return null;
    const leader = clients.find((c) => parseExtensionDelegateFromClientUrl(c.url) !== null);
    return leader ?? clients[0];
  } catch {
    return null;
  }
}

function encodeBase64Bytes(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function forwardViaExtensionDelegate(
  req: Request,
  delegate: ResolvedExtensionDelegate,
  client: Client,
  targetUrl: string
): Promise<Response> {
  const inboundHeaders: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    if (key.toLowerCase() === BYPASS_HEADER) return;
    inboundHeaders[key] = value;
  });
  const headers = encodeForbiddenRequestHeaders(inboundHeaders);

  let bodyBase64: string | undefined;
  let requestBodyTooLarge = false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const buf = await req.arrayBuffer();
    if (buf.byteLength > DELEGATE_REQUEST_BODY_CAP) {
      requestBodyTooLarge = true;
    } else if (buf.byteLength > 0) {
      bodyBase64 = encodeBase64Bytes(new Uint8Array(buf));
    }
  }

  const channel = new MessageChannel();
  const { responsePromise } = buildDelegatedResponseStream(channel.port1);
  const envelope: ExtensionFetchDelegateRequest = {
    type: SW_EXTENSION_FETCH_MESSAGE,
    requestId: randomRequestId(),
    extensionId: delegate.extensionId,
    request: { url: targetUrl, method: req.method, headers, bodyBase64, requestBodyTooLarge },
  };
  client.postMessage(envelope, [channel.port2]);
  return responsePromise;
}

function randomRequestId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

void headersToRecord;
