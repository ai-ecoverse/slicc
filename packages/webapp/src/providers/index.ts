import type { ProviderConfig } from './types.js';

export type { ProviderConfig } from './types.js';

interface BuildConfig {
  include: string[];
  exclude: string[];
}

const buildConfigFiles = import.meta.glob('/packages/dev-tools/providers.build.json', {
  eager: true,
  import: 'default',
}) as Record<string, BuildConfig>;

const buildConfig: BuildConfig = buildConfigFiles['/packages/dev-tools/providers.build.json'] ?? {
  include: ['*'],
  exclude: [],
};

export function shouldIncludeProvider(providerId: string): boolean {
  const { include, exclude } = buildConfig;
  if (exclude.includes('*') || exclude.includes(providerId)) return false;
  if (include.includes('*')) return true;
  if (include.includes(providerId)) return true;
  return false;
}

interface ProviderModule {
  config?: ProviderConfig;
  register?: () => void;
}

const builtInModules = import.meta.glob('./built-in/*.ts') as Record<
  string,
  () => Promise<ProviderModule>
>;

const externalModules = import.meta.glob('/packages/webapp/providers/*.ts') as Record<
  string,
  () => Promise<ProviderModule>
>;

const providerConfigRegistry = new Map<string, ProviderConfig>();

let registerPromise: Promise<void> | null = null;

export function registerProviders(): Promise<void> {
  if (registerPromise !== null) return registerPromise;
  registerPromise = (async () => {
    const builtIn = await Promise.all(Object.values(builtInModules).map((load) => load()));

    for (const mod of builtIn) {
      if (!mod.config) continue;
      if (!shouldIncludeProvider(mod.config.id)) continue;
      providerConfigRegistry.set(mod.config.id, mod.config);
      mod.register?.();
    }
    const external = await Promise.all(Object.values(externalModules).map((load) => load()));

    for (const mod of external) {
      if (!mod.config) continue;
      providerConfigRegistry.set(mod.config.id, mod.config);
      mod.register?.();
    }
  })();
  return registerPromise;
}

export const allProviderConfigs: ReadonlyMap<string, ProviderConfig> = providerConfigRegistry;

export function getRegisteredProviderConfig(providerId: string): ProviderConfig | undefined {
  return providerConfigRegistry.get(providerId);
}

export function getRegisteredProviderIds(): string[] {
  return [...providerConfigRegistry.keys()];
}

export function registerProviderConfig(config: ProviderConfig): void {
  providerConfigRegistry.set(config.id, config);
}

export function unregisterProviderConfig(providerId: string): boolean {
  return providerConfigRegistry.delete(providerId);
}
