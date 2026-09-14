import { createLogger } from '../../base/logger.js';
import {
  getAccounts,
  getOAuthAccountInfo,
  saveOAuthAccount,
} from '../../providers/account-store.js';
import {
  getRegisteredProviderConfig,
  registerProviderConfig,
  unregisterProviderConfig,
} from '../../providers/index.js';
import type { OAuthLauncher, ProviderConfig } from '../../providers/types.js';
import { resolveFloatTopology } from '../float-topology.js';
import {
  type DiscoveredAuth,
  discoverAuth,
  type FetchLike,
  refreshAccessToken,
  runAuthFlow,
} from './oauth.js';
import { type McpAuthEntry, readMcpAuthEntry } from './provider-store-access.js';
import { resolveMcpRedirectUri } from './redirect-uri.js';

const log = createLogger('mcp-provider');

export const MCP_PROVIDER_PREFIX = 'mcp:';

function hasIndexedDB(): boolean {
  return (
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as { indexedDB?: unknown }).indexedDB !== 'undefined'
  );
}

export function mcpProviderId(name: string): string {
  return `${MCP_PROVIDER_PREFIX}${name}`;
}

export interface RegisterMcpProviderOptions {
  name: string;

  serverUrl: string;

  auth: McpAuthEntry;

  fetchImpl?: FetchLike;

  launcher?: OAuthLauncher;
}

const discoveryCache = new Map<string, DiscoveredAuth>();

const registeredInSession = new Set<string>();

async function resolveFetchImpl(override?: FetchLike): Promise<FetchLike> {
  if (override) return override;
  const { createProxiedFetch } = await import('../proxied-fetch.js');
  const fn = createProxiedFetch();
  return async (url, init) => {
    const res = await fn(url, {
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
    });
    const decoder = new TextDecoder();
    const bodyText = decoder.decode(res.body);
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      statusText: res.statusText,
      text: async () => bodyText,
      json: async () => JSON.parse(bodyText) as unknown,
      headers: {
        get: (name: string) => res.headers[name.toLowerCase()] ?? null,
      },
    };
  };
}

async function ensureDiscovery(opts: RegisterMcpProviderOptions): Promise<DiscoveredAuth> {
  const cached = discoveryCache.get(mcpProviderId(opts.name));
  if (cached) return cached;
  const fetchImpl = await resolveFetchImpl(opts.fetchImpl);
  const meta = await discoverAuth(opts.serverUrl, undefined, fetchImpl);
  discoveryCache.set(mcpProviderId(opts.name), meta);
  return meta;
}

function buildProviderConfig(opts: RegisterMcpProviderOptions): ProviderConfig {
  const id = mcpProviderId(opts.name);
  const host = (() => {
    try {
      return new URL(opts.serverUrl).host;
    } catch {
      return '';
    }
  })();
  return {
    id,
    name: `MCP: ${opts.name}`,
    description: `MCP server at ${opts.serverUrl}`,
    requiresApiKey: false,
    requiresBaseUrl: false,
    isOAuth: true,
    oauthTokenDomains: host ? [host] : [],

    getModelIds: () => [],

    onOAuthLogin: async (launcher, onSuccess) => {
      const effectiveLauncher = opts.launcher ?? launcher;
      const fetchImpl = await resolveFetchImpl(opts.fetchImpl);
      const asMetadata = await ensureDiscovery(opts);
      const token = await runAuthFlow({
        asMetadata,
        clientId: opts.auth.clientId,
        scope: opts.auth.scope,
        redirectUri: opts.auth.redirectUri ?? (await resolveMcpRedirectUri(resolveFloatTopology())),
        launcher: effectiveLauncher,
        fetchImpl,
      });
      await saveOAuthAccount({
        providerId: id,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        tokenExpiresAt: token.expiresAt,
        scopes: token.scope,
      });
      onSuccess();
    },

    onSilentRenew: async () => {
      const info = getOAuthAccountInfo(id);
      if (!info) return null;
      const account = getAccounts().find((a) => a.providerId === id);
      const refreshToken = account?.refreshToken;
      if (!refreshToken) {
        log.info('No refresh token for MCP provider, skipping silent renewal', { id });
        return null;
      }
      try {
        const asMetadata = await ensureDiscovery(opts);
        const grants = asMetadata.grantTypes ?? [];
        if (grants.length > 0 && !grants.includes('refresh_token')) {
          log.info('AS does not advertise refresh_token grant; skipping silent renewal', { id });
          return null;
        }
        const fetchImpl = await resolveFetchImpl(opts.fetchImpl);
        const rotated = await refreshAccessToken({
          tokenEndpoint: asMetadata.tokenEndpoint,
          clientId: opts.auth.clientId,
          refreshToken,
          scope: opts.auth.scope,
          fetchImpl,
        });
        await saveOAuthAccount({
          providerId: id,
          accessToken: rotated.accessToken,
          refreshToken: rotated.refreshToken ?? refreshToken,
          tokenExpiresAt: rotated.expiresAt,
          scopes: rotated.scope ?? account.scopes,
        });
        return rotated.accessToken;
      } catch (err) {
        log.warn('MCP silent renewal failed', {
          id,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },
  };
}

export function registerMcpProvider(opts: RegisterMcpProviderOptions): void {
  const id = mcpProviderId(opts.name);
  if (registeredInSession.has(id)) return;
  const cfg = buildProviderConfig(opts);
  registerProviderConfig(cfg);
  registeredInSession.add(id);
  log.debug('Registered MCP provider', { id });
}

export async function ensureMcpProviderRegistered(
  name: string,
  overrides: Pick<RegisterMcpProviderOptions, 'fetchImpl' | 'launcher'> = {}
): Promise<boolean> {
  const id = mcpProviderId(name);
  if (registeredInSession.has(id) && getRegisteredProviderConfig(id)) return true;
  if (!hasIndexedDB()) return false;
  const entry = await readMcpAuthEntry(name);
  if (!entry) return false;
  registerMcpProvider({ name, serverUrl: entry.serverUrl, auth: entry.auth, ...overrides });
  return true;
}

export async function ensureAllMcpProvidersRegistered(): Promise<string[]> {
  if (!hasIndexedDB()) return [];
  const { readMcpAuthEntries } = await import('./provider-store-access.js');
  const entries = await readMcpAuthEntries();
  const registered: string[] = [];
  for (const e of entries) {
    registerMcpProvider({ name: e.name, serverUrl: e.serverUrl, auth: e.auth });
    registered.push(mcpProviderId(e.name));
  }
  return registered;
}

export function removeMcpProvider(name: string): boolean {
  const id = mcpProviderId(name);
  registeredInSession.delete(id);
  discoveryCache.delete(id);
  return unregisterProviderConfig(id);
}

export function testOnlyResetMcpProviderState(): void {
  registeredInSession.clear();
  discoveryCache.clear();
}
