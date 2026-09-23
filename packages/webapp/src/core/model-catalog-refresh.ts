import { getProviders as getBundledProviders } from '@earendil-works/pi-ai/compat';
import { isFeatureEnabled } from './feature-flags.js';
import {
  defaultStorage,
  field,
  isPlainObject,
  MODEL_CATALOG_STORAGE_KEY,
  type ModelCatalogEntry,
  type ModelCatalogStorage,
  type ModelCatalogStore,
  readStore,
} from './model-catalog.js';

export const MODEL_CATALOG_ROUTE_PREFIX = '/api/models/providers/';

export const MODEL_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4_000;
const MAX_MODELS_PER_PROVIDER = 2_000;

export interface ModelCatalogRefreshOptions {
  workerBaseUrl: string;

  providers: readonly string[];

  force?: boolean;
  fetchImpl?: typeof fetch;
  storage?: ModelCatalogStorage | null;
  now?: () => number;
  timeoutMs?: number;
}

export interface ModelCatalogRefreshResult {
  updated: string[];

  failed: string[];
}

function catalogEntries(body: unknown): object[] | null {
  const list = Array.isArray(body)
    ? body
    : isPlainObject(body) && Array.isArray(field(body, 'models'))
      ? (field(body, 'models') as unknown[])
      : isPlainObject(body)
        ? Object.values(body)
        : null;
  if (!list) return null;
  return list
    .filter(
      (entry): entry is object => isPlainObject(entry) && typeof field(entry, 'id') === 'string'
    )
    .slice(0, MAX_MODELS_PER_PROVIDER);
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

type ProviderOutcome =
  | { kind: 'skip' }
  | { kind: 'failed'; entry?: ModelCatalogEntry }
  | { kind: 'stored'; entry: ModelCatalogEntry; changed: boolean };

async function refreshProvider(
  providerId: string,
  stored: ModelCatalogEntry | undefined,
  options: Required<
    Pick<ModelCatalogRefreshOptions, 'workerBaseUrl' | 'fetchImpl' | 'timeoutMs'>
  > & {
    force: boolean;
    now: number;
  }
): Promise<ProviderOutcome> {
  if (
    !options.force &&
    stored?.checkedAt !== undefined &&
    options.now - stored.checkedAt < MODEL_CATALOG_REFRESH_INTERVAL_MS
  ) {
    return { kind: 'skip' };
  }
  const url = new URL(
    `${MODEL_CATALOG_ROUTE_PREFIX}${encodeURIComponent(providerId)}`,
    `${options.workerBaseUrl.replace(/\/+$/, '')}/`
  ).toString();

  const etag = stored?.models.length ? stored.etag : undefined;
  let response: Response;
  try {
    response = await fetchWithTimeout(
      options.fetchImpl,
      url,
      { headers: { Accept: 'application/json', ...(etag ? { 'If-None-Match': etag } : {}) } },
      options.timeoutMs
    );
  } catch {
    return { kind: 'failed', entry: stored ? { ...stored, checkedAt: options.now } : undefined };
  }
  if (response.status === 304 && stored) {
    return { kind: 'stored', entry: { ...stored, checkedAt: options.now }, changed: false };
  }
  if (response.status === 404) {
    return {
      kind: 'stored',
      entry: { models: [], checkedAt: options.now, lastModified: 0 },
      changed: true,
    };
  }
  if (!response.ok) {
    return { kind: 'failed', entry: stored ? { ...stored, checkedAt: options.now } : undefined };
  }
  let entries: object[] | null;
  try {
    entries = catalogEntries(await response.json());
  } catch {
    entries = null;
  }
  if (!entries) return { kind: 'failed', entry: stored };
  const lastModified = Date.parse(response.headers.get('last-modified') ?? '');
  const entry: ModelCatalogEntry = {
    models: entries,
    checkedAt: options.now,
    lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
  };
  const newEtag = response.headers.get('etag');
  if (newEtag) entry.etag = newEtag;
  return { kind: 'stored', entry, changed: true };
}

export async function refreshModelCatalog(
  options: ModelCatalogRefreshOptions
): Promise<ModelCatalogRefreshResult> {
  const result: ModelCatalogRefreshResult = { updated: [], failed: [] };
  if (!isFeatureEnabled('live-model-catalog')) return result;
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  if (!storage) return result;
  const known = new Set<string>(getBundledProviders());
  const providers = [...new Set(options.providers)].filter((id) => known.has(id));
  if (providers.length === 0) return result;

  const now = (options.now ?? Date.now)();
  const shared = {
    workerBaseUrl: options.workerBaseUrl,
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs: options.timeoutMs ?? FETCH_TIMEOUT_MS,
    force: options.force === true,
    now,
  };
  const before = readStore(storage).store;
  const outcomes = await Promise.all(
    providers.map(async (id) => [id, await refreshProvider(id, before[id], shared)] as const)
  );

  const next: ModelCatalogStore = { ...readStore(storage).store };
  let dirty = false;
  for (const [id, outcome] of outcomes) {
    if (outcome.kind === 'skip') continue;
    if (outcome.entry) {
      next[id] = outcome.entry;
      dirty = true;
    }
    if (outcome.kind === 'failed') result.failed.push(id);
    else if (outcome.changed) result.updated.push(id);
  }
  if (dirty) {
    try {
      storage.setItem(MODEL_CATALOG_STORAGE_KEY, JSON.stringify(next));
    } catch {}
  }
  return result;
}
