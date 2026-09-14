import type { FetchProxyRequestMsg } from '@slicc/shared-ts';
import {
  LEADER_EXT_ID_QUERY_NAME,
  LEADER_RUNTIME_QUERY_NAME,
  LEADER_RUNTIME_QUERY_VALUE,
} from '../kernel/messages.js';
import { parseBridgeLaunchParams } from './boot/bridge-launch-params.js';

export const SW_BRIDGE_CONFIG_MESSAGE = 'slicc:bridge-config';

export interface BridgeConfigMessage {
  type: typeof SW_BRIDGE_CONFIG_MESSAGE;

  apiBaseUrl: string | null;

  token: string | null;
}

export interface ResolvedBridgeConfig {
  apiBaseUrl: string;

  token: string;
}

export function resolveBridgeConfig(
  cached: { apiBaseUrl: string | null; token: string | null } | null,
  clientUrl: string | null
): ResolvedBridgeConfig | null {
  if (cached?.apiBaseUrl && cached.token) {
    return {
      apiBaseUrl: cached.apiBaseUrl.replace(/\/+$/, ''),
      token: cached.token,
    };
  }
  if (!clientUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(clientUrl);
  } catch {
    return null;
  }

  const params = parseBridgeLaunchParams(parsed.search);
  if (!params?.apiBaseUrl) return null;
  return { apiBaseUrl: params.apiBaseUrl.replace(/\/+$/, ''), token: params.token };
}

export function resolveBridgeFromClientUrls(
  cached: { apiBaseUrl: string | null; token: string | null } | null,
  clientUrls: (string | null)[]
): ResolvedBridgeConfig | null {
  if (cached?.apiBaseUrl && cached.token) {
    return resolveBridgeConfig(cached, null);
  }
  for (const url of clientUrls) {
    const resolved = resolveBridgeConfig(null, url);
    if (resolved) return resolved;
  }
  return null;
}

export function resolveFetchProxyTarget(
  fetchProxyPath: string,
  config: ResolvedBridgeConfig | null
): string {
  return config ? `${config.apiBaseUrl}${fetchProxyPath}` : fetchProxyPath;
}

export function isBridgeLocalApiUrl(requestUrl: string, bridgeApiBaseUrl: string): boolean {
  let bridge: URL;
  let target: URL;
  try {
    bridge = new URL(bridgeApiBaseUrl);
    target = new URL(requestUrl);
  } catch {
    return false;
  }
  return target.origin === bridge.origin && target.pathname.startsWith('/api/');
}

export function isBridgeFetchProxyUrl(
  requestUrl: string,
  bridgeApiBaseUrl: string,
  fetchProxyPath = '/api/fetch-proxy'
): boolean {
  let bridge: URL;
  let target: URL;
  try {
    bridge = new URL(bridgeApiBaseUrl);
    target = new URL(requestUrl);
  } catch {
    return false;
  }
  return target.origin === bridge.origin && target.pathname === fetchProxyPath;
}

export function isBridgeConfigMessage(value: unknown): value is BridgeConfigMessage {
  if (!value || typeof value !== 'object') return false;
  const v = value as { type?: unknown };
  return v.type === SW_BRIDGE_CONFIG_MESSAGE;
}

export class BridgeConfigCache {
  private readonly byClient = new Map<string, ResolvedBridgeConfig>();

  set(clientId: string, payload: { apiBaseUrl: string | null; token: string | null }): void {
    if (!clientId) return;
    if (!payload.apiBaseUrl || !payload.token) {
      this.byClient.delete(clientId);
      return;
    }
    this.byClient.set(clientId, {
      apiBaseUrl: payload.apiBaseUrl.replace(/\/+$/, ''),
      token: payload.token,
    });
  }

  get(clientId: string | null | undefined): ResolvedBridgeConfig | null {
    if (!clientId) return null;
    return this.byClient.get(clientId) ?? null;
  }

  delete(clientId: string): void {
    this.byClient.delete(clientId);
  }

  size(): number {
    return this.byClient.size;
  }
}

export const SW_EXTENSION_DELEGATE_MESSAGE = 'slicc:extension-delegate-config';

export const SW_EXTENSION_FETCH_MESSAGE = 'slicc:ext-fetch';

export interface ExtensionDelegateConfigMessage {
  type: typeof SW_EXTENSION_DELEGATE_MESSAGE;

  extensionId: string | null;
}

export interface ResolvedExtensionDelegate {
  extensionId: string;
}

export interface ExtensionFetchDelegateRequest {
  type: typeof SW_EXTENSION_FETCH_MESSAGE;

  requestId: string;

  extensionId: string;

  request: Omit<FetchProxyRequestMsg, 'type'>;
}

export function isExtensionDelegateMessage(
  value: unknown
): value is ExtensionDelegateConfigMessage {
  if (!value || typeof value !== 'object') return false;
  return (value as { type?: unknown }).type === SW_EXTENSION_DELEGATE_MESSAGE;
}

export function isExtensionFetchDelegateRequest(
  value: unknown
): value is ExtensionFetchDelegateRequest {
  if (!value || typeof value !== 'object') return false;
  const v = value as { type?: unknown; extensionId?: unknown; request?: unknown };
  return (
    v.type === SW_EXTENSION_FETCH_MESSAGE &&
    typeof v.extensionId === 'string' &&
    !!v.request &&
    typeof v.request === 'object'
  );
}

export function parseExtensionDelegateFromClientUrl(
  clientUrl: string | null
): ResolvedExtensionDelegate | null {
  if (!clientUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(clientUrl);
  } catch {
    return null;
  }
  if (parsed.searchParams.get(LEADER_RUNTIME_QUERY_NAME) !== LEADER_RUNTIME_QUERY_VALUE) {
    return null;
  }
  const extensionId = parsed.searchParams.get(LEADER_EXT_ID_QUERY_NAME);
  if (!extensionId) return null;
  return { extensionId };
}

export function resolveExtensionDelegate(
  cached: ResolvedExtensionDelegate | null,
  clientUrls: (string | null)[]
): ResolvedExtensionDelegate | null {
  if (cached?.extensionId) return { extensionId: cached.extensionId };
  for (const url of clientUrls) {
    const resolved = parseExtensionDelegateFromClientUrl(url);
    if (resolved) return resolved;
  }
  return null;
}

export class ExtensionDelegateCache {
  private readonly byClient = new Map<string, ResolvedExtensionDelegate>();

  set(clientId: string, payload: { extensionId: string | null }): void {
    if (!clientId) return;
    if (!payload.extensionId) {
      this.byClient.delete(clientId);
      return;
    }
    this.byClient.set(clientId, { extensionId: payload.extensionId });
  }

  get(clientId: string | null | undefined): ResolvedExtensionDelegate | null {
    if (!clientId) return null;
    return this.byClient.get(clientId) ?? null;
  }

  delete(clientId: string): void {
    this.byClient.delete(clientId);
  }

  size(): number {
    return this.byClient.size;
  }
}

const PASSTHROUGH_DESTINATIONS = new Set([
  'image',
  'font',
  'style',
  'video',
  'audio',
  'track',
  'iframe',
  'object',
  'embed',
]);

export function isPassthroughDestination(destination: string): boolean {
  return PASSTHROUGH_DESTINATIONS.has(destination);
}

export function maySetSyncFsNonce(source: unknown): boolean {
  const c = source as { type?: string; frameType?: string } | null;
  return c?.type === 'window' && c.frameType === 'top-level';
}

export function maySetProxyConfig(source: unknown): boolean {
  return maySetSyncFsNonce(source);
}

export function filterAuthorizedProxyClients<T>(clients: readonly T[]): T[] {
  return clients.filter(maySetProxyConfig);
}

export interface NonceWaiter {
  notify(): void;

  wait(timeoutMs: number): Promise<void>;
}

export function createNonceWaiter(): NonceWaiter {
  let waiters: Array<() => void> = [];
  return {
    notify(): void {
      const pending = waiters;
      waiters = [];
      for (const w of pending) w();
    },
    wait(timeoutMs: number): Promise<void> {
      return new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          waiters = waiters.filter((w) => w !== finish);
          resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        waiters.push(finish);
      });
    },
  };
}
