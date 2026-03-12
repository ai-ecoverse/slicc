/**
 * Provider auto-discovery and registration.
 *
 * Discovers providers from two locations:
 * 1. src/providers/built-in/*.ts — built-in providers, filtered by providers.build.json
 * 2. /providers/*.ts — external providers (gitignored directory at root), always included
 *
 * Each provider module must export a `config: ProviderConfig`.
 * Modules may also export a `register(): void` function to register custom stream functions.
 */

import type { ProviderConfig } from './types.js';

export type { ProviderConfig } from './types.js';

// ── Build config ────────────────────────────────────────────────────

interface BuildConfig {
  include: string[];
  exclude: string[];
}

const buildConfigFiles = import.meta.glob('/providers.build.json', {
  eager: true,
  import: 'default',
}) as Record<string, BuildConfig>;

const buildConfig: BuildConfig = buildConfigFiles['/providers.build.json'] ?? {
  include: ['*'],
  exclude: [],
};

// ── Provider module shape ───────────────────────────────────────────

interface ProviderModule {
  config?: ProviderConfig;
  register?: () => void;
}

// ── Discover built-in providers ─────────────────────────────────────

const builtInModules = import.meta.glob('./built-in/*.ts', {
  eager: true,
}) as Record<string, ProviderModule>;

// ── Discover external providers ─────────────────────────────────────

const externalModules = import.meta.glob('/providers/*.ts', {
  eager: true,
}) as Record<string, ProviderModule>;

// ── Filtering logic ─────────────────────────────────────────────────

function shouldIncludeBuiltIn(providerId: string): boolean {
  const { include, exclude } = buildConfig;

  // Check exclude first — exclude: ["*"] blocks everything
  if (exclude.includes('*') || exclude.includes(providerId)) {
    return false;
  }

  // include: ["*"] means all built-ins (minus excluded)
  if (include.includes('*')) {
    return true;
  }

  // Explicit include list — only those providers
  if (include.includes(providerId)) {
    return true;
  }

  // Not in include list (or include is empty) — exclude
  return false;
}

// ── Build registry ──────────────────────────────────────────────────

const providerConfigRegistry = new Map<string, ProviderConfig>();

// Process built-in providers (filtered by build config)
for (const [_path, mod] of Object.entries(builtInModules)) {
  if (!mod.config) continue;
  if (!shouldIncludeBuiltIn(mod.config.id)) continue;
  providerConfigRegistry.set(mod.config.id, mod.config);
  mod.register?.();
}

// Process external providers (always included)
for (const [_path, mod] of Object.entries(externalModules)) {
  if (!mod.config) continue;
  providerConfigRegistry.set(mod.config.id, mod.config);
  mod.register?.();
}

// ── Public API ──────────────────────────────────────────────────────

/** All registered provider configs (built-in + external, post-filtering). */
export const allProviderConfigs: ReadonlyMap<string, ProviderConfig> = providerConfigRegistry;

/** Get a provider config by ID, with fallback for unknown providers. */
export function getRegisteredProviderConfig(providerId: string): ProviderConfig | undefined {
  return providerConfigRegistry.get(providerId);
}

/** Get all registered provider IDs. */
export function getRegisteredProviderIds(): string[] {
  return [...providerConfigRegistry.keys()];
}
