/**
 * MCP provider registration — exposes each authenticated MCP server as a
 * dynamic `mcp:<name>` entry in the provider registry so it surfaces in
 * `oauth-token --list` and silently renews through the standard
 * provider-bootstrap path.
 *
 * Registration is **lazy**: nothing happens at boot. `ensureMcpProviderRegistered`
 * is idempotent and is called from `mcp` subcommands the first time they run
 * after a page reload.
 */

import { createLogger } from '../../core/logger.js';
import { isExtensionRealm } from '../../core/runtime-env.js';
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
import {
  type DiscoveredAuth,
  discoverAuth,
  type FetchLike,
  refreshAccessToken,
  runAuthFlow,
} from './oauth.js';
import { type McpAuthEntry, readMcpAuthEntry } from './provider-store-access.js';

const log = createLogger('mcp-provider');

/** Prefix used for MCP provider ids. */
export const MCP_PROVIDER_PREFIX = 'mcp:';

/**
 * Guard for environments without IndexedDB (Node-based tests, SSR). The MCP
 * store lives in IDB via LightningFS, so any read attempt schedules a deferred
 * `_activate` that rejects asynchronously with `ReferenceError: indexedDB is
 * not defined` and surfaces as an unhandled rejection in Vitest 4.
 */
function hasIndexedDB(): boolean {
  return typeof globalThis !== 'undefined' && typeof (globalThis as any).indexedDB !== 'undefined';
}

/** Public id formatter — `name` -> `mcp:<name>`. */
export function mcpProviderId(name: string): string {
  return `${MCP_PROVIDER_PREFIX}${name}`;
}

export interface RegisterMcpProviderOptions {
  /** Short server name (matches the key in `servers.json`). */
  name: string;
  /** Full server URL (used to derive the unmask domain). */
  serverUrl: string;
  /** The persisted auth block produced by `mcp add`. */
  auth: McpAuthEntry;
  /**
   * Injected fetch — defaults to a thin wrapper around `createProxiedFetch()`.
   * Tests pass a stub.
   */
  fetchImpl?: FetchLike;
  /**
   * Override the OAuth launcher (test-only). Defaults to
   * `createOAuthLauncher()` from `providers/oauth-service.ts`.
   */
  launcher?: OAuthLauncher;
}

/** In-session cache of resolved AS metadata per provider id. */
const discoveryCache = new Map<string, DiscoveredAuth>();

/** Track which providers we've already registered in this page session. */
const registeredInSession = new Set<string>();

async function defaultRedirectUri(): Promise<string> {
  // Extension offscreen runtime: chrome.identity.launchWebAuthFlow only
  // completes against the deterministic `<extension-id>.chromiumapp.org`
  // redirect, so the URI registered at DCR time must match.
  if (isExtensionRealm()) {
    const chromeApi = chrome as any;
    return (
      chromeApi.identity?.getRedirectURL?.('mcp-callback') ??
      `https://${chromeApi.runtime.id}.chromiumapp.org/mcp-callback`
    );
  }
  // CLI / standalone: the popup→postMessage + /api/oauth-result polling
  // path captures the redirect on the page origin.
  const { getOAuthPageOrigin } = await import('../../providers/oauth-service.js');
  const { origin } = await getOAuthPageOrigin();
  return `${origin}/auth/callback`;
}

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

/** Build a {@link ProviderConfig} for the given MCP server. */
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
    // Not an LLM provider — no models, no streamFn.
    getModelIds: () => [],

    onOAuthLogin: async (launcher, onSuccess) => {
      const effectiveLauncher = opts.launcher ?? launcher;
      const fetchImpl = await resolveFetchImpl(opts.fetchImpl);
      const asMetadata = await ensureDiscovery(opts);
      const token = await runAuthFlow({
        asMetadata,
        clientId: opts.auth.clientId,
        scope: opts.auth.scope,
        redirectUri: await defaultRedirectUri(),
        launcher: effectiveLauncher,
        fetchImpl,
      });
      await saveOAuthAccount({
        providerId: id,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        tokenExpiresAt: token.expiresAt,
      });
      onSuccess();
    },

    onSilentRenew: async () => {
      // getOAuthAccountInfo doesn't surface refreshToken, so read the
      // Account record directly. We still call getOAuthAccountInfo first to
      // surface a clean "not logged in" path matching other providers.
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

/**
 * Register an MCP server as a `mcp:<name>` provider. Subsequent calls with
 * the same name are no-ops (the registry's `Map.set` would overwrite, but
 * the session cache short-circuits before we rebuild the config).
 */
export function registerMcpProvider(opts: RegisterMcpProviderOptions): void {
  const id = mcpProviderId(opts.name);
  if (registeredInSession.has(id)) return;
  const cfg = buildProviderConfig(opts);
  registerProviderConfig(cfg);
  registeredInSession.add(id);
  log.debug('Registered MCP provider', { id });
}

/**
 * Idempotent lazy-registration helper. Reads `/workspace/.mcp/servers.json`,
 * finds the entry for `name`, and registers the provider if it isn't
 * already registered in this page session. Returns true if the provider is
 * (now) registered, false if there is no matching server entry or it has
 * no `auth` block yet (e.g. `mcp add` failed before persisting auth).
 */
export async function ensureMcpProviderRegistered(name: string): Promise<boolean> {
  const id = mcpProviderId(name);
  if (registeredInSession.has(id) && getRegisteredProviderConfig(id)) return true;
  if (!hasIndexedDB()) return false;
  const entry = await readMcpAuthEntry(name);
  if (!entry) return false;
  registerMcpProvider({ name, serverUrl: entry.serverUrl, auth: entry.auth });
  return true;
}

/** Bulk variant — registers every server with an `auth` block. */
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

/**
 * Remove a previously-registered MCP provider in this session (used by
 * `mcp delete`). Symmetric with `removeOAuthAccount` in provider-settings.
 * Returns true if anything was removed.
 */
export function removeMcpProvider(name: string): boolean {
  const id = mcpProviderId(name);
  registeredInSession.delete(id);
  discoveryCache.delete(id);
  return unregisterProviderConfig(id);
}

/** Test-only helpers — reset module-level caches between tests. */
export function _testOnly_resetMcpProviderState(): void {
  registeredInSession.clear();
  discoveryCache.clear();
}
