import { SLICC_HOSTED_ORIGIN, SLICC_STAGING_HUB_ORIGIN } from '@slicc/shared-ts';
import { TRAY_JOIN_STORAGE_KEY, TRAY_WORKER_STORAGE_KEY } from '../base/tray-storage-keys.js';

export { TRAY_JOIN_STORAGE_KEY, TRAY_WORKER_STORAGE_KEY };
export const DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL = SLICC_HOSTED_ORIGIN;
export const DEFAULT_STAGING_TRAY_WORKER_BASE_URL = SLICC_STAGING_HUB_ORIGIN;

import {
  buildCanonicalTrayLaunchUrl,
  parseTrayJoinUrl,
  TRAY_LEGACY_LEAD_QUERY_PARAM,
  TRAY_QUERY_PARAM,
  TRAY_WORKER_QUERY_PARAM,
} from '@slicc/shared-ts';
import {
  LEADER_RUNTIME_QUERY_NAME,
  LEADER_RUNTIME_QUERY_VALUE,
} from '../base/leader-runtime-query.js';
import {
  normalizeTrayWorkerBaseUrl,
  parseTrayJoinUrlValue,
  parseTrayUrlValue,
  type TrayJoinConfig,
  type TrayUrlConfig,
} from '../base/tray-url-config.js';
import { apiHeaders, resolveApiUrl } from '../shell/proxied-fetch.js';

export {
  normalizeTrayWorkerBaseUrl,
  parseTrayJoinUrlValue,
  parseTrayUrlValue,
  TRAY_LEGACY_LEAD_QUERY_PARAM,
  TRAY_QUERY_PARAM,
  TRAY_WORKER_QUERY_PARAM,
  type TrayJoinConfig,
  type TrayUrlConfig,
};

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

export function resolveFollowerJoinUrl(
  locationHref: string,
  storage?: RuntimeConfigStorage | null
): string | null {
  let hasExplicitTrayIntent = false;

  try {
    const url = new URL(locationHref);
    const trayParam = url.searchParams.get(TRAY_QUERY_PARAM);
    if (trayParam !== null) {
      hasExplicitTrayIntent = true;
      const fromQuery = parseTrayUrlValue(trayParam);
      if (fromQuery?.joinUrl) return fromQuery.joinUrl;
    }

    if (url.searchParams.get(LEADER_RUNTIME_QUERY_NAME) === LEADER_RUNTIME_QUERY_VALUE) {
      hasExplicitTrayIntent = true;
    }
  } catch {}

  const fromPath = parseTrayUrlValue(locationHref);
  if (fromPath?.joinUrl) return fromPath.joinUrl;
  if (fromPath?.trayId) hasExplicitTrayIntent = true;

  if (hasExplicitTrayIntent) return null;
  const stored = parseTrayJoinUrlValue(storage?.getItem(TRAY_JOIN_STORAGE_KEY) ?? null);
  return stored?.joinUrl ?? null;
}

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
