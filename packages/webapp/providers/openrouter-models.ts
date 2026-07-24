/**
 * OpenRouter model catalog helpers.
 *
 * Adapted from espennilsen/pi's MIT-licensed pi-openrouter extension:
 * https://github.com/espennilsen/pi/blob/main/extensions/pi-openrouter/src/models.ts
 */

import { OPENROUTER_MODELS } from '@earendil-works/pi-ai/providers/openrouter.models';
import type { ModelMetadata } from '../src/providers/types.js';

const MODELS_URL = 'https://openrouter.ai/api/v1/models';
const MODELS_STORAGE_KEY = 'slicc.openrouter.models';
const FILTER_STORAGE_KEY = 'slicc.openrouter.modelFilter';
const FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_PATTERNS = ['*'] as const;

/** Raw model returned by OpenRouter's /api/v1/models endpoint. */
export interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  };
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
    is_moderated?: boolean;
  };
  supported_parameters?: string[];
}

/** Common shape shared by live entries and pi-ai's static seed models. */
export interface OpenRouterCatalogModel {
  id: string;
  name: string;
  context_length?: number;
  architecture?: OpenRouterModel['architecture'];
  top_provider?: OpenRouterModel['top_provider'];
  supported_parameters?: readonly string[];
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: readonly string[];
}

export type OpenRouterModelMetadata = { id: string; name: string } & ModelMetadata;

let liveCatalog: OpenRouterModel[] | null = null;

export function loadCache(): OpenRouterModel[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(MODELS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as OpenRouterModel[]) : [];
  } catch {
    return [];
  }
}

export function saveCache(models: readonly OpenRouterModel[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(MODELS_STORAGE_KEY, JSON.stringify(models));
  } catch {
    // Quota or storage access denied — the in-memory catalog still works.
  }
}

export async function fetchModels(): Promise<OpenRouterModel[]> {
  const response = await fetch(MODELS_URL, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch OpenRouter models: ${response.status} ${response.statusText}`.trim()
    );
  }

  const body = (await response.json()) as { data?: unknown };
  if (!Array.isArray(body.data)) {
    throw new Error('Failed to fetch OpenRouter models: response did not contain a data array');
  }
  const models = body.data as OpenRouterModel[];
  liveCatalog = models;
  saveCache(models);
  return models;
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export function filterModels<T extends { id: string }>(
  models: readonly T[],
  patterns: readonly string[] = DEFAULT_PATTERNS
): T[] {
  const effectivePatterns = patterns.length > 0 ? patterns : DEFAULT_PATTERNS;
  const regexes = effectivePatterns.map(patternToRegex);
  return models.filter((model) => regexes.some((regex) => regex.test(model.id)));
}

export function loadFilterPatterns(): string[] {
  if (typeof localStorage === 'undefined') return [...DEFAULT_PATTERNS];
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return [...DEFAULT_PATTERNS];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [...DEFAULT_PATTERNS];
    const patterns = parsed.filter(
      (pattern): pattern is string => typeof pattern === 'string' && pattern.length > 0
    );
    return patterns.length > 0 ? patterns : [...DEFAULT_PATTERNS];
  } catch {
    return [...DEFAULT_PATTERNS];
  }
}

export function toModelMetadata(model: OpenRouterCatalogModel): OpenRouterModelMetadata {
  const modalities = model.architecture?.input_modalities ?? model.input ?? ['text'];
  return {
    id: model.id,
    name: model.name,
    api: 'openai',
    context_window: model.context_length ?? model.contextWindow ?? 128_000,
    max_tokens: model.top_provider?.max_completion_tokens ?? model.maxTokens ?? 16_384,
    reasoning:
      model.supported_parameters?.includes('include_reasoning') ?? model.reasoning ?? false,
    input: modalities.includes('image') ? ['text', 'image'] : ['text'],
  };
}

/** Synchronous catalog reader for ProviderConfig.getModelIds(). */
export function getCatalog(): OpenRouterModelMetadata[] {
  const cached = loadCache();
  const source: readonly OpenRouterCatalogModel[] =
    liveCatalog ?? (cached.length > 0 ? cached : Object.values(OPENROUTER_MODELS));
  return filterModels(source, loadFilterPatterns()).map(toModelMetadata);
}
