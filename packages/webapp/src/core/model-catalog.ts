/**
 * Live model catalogue: pi's hosted catalogue layered over pi-ai's bundled one.
 *
 * pi-ai ships a static model list per provider, frozen at its release. pi
 * itself refreshes that list at runtime (`pi update --models`, and a 4-hour
 * background refresh) from `https://pi.dev/api/models/providers/<id>`, so a
 * model the provider launched after the release shows up without an upgrade.
 * This module does the same for SLICC:
 *
 * - `refreshModelCatalog` (`model-catalog-refresh.ts`) fetches the hosted catalogue through the tray
 *   worker's same-origin relay (`/api/models/providers/<id>`; pi.dev sends no
 *   CORS headers) and stores it in `localStorage`, which the page mirrors into
 *   the kernel worker's storage shim.
 * - `getModels` / `getModel` read the stored overlay on top of pi-ai's bundled
 *   list. `core/index.ts` re-exports these in place of pi-ai's, so every
 *   catalogue read in the app sees the same merged view.
 *
 * pi's own rules carry over: a remote model replaces a bundled one with the
 * same id and new ids are appended, and a catalogue that is not newer than the
 * bundled data (`Last-Modified` ≤ pi-ai's generation time) is ignored.
 *
 * Two SLICC-specific guards, because this is remote data steering where API
 * keys are sent: a remote model is dropped unless its `api` and `baseUrl` both
 * already appear in that provider's bundled models, and only the fields of
 * pi-ai's `Model` shape SLICC relies on are copied (no `headers`).
 */

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

/** One provider's stored catalogue, the same record pi persists. */
export interface ModelCatalogEntry {
  /** Raw catalogue entries; validated when read, not when stored. */
  models: object[];
  checkedAt: number;
  /** `Last-Modified` of the catalogue, epoch ms; 0 when unknown. */
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

// ── Validation ──────────────────────────────────────────────────────

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

/**
 * A remote catalogue entry as a pi-ai `Model`, or null when it is malformed or
 * would send requests somewhere the bundled catalogue never does.
 */
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

// ── Overlay read path ───────────────────────────────────────────────

/**
 * Build-time copy of `getBuiltinModelDataGeneratedAt()`; that import would
 * pull pi-ai's whole data manifest into the boot graph. A build without the
 * define treats every stored catalogue as fresh.
 */
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

function mergeProvider(providerId: string, entry: ModelCatalogEntry): AnyModel[] {
  const bundled = bundledModels(providerId);
  if (bundled.length === 0) return bundled;
  const shape = bundledShape(bundled);
  const merged = [...bundled];
  const index = new Map(merged.map((m, i) => [m.id, i]));
  for (const raw of entry.models) {
    const model = sanitizeCatalogModel(providerId, raw, shape);
    if (!model) continue;
    const at = index.get(model.id);
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
  // Memoized per stored payload: catalogue reads are hot (every picker render
  // and model resolution) and re-validating hundreds of entries each time adds up.
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

/** pi-ai's bundled models for `provider`, plus the stored live catalogue. */
export function getModels<TProvider extends KnownProvider>(provider: TProvider): AnyModel[];
export function getModels(provider: string): AnyModel[];
export function getModels(provider: string): AnyModel[] {
  return [...overlayModels(provider, defaultStorage())];
}

/**
 * One model from the merged catalogue. Returns `undefined` for an unknown id,
 * as pi-ai's `getModel` does.
 */
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
/** Test-only: drop the memoized merge so a test can swap pi-ai mocks. */
export function __resetModelCatalogMemoForTests(): void {
  memoRaw = undefined;
  memoMerged = new Map();
}
