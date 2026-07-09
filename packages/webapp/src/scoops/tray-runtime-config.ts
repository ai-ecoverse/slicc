import { SLICC_HOSTED_ORIGIN, SLICC_STAGING_HUB_ORIGIN } from '@slicc/shared-ts';

export const TRAY_WORKER_STORAGE_KEY = 'slicc.trayWorkerBaseUrl';
export const TRAY_JOIN_STORAGE_KEY = 'slicc.trayJoinUrl';
export const DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL = SLICC_HOSTED_ORIGIN;
export const DEFAULT_STAGING_TRAY_WORKER_BASE_URL = SLICC_STAGING_HUB_ORIGIN;

import {
  LEADER_RUNTIME_QUERY_NAME,
  LEADER_RUNTIME_QUERY_VALUE,
} from '../kernel/messages.js';
import {
  buildCanonicalTrayLaunchUrl,
  normalizeTrayWorkerBaseUrl,
  parseTrayJoinUrl,
  TRAY_LEGACY_LEAD_QUERY_PARAM,
  TRAY_QUERY_PARAM,
  TRAY_WORKER_QUERY_PARAM,
} from '../../../node-server/src/tray-url-shared.js';
import { apiHeaders, resolveApiUrl } from '../shell/proxied-fetch.js';

export {
  normalizeTrayWorkerBaseUrl,
  TRAY_LEGACY_LEAD_QUERY_PARAM,
  TRAY_QUERY_PARAM,
  TRAY_WORKER_QUERY_PARAM,
};

export interface TrayUrlConfig {
  workerBaseUrl: string;
  trayId: string | null;
  joinUrl: string | null;
}

export type TrayJoinConfig = TrayUrlConfig & { joinUrl: string };

export interface RuntimeConfigStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface RuntimeConfigResponse {
  trayWorkerBaseUrl?: string | null;
  trayJoinUrl?: string | null;
}

export function buildTrayWorkerUrl(baseUrl: string, path: string): string {
  const normalizedBase = normalizeTrayWorkerBaseUrl(baseUrl);
  if (!normalizedBase) {
    throw new Error(`Invalid tray worker base URL: ${baseUrl}`);
  }
  const relativePath = path.replace(/^\/+/, '');
  return new URL(relativePath, `${normalizedBase}/`).toString();
}

export function parseTrayUrlValue(raw: string | null | undefined): TrayUrlConfig | null {
  if (!raw) return null;

  try {
    const url = new URL(raw.trim());
    url.search = '';
    url.hash = '';

    const segments = url.pathname.split('/').filter(Boolean);
    let trayId: string | null = null;
    const joinUrl: string | null = null;
    if (segments.length >= 2 && segments.at(-2) === 'tray') {
      trayId = decodeURIComponent(segments.at(-1)!);
      segments.splice(-2, 2);
      url.pathname = segments.length > 0 ? `/${segments.join('/')}` : '/';
    } else if (segments.length >= 2 && segments.at(-2) === 'join') {
      return parseTrayJoinUrl(url.toString());
    }

    const workerBaseUrl = normalizeTrayWorkerBaseUrl(url.toString());
    if (!workerBaseUrl) {
      return null;
    }

    return { workerBaseUrl, trayId, joinUrl };
  } catch {
    return null;
  }
}

export function parseTrayJoinUrlValue(raw: string | null | undefined): TrayJoinConfig | null {
  const parsed = parseTrayUrlValue(raw);
  return parsed?.joinUrl ? (parsed as TrayJoinConfig) : null;
}

export function storeTrayJoinUrl(
  storage: RuntimeConfigStorage,
  raw: string | null | undefined
): TrayJoinConfig | null {
  const parsed = parseTrayJoinUrlValue(raw);
  if (!parsed) {
    return null;
  }
  storage.setItem(TRAY_JOIN_STORAGE_KEY, parsed.joinUrl);
  storage.setItem(TRAY_WORKER_STORAGE_KEY, parsed.workerBaseUrl);
  return parsed;
}

export function hasStoredTrayJoinUrl(storage: RuntimeConfigStorage | null | undefined): boolean {
  return !!parseTrayJoinUrlValue(storage?.getItem(TRAY_JOIN_STORAGE_KEY) ?? null);
}

/**
 * Resolve a follower JOIN URL from the page URL or stored config, covering the
 * launch shapes the tray uses: a `?tray=<…/join/token>` query (what
 * `node-server --join` builds), a `…/join/<token>` path on the current URL
 * (deployed sliccy.ai follower tab), or a stored join URL. Returns the join URL
 * only when a parseable `joinUrl` exists — a `…/tray/<trayId>` leader/session
 * shape (trayId set, joinUrl null) yields null. Used by `resolveUiRuntimeMode`
 * for follower detection and by `mountWcUiFollower` to obtain the join URL.
 */
export function resolveFollowerJoinUrl(
  locationHref: string,
  storage?: RuntimeConfigStorage | null
): string | null {
  // The URL can express an EXPLICIT tray intent that is not a follower join: a
  // `--lead` launch (`?tray=<workerBaseUrl>`), a leader session (`/tray/<id>`),
  // or the extension's pinned leader tab (`?slicc=leader`).
  // When it does, the stored join URL must NOT override it — otherwise a profile
  // that previously followed (which persisted a join URL via resolveTrayRuntimeConfig)
  // would hijack a subsequent `--lead` launch back into follower mode.
  let hasExplicitTrayIntent = false;
  // 1. ?tray=<value> query param (node-server --join / --lead canonical shape).
  try {
    const url = new URL(locationHref);
    const trayParam = url.searchParams.get(TRAY_QUERY_PARAM);
    if (trayParam !== null) {
      hasExplicitTrayIntent = true;
      const fromQuery = parseTrayUrlValue(trayParam);
      if (fromQuery?.joinUrl) return fromQuery.joinUrl;
    }
    // Extension-delegate leader tab (`?slicc=leader`): this is an explicit
    // "run as my own cone" intent and must never fall through to a stored
    // follower join URL from a previous cloud-cone connection.
    if (url.searchParams.get(LEADER_RUNTIME_QUERY_NAME) === LEADER_RUNTIME_QUERY_VALUE) {
      hasExplicitTrayIntent = true;
    }
  } catch {
    // not a parseable URL — fall through to stored config
  }
  // 2. The current URL itself as a tray URL (worker serves followers at
  //    /join/:token; a leader session is /tray/:id).
  const fromPath = parseTrayUrlValue(locationHref);
  if (fromPath?.joinUrl) return fromPath.joinUrl;
  if (fromPath?.trayId) hasExplicitTrayIntent = true;
  // 3. Stored join URL — only when the URL itself carries no tray intent.
  if (hasExplicitTrayIntent) return null;
  const stored = parseTrayJoinUrlValue(storage?.getItem(TRAY_JOIN_STORAGE_KEY) ?? null);
  return stored?.joinUrl ?? null;
}

/**
 * Strip any follower-join marker from a page URL so a subsequent reload boots
 * as plain standalone (or leader) instead of re-detecting follower mode.
 * `resolveFollowerJoinUrl` checks the `?tray=` query param and a trailing
 * `…/join/<token>` path *before* stored config, so a storage-only switch-out
 * cannot exit follower mode when the entry URL itself carries the marker (the
 * canonical `/join/<token>` shape this fast-path optimizes). Returns the href
 * unchanged when it carries no marker or is not a parseable URL. Mirrors the
 * `segments.at(-2) === 'join'` path logic in `parseTrayUrlValue`.
 */
export function stripFollowerMarkerFromHref(href: string): string {
  try {
    const url = new URL(href);
    url.searchParams.delete(TRAY_QUERY_PARAM);
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length >= 2 && segments.at(-2) === 'join') {
      segments.splice(-2, 2);
      url.pathname = segments.length > 0 ? `/${segments.join('/')}` : '/';
    }
    return url.toString();
  } catch {
    return href;
  }
}

export function buildTrayUrlValue(workerBaseUrl: string, trayId?: string | null): string {
  const normalizedBase = normalizeTrayWorkerBaseUrl(workerBaseUrl);
  if (!normalizedBase) {
    throw new Error(`Invalid tray worker base URL: ${workerBaseUrl}`);
  }

  const normalizedTrayId = trayId?.trim();
  if (!normalizedTrayId) {
    return normalizedBase;
  }

  return new URL(`tray/${encodeURIComponent(normalizedTrayId)}`, `${normalizedBase}/`).toString();
}

export function buildTrayLaunchUrl(
  locationHref: string,
  workerBaseUrl: string,
  trayId?: string | null
): string {
  return buildCanonicalTrayLaunchUrl(locationHref, buildTrayUrlValue(workerBaseUrl, trayId));
}

export function parseTrayLeadValue(raw: string | null | undefined): TrayUrlConfig | null {
  return parseTrayUrlValue(raw);
}

export function buildTrayLeadValue(workerBaseUrl: string, trayId?: string | null): string {
  return buildTrayUrlValue(workerBaseUrl, trayId);
}

export function buildTrayLeadLaunchUrl(
  locationHref: string,
  workerBaseUrl: string,
  trayId?: string | null
): string {
  return buildTrayLaunchUrl(locationHref, workerBaseUrl, trayId);
}

export async function resolveTrayRuntimeConfig(options: {
  locationHref: string;
  storage?: RuntimeConfigStorage | null;
  envBaseUrl?: string | null;
  defaultWorkerBaseUrl?: string | null;
  runtimeConfigFetcher?: (() => Promise<RuntimeConfigResponse | null>) | null;
}): Promise<TrayUrlConfig | null> {
  const queryConfig = readQueryTrayConfig(options.locationHref);
  if (queryConfig) {
    if (options.storage) {
      if (queryConfig.joinUrl) {
        options.storage.setItem(TRAY_JOIN_STORAGE_KEY, queryConfig.joinUrl);
      }
      options.storage.setItem(TRAY_WORKER_STORAGE_KEY, queryConfig.workerBaseUrl);
    }
    return queryConfig;
  }

  const storedJoinConfig = parseTrayJoinUrlValue(
    options.storage?.getItem(TRAY_JOIN_STORAGE_KEY) ?? null
  );
  if (storedJoinConfig) {
    if (options.storage) {
      options.storage.setItem(TRAY_WORKER_STORAGE_KEY, storedJoinConfig.workerBaseUrl);
    }
    return storedJoinConfig;
  }

  const serverConfig = options.runtimeConfigFetcher
    ? await readServerTrayConfig(options.runtimeConfigFetcher)
    : null;

  // If the server provided a join URL, use it (e.g. Electron overlay joining a tray)
  if (serverConfig?.joinConfig) {
    if (options.storage) {
      options.storage.setItem(TRAY_JOIN_STORAGE_KEY, serverConfig.joinConfig.joinUrl);
      options.storage.setItem(TRAY_WORKER_STORAGE_KEY, serverConfig.joinConfig.workerBaseUrl);
    }
    return serverConfig.joinConfig;
  }

  const serverBaseUrl = serverConfig?.workerBaseUrl ?? null;
  const storedBaseUrl = normalizeTrayWorkerBaseUrl(
    options.storage?.getItem(TRAY_WORKER_STORAGE_KEY) ?? null
  );
  const envBaseUrl = normalizeTrayWorkerBaseUrl(options.envBaseUrl ?? null);
  const defaultWorkerBaseUrl = normalizeTrayWorkerBaseUrl(options.defaultWorkerBaseUrl ?? null);

  const workerBaseUrl = serverBaseUrl ?? storedBaseUrl ?? envBaseUrl ?? defaultWorkerBaseUrl;
  if (!workerBaseUrl) {
    return null;
  }
  if (options.storage) {
    options.storage.setItem(TRAY_WORKER_STORAGE_KEY, workerBaseUrl);
  }
  return { workerBaseUrl, trayId: null, joinUrl: null };
}

export async function resolveTrayWorkerBaseUrl(options: {
  locationHref: string;
  storage?: RuntimeConfigStorage | null;
  envBaseUrl?: string | null;
  defaultWorkerBaseUrl?: string | null;
  runtimeConfigFetcher?: (() => Promise<RuntimeConfigResponse | null>) | null;
}): Promise<string | null> {
  return (await resolveTrayRuntimeConfig(options))?.workerBaseUrl ?? null;
}

export async function fetchRuntimeConfig(
  fetchImpl: typeof fetch = fetch
): Promise<RuntimeConfigResponse | null> {
  try {
    // Route through `resolveApiUrl` + `apiHeaders` so that in thin-bridge
    // mode (overlay served cross-origin from the hosted leader, which has
    // no /api surface) the request targets the local node-server origin
    // with the `X-Bridge-Token` header. Outside thin-bridge mode
    // `resolveApiUrl` returns the unchanged relative path and `apiHeaders`
    // is empty, preserving the legacy same-origin behavior. The boot path
    // must call `setLocalApiBaseUrl`/`setBridgeToken` before this fetch.
    const response = await fetchImpl(resolveApiUrl('/api/runtime-config'), {
      cache: 'no-store',
      headers: apiHeaders(),
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as RuntimeConfigResponse;
  } catch {
    return null;
  }
}

function readQueryTrayConfig(locationHref: string): TrayUrlConfig | null {
  try {
    const url = new URL(locationHref);

    const trayConfig = parseTrayUrlValue(url.searchParams.get(TRAY_QUERY_PARAM));
    if (trayConfig) {
      return trayConfig;
    }

    const legacyLeadConfig = parseTrayUrlValue(url.searchParams.get(TRAY_LEGACY_LEAD_QUERY_PARAM));
    if (legacyLeadConfig) {
      return legacyLeadConfig;
    }

    const workerBaseUrl = normalizeTrayWorkerBaseUrl(url.searchParams.get(TRAY_WORKER_QUERY_PARAM));
    if (workerBaseUrl) {
      return { workerBaseUrl, trayId: null, joinUrl: null };
    }

    // Check if the page URL itself is a join URL (e.g. when served from the worker at /join/:token)
    const pathJoinConfig = parseTrayJoinUrl(locationHref);
    if (pathJoinConfig) {
      return pathJoinConfig;
    }

    return null;
  } catch {
    return null;
  }
}

interface ServerTrayConfig {
  workerBaseUrl: string | null;
  joinConfig: TrayJoinConfig | null;
}

async function readServerTrayConfig(
  runtimeConfigFetcher: () => Promise<RuntimeConfigResponse | null>
): Promise<ServerTrayConfig | null> {
  const config = await runtimeConfigFetcher();
  if (!config) return null;

  const joinConfig = parseTrayJoinUrlValue(config.trayJoinUrl ?? null);
  const workerBaseUrl = normalizeTrayWorkerBaseUrl(config.trayWorkerBaseUrl ?? null);

  return { workerBaseUrl, joinConfig };
}
