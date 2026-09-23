import type { Api, KnownProvider, Model } from '@earendil-works/pi-ai';
import {
  getModel as getBundledModel,
  getModels as getBundledModels,
  getProviders as getBundledProviders,
} from '@earendil-works/pi-ai/compat';
import { isFeatureEnabled } from './feature-flags.js';

export const MODEL_CATALOG_STORAGE_KEY = 'slicc_model_catalog';

export interface ModelCatalogStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ModelCatalogEntry {
  models: object[];
  checkedAt: number;

  lastModified: number;
  etag?: string;
}

export type ModelCatalogStore = Partial<Record<string, ModelCatalogEntry>>;

type AnyModel = Model<Api>;

export function defaultStorage(): ModelCatalogStorage | null {
  try {
    return (globalThis as { localStorage?: ModelCatalogStorage }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function isPlainObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function field(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

export function readStore(storage: ModelCatalogStorage | null): {
  raw: string | null;
  store: ModelCatalogStore;
} {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(MODEL_CATALOG_STORAGE_KEY) ?? null;
  } catch {
    return { raw: null, store: {} };
  }
  if (!raw) return { raw, store: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    return { raw, store: isPlainObject(parsed) ? (parsed as ModelCatalogStore) : {} };
  } catch {
    return { raw, store: {} };
  }
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function readCost(value: unknown): AnyModel['cost'] | null {
  if (!isPlainObject(value)) return null;
  const input = field(value, 'input');
  const output = field(value, 'output');
  const cacheRead = field(value, 'cacheRead');
  const cacheWrite = field(value, 'cacheWrite');
  if (
    !isFiniteNonNegative(input) ||
    !isFiniteNonNegative(output) ||
    !isFiniteNonNegative(cacheRead) ||
    !isFiniteNonNegative(cacheWrite)
  ) {
    return null;
  }
  return { input, output, cacheRead, cacheWrite };
}

function readInput(value: unknown): AnyModel['input'] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((entry) => entry === 'text' || entry === 'image')) return null;
  return [...value] as AnyModel['input'];
}

function readThinkingLevelMap(value: unknown): AnyModel['thinkingLevelMap'] | null | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) return null;
  const entries = Object.entries(value);
  if (!entries.every(([, level]) => level === null || typeof level === 'string')) return null;
  return Object.fromEntries(entries) as AnyModel['thinkingLevelMap'];
}

interface BundledShape {
  apis: Set<string>;
  baseUrls: Set<string>;
}

function bundledShape(bundled: readonly AnyModel[]): BundledShape {
  return {
    apis: new Set(bundled.map((m) => m.api)),
    baseUrls: new Set(bundled.map((m) => m.baseUrl)),
  };
}

export function sanitizeCatalogModel(
  providerId: string,
  value: unknown,
  shape: BundledShape
): AnyModel | null {
  if (!isPlainObject(value)) return null;
  const id = field(value, 'id');
  const name = field(value, 'name');
  const api = field(value, 'api');
  const baseUrl = field(value, 'baseUrl');
  const reasoning = field(value, 'reasoning');
  const contextWindow = field(value, 'contextWindow');
  const maxTokens = field(value, 'maxTokens');
  if (typeof id !== 'string' || id.length === 0 || id.length > 200) return null;
  if (typeof name !== 'string' || name.length === 0) return null;
  if (typeof api !== 'string' || !shape.apis.has(api)) return null;
  if (typeof baseUrl !== 'string' || !shape.baseUrls.has(baseUrl)) return null;
  if (typeof reasoning !== 'boolean') return null;
  if (!isFiniteNonNegative(contextWindow) || contextWindow === 0) return null;
  if (!isFiniteNonNegative(maxTokens) || maxTokens === 0) return null;
  const cost = readCost(field(value, 'cost'));
  const input = readInput(field(value, 'input'));
  const thinkingLevelMap = readThinkingLevelMap(field(value, 'thinkingLevelMap'));
  if (!cost || !input || thinkingLevelMap === null) return null;
  const compat = field(value, 'compat');
  const model: AnyModel = {
    id,
    name,
    api: api as Api,
    provider: providerId,
    baseUrl,
    reasoning,
    input,
    cost,
    contextWindow,
    maxTokens,
  };
  if (thinkingLevelMap) model.thinkingLevelMap = thinkingLevelMap;
  if (isPlainObject(compat)) model.compat = { ...compat } as AnyModel['compat'];
  return model;
}

function bundledGeneratedAt(): number | null {
  return typeof __PI_AI_MODELS_GENERATED_AT__ === 'number' ? __PI_AI_MODELS_GENERATED_AT__ : null;
}

let memoRaw: string | null | undefined;
let memoMerged = new Map<string, AnyModel[]>();

function bundledModels(providerId: string): AnyModel[] {
  try {
    return (getBundledModels as (provider: string) => AnyModel[])(providerId);
  } catch {
    return [];
  }
}

function isFresh(entry: ModelCatalogEntry | undefined): entry is ModelCatalogEntry {
  if (!entry || !Array.isArray(entry.models) || entry.models.length === 0) return false;
  const generatedAt = bundledGeneratedAt();
  if (generatedAt === null) return true;
  return typeof entry.lastModified === 'number' && entry.lastModified > generatedAt;
}

const REMOTE_OWNED_FIELDS = new Set<string>([
  'id',
  'name',
  'api',
  'provider',
  'baseUrl',
  'reasoning',
  'input',
  'cost',
  'contextWindow',
  'maxTokens',
  'thinkingLevelMap',
  'compat',
]);

function overBundled(
  model: AnyModel,
  sameId: AnyModel | undefined,
  bundled: readonly AnyModel[]
): AnyModel {
  if (sameId) {
    const inherited = Object.fromEntries(
      Object.entries(sameId).filter(([key]) => !REMOTE_OWNED_FIELDS.has(key))
    );
    return { ...inherited, ...model } as AnyModel;
  }
  const sibling = bundled.find(
    (m) => m.headers && m.api === model.api && m.baseUrl === model.baseUrl
  );
  return sibling?.headers ? { ...model, headers: { ...sibling.headers } } : model;
}

function mergeProvider(providerId: string, entry: ModelCatalogEntry): AnyModel[] {
  const bundled = bundledModels(providerId);
  if (bundled.length === 0) return bundled;
  const shape = bundledShape(bundled);
  const merged = [...bundled];
  const index = new Map(merged.map((m, i) => [m.id, i]));
  const bundledById = new Map(bundled.map((m) => [m.id, m]));
  for (const raw of entry.models) {
    const sanitized = sanitizeCatalogModel(providerId, raw, shape);
    if (!sanitized) continue;
    const at = index.get(sanitized.id);
    const model = overBundled(sanitized, bundledById.get(sanitized.id), bundled);
    if (at === undefined) {
      index.set(model.id, merged.length);
      merged.push(model);
    } else {
      merged[at] = model;
    }
  }
  return merged;
}

function overlayModels(providerId: string, storage: ModelCatalogStorage | null): AnyModel[] {
  if (!isFeatureEnabled('live-model-catalog')) return bundledModels(providerId);
  const { raw, store } = readStore(storage);
  const entry = store[providerId];
  if (!isFresh(entry)) return bundledModels(providerId);

  if (raw !== memoRaw) {
    memoRaw = raw;
    memoMerged = new Map();
  }
  let merged = memoMerged.get(providerId);
  if (!merged) {
    merged = mergeProvider(providerId, entry);
    memoMerged.set(providerId, merged);
  }
  return merged;
}

export function getModels<TProvider extends KnownProvider>(provider: TProvider): AnyModel[];
export function getModels(provider: string): AnyModel[];
export function getModels(provider: string): AnyModel[] {
  return [...overlayModels(provider, defaultStorage())];
}

export function getModel<TProvider extends KnownProvider>(
  provider: TProvider,
  modelId: string
): AnyModel;
export function getModel(provider: string, modelId: string): AnyModel;
export function getModel(provider: string, modelId: string): AnyModel {
  const hit = overlayModels(provider, defaultStorage()).find((m) => m.id === modelId);
  if (hit) return hit;
  return (getBundledModel as (p: string, id: string) => AnyModel)(provider, modelId);
}

export const getProviders = getBundledProviders;

export function __resetModelCatalogMemoForTests(): void {
  memoRaw = undefined;
  memoMerged = new Map();
}
