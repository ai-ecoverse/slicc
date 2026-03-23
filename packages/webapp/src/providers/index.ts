/**
 * Provider auto-discovery and registration.
 *
 * Pi-ai providers are auto-discovered via getProviders() — no config files needed.
 * This module handles two additional concerns:
 *
 * 1. Built-in extensions (packages/webapp/src/providers/built-in/*.ts) — providers that need custom
 *    stream functions via register(). Pure config-only providers don't need files here;
 *    they get fallback configs from provider-settings.ts.
 *
 * 2. External providers (/packages/webapp/providers/*.ts) — gitignored directory in the
 *    webapp package, always included. Used for custom OAuth providers (corporate SSO,
 *    API proxies).
 *
 * 3. Build-time filtering via packages/webapp/providers.build.json — controls which
 *    pi-ai providers appear in the UI. External providers are never filtered.
 *
 * Each provider module must export a `config: ProviderConfig`.
 * Modules may also export a `register(): void` function for custom stream functions.
 */

import type { ProviderConfig } from './types.js';

export type { ProviderConfig } from './types.js';

// ── Build config (controls which pi-ai providers appear in the UI) ───

interface BuildConfig {
  include: string[];
  exclude: string[];
}

const buildConfigFiles = import.meta.glob('/packages/webapp/providers.build.json', {
  eager: true,
  import: 'default',
}) as Record<string, BuildConfig>;

const buildConfig: BuildConfig = buildConfigFiles['/packages/webapp/providers.build.json'] ?? {
  include: ['*'],
  exclude: [],
};

/** Check if a pi-ai provider should be shown based on packages/webapp/providers.build.json. */
export function shouldIncludeProvider(providerId: string): boolean {
  const { include, exclude } = buildConfig;
  if (exclude.includes('*') || exclude.includes(providerId)) return false;
  if (include.includes('*')) return true;
  if (include.includes(providerId)) return true;
  return false;
}

// ── Provider module shape ───────────────────────────────────────────

interface ProviderModule {
  config?: ProviderConfig;
  register?: () => void;
}

// ── Discover built-in extensions (only those needing register()) ─────

const builtInModules = import.meta.glob('./built-in/*.ts', {
  eager: true,
}) as Record<string, ProviderModule>;

// ── Discover external providers ─────────────────────────────────────

const externalModules = import.meta.glob('/packages/webapp/providers/*.ts', {
  eager: true,
}) as Record<string, ProviderModule>;

// ── Build registry ──────────────────────────────────────────────────

const providerConfigRegistry = new Map<string, ProviderConfig>();

// Process built-in extensions (filtered by build config)
for (const [_path, mod] of Object.entries(builtInModules)) {
  if (!mod.config) continue;
  if (!shouldIncludeProvider(mod.config.id)) continue;
  providerConfigRegistry.set(mod.config.id, mod.config);
  mod.register?.();
}

// Process external providers (always included, never filtered)
for (const [_path, mod] of Object.entries(externalModules)) {
  if (!mod.config) continue;
  providerConfigRegistry.set(mod.config.id, mod.config);
  mod.register?.();
}

// ── Public API ──────────────────────────────────────────────────────

/** All registered provider configs (built-in extensions + external, post-filtering). */
export const allProviderConfigs: ReadonlyMap<string, ProviderConfig> = providerConfigRegistry;

/** Get a provider config by ID (registered providers only). */
export function getRegisteredProviderConfig(providerId: string): ProviderConfig | undefined {
  return providerConfigRegistry.get(providerId);
}

/** Get all registered provider IDs. */
export function getRegisteredProviderIds(): string[] {
  return [...providerConfigRegistry.keys()];
}
