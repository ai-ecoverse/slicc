const TRAY_WORKER_STORAGE_KEY = 'slicc.trayWorkerBaseUrl';
const TRAY_WORKER_QUERY_PARAM = 'trayWorkerUrl';

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
