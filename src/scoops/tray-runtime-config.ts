export const TRAY_WORKER_STORAGE_KEY = 'slicc.trayWorkerBaseUrl';
export const TRAY_WORKER_QUERY_PARAM = 'trayWorkerUrl';
export const TRAY_QUERY_PARAM = 'tray';
export const TRAY_LEGACY_LEAD_QUERY_PARAM = 'lead';

export interface TrayUrlConfig {
  workerBaseUrl: string;
  trayId: string | null;
}

export interface RuntimeConfigStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface RuntimeConfigResponse {
  trayWorkerBaseUrl?: string | null;
}

export function normalizeTrayWorkerBaseUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;

  try {
    const url = new URL(raw.trim());
    url.search = '';
    url.hash = '';
    if (url.pathname !== '/') {
      url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    }
    const normalized = url.toString();
    return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  } catch {
    return null;
  }
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
    if (segments.length >= 2 && segments.at(-2) === 'tray') {
      trayId = decodeURIComponent(segments.at(-1)!);
      segments.splice(-2, 2);
      url.pathname = segments.length > 0 ? `/${segments.join('/')}` : '/';
    }

    const workerBaseUrl = normalizeTrayWorkerBaseUrl(url.toString());
    if (!workerBaseUrl) {
      return null;
    }

    return { workerBaseUrl, trayId };
  } catch {
    return null;
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

export function buildTrayLaunchUrl(locationHref: string, workerBaseUrl: string, trayId?: string | null): string {
  const url = new URL(locationHref);
  url.searchParams.delete(TRAY_WORKER_QUERY_PARAM);
  url.searchParams.delete(TRAY_LEGACY_LEAD_QUERY_PARAM);
  url.searchParams.set(TRAY_QUERY_PARAM, buildTrayUrlValue(workerBaseUrl, trayId));
  return url.toString();
}

export function parseTrayLeadValue(raw: string | null | undefined): TrayUrlConfig | null {
  return parseTrayUrlValue(raw);
}

export function buildTrayLeadValue(workerBaseUrl: string, trayId?: string | null): string {
  return buildTrayUrlValue(workerBaseUrl, trayId);
}

export function buildTrayLeadLaunchUrl(locationHref: string, workerBaseUrl: string, trayId?: string | null): string {
  return buildTrayLaunchUrl(locationHref, workerBaseUrl, trayId);
}

export async function resolveTrayWorkerBaseUrl(options: {
  locationHref: string;
  storage?: RuntimeConfigStorage | null;
  envBaseUrl?: string | null;
  runtimeConfigFetcher?: (() => Promise<RuntimeConfigResponse | null>) | null;
}): Promise<string | null> {
  const queryBaseUrl = readQueryTrayWorkerBaseUrl(options.locationHref);
  const serverBaseUrl = options.runtimeConfigFetcher ? await readServerTrayWorkerBaseUrl(options.runtimeConfigFetcher) : null;
  const storedBaseUrl = normalizeTrayWorkerBaseUrl(options.storage?.getItem(TRAY_WORKER_STORAGE_KEY) ?? null);
  const envBaseUrl = normalizeTrayWorkerBaseUrl(options.envBaseUrl ?? null);

  const resolved = queryBaseUrl ?? serverBaseUrl ?? storedBaseUrl ?? envBaseUrl;
  if (resolved && options.storage) {
    options.storage.setItem(TRAY_WORKER_STORAGE_KEY, resolved);
  }
  return resolved;
}

export async function fetchRuntimeConfig(fetchImpl: typeof fetch = fetch): Promise<RuntimeConfigResponse | null> {
  try {
    const response = await fetchImpl('/api/runtime-config', { cache: 'no-store' });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as RuntimeConfigResponse;
  } catch {
    return null;
  }
}

function readQueryTrayWorkerBaseUrl(locationHref: string): string | null {
  try {
    const url = new URL(locationHref);

    const trayConfig = parseTrayUrlValue(url.searchParams.get(TRAY_QUERY_PARAM));
    if (trayConfig) {
      return trayConfig.workerBaseUrl;
    }

    const legacyLeadConfig = parseTrayUrlValue(url.searchParams.get(TRAY_LEGACY_LEAD_QUERY_PARAM));
    if (legacyLeadConfig) {
      return legacyLeadConfig.workerBaseUrl;
    }

    return normalizeTrayWorkerBaseUrl(url.searchParams.get(TRAY_WORKER_QUERY_PARAM));
  } catch {
    return null;
  }
}

async function readServerTrayWorkerBaseUrl(
  runtimeConfigFetcher: () => Promise<RuntimeConfigResponse | null>,
): Promise<string | null> {
  const config = await runtimeConfigFetcher();
  return normalizeTrayWorkerBaseUrl(config?.trayWorkerBaseUrl ?? null);
}
