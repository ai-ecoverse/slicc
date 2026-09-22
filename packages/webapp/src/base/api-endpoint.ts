/**
 * Bridge endpoint configuration — where a same-origin `/api/*` call actually
 * goes, and what capability it carries.
 *
 * Four module-level singletons, each set once per realm: the local
 * node-server origin, the per-process bridge token, and the thin-bridge
 * extension delegate id (each set explicitly during boot), plus the
 * real-extension-realm answer (lazily probed once, see
 * `getChromeExtensionRealm`). `resolveApiUrl` and `apiHeaders` are the two
 * readers every `/api/*` caller goes through.
 *
 * This lives in `base/` rather than next to `createProxiedFetch` because the
 * readers are needed a rung below the shell — `fs/mount/` builds its
 * sign-and-forward calls with them, and an `fs → shell` import would invert
 * the layer stack. `shell/proxied-fetch.ts` re-exports the whole surface, so
 * existing callers are unaffected.
 *
 * State is per module instance: the page realm and the kernel-worker realm
 * hold independent copies and each configures its own.
 */

import { isChromeExtensionRealm } from '@slicc/shared-ts';

/**
 * Optional absolute origin (e.g. `http://localhost:5710`) the CLI mode
 * should prepend to `/api/fetch-proxy`. Set in thin-bridge mode where
 * the hosted leader (sliccy.ai) serves the UI cross-origin but has no
 * local /api surface — the bridge launch params carry the local
 * node-server origin, which is wired here via `setLocalApiBaseUrl`.
 * Page realm and kernel-worker realm have independent module instances;
 * each calls the setter once during boot.
 */
let localApiBaseUrl: string | null = null;

/**
 * Per-process bridge token paired with `localApiBaseUrl`. When set, the
 * CLI-mode fetcher attaches it as the `X-Bridge-Token` header so the
 * local node-server's thin-bridge middleware accepts the cross-origin
 * call — the origin allowlist alone is insufficient because any script
 * on a remote allowlisted origin (e.g. `https://www.sliccy.ai`) would
 * otherwise reach /api unchallenged. Treat as a session capability:
 * never log, never put on a URL, never expose via a Referer.
 */
let bridgeToken: string | null = null;

/**
 * Set the absolute origin CLI-mode proxied fetches should target. Pass
 * `null` to fall back to same-origin (the legacy bundled-UI path).
 * Trailing slashes are trimmed so we never double-slash the path.
 */
export function setLocalApiBaseUrl(baseUrl: string | null): void {
  if (baseUrl === null || baseUrl === '') {
    localApiBaseUrl = null;
    return;
  }
  localApiBaseUrl = baseUrl.replace(/\/+$/, '');
}

/** Test-only accessor for the currently configured local API base. */
export function getLocalApiBaseUrl(): string | null {
  return localApiBaseUrl;
}

/**
 * Set the per-process bridge token CLI-mode proxied fetches should send
 * as `X-Bridge-Token` on cross-origin /api/fetch-proxy calls. Pass `null`
 * or an empty string to clear. Called from the boot path (page realm via
 * `setupStandalonePrelude`, worker realm via `kernel-worker`) once the
 * `bridgeToken` launch param has been parsed.
 */
export function setBridgeToken(token: string | null): void {
  bridgeToken = token === null || token === '' ? null : token;
}

/** Test-only accessor for the currently configured bridge token. */
export function getBridgeToken(): string | null {
  return bridgeToken;
}

/**
 * Extension id of the thin-bridge leader's extension, used to open a
 * `chrome.runtime.connect(<extensionId>, { name: 'fetch-proxy.fetch' })`
 * Port from the externally-connectable hosted leader page (where
 * `chrome.runtime.id` is undefined but `chrome.runtime.connect` exists).
 * Set in two realms during boot: the page realm (`setupStandalonePrelude`,
 * from the `?ext=<id>` launch param) and the kernel-worker realm
 * (`kernel-worker` boot, forwarded via `KernelWorkerInitMsg`). `null`
 * outside the thin-bridge extension leader (the real extension page uses
 * the id-less `chrome.runtime.connect({ name })` path instead).
 */
let extensionDelegateId: string | null = null;

/**
 * Set the thin-bridge extension delegate id. Pass `null` or an empty
 * string to clear. Mirrors `setBridgeToken` / `setLocalApiBaseUrl`: each
 * realm calls it once during boot.
 */
export function setExtensionDelegateId(id: string | null): void {
  extensionDelegateId = id === null || id === '' ? null : id;
}

/** Test-only accessor for the currently configured extension delegate id. */
export function getExtensionDelegateId(): string | null {
  return extensionDelegateId;
}

/**
 * Whether this realm IS the real Chrome extension page (offscreen / options /
 * side panel — `chrome.runtime.id` truthy), lazily probed via
 * `isChromeExtensionRealm()` on first read and cached. The fact is stable for
 * a realm's lifetime (the extension page never becomes a different page), so
 * re-probing on every call is pure waste — and every reader is the SAME fact,
 * asked repeatedly, not an independent probe each needs to make. `null` means
 * "not yet resolved"; `setChromeExtensionRealm` overrides it, mainly for
 * tests that toggle `globalThis.chrome` per test case after this module has
 * already run its first lazy probe.
 *
 * THIS IS STILL A FLOAT PROBE — caching it does not relocate the decision, it
 * only dedupes the read. `scoops/`, `tools/` and `kernel/` (except
 * `kernel/host.ts`, the one composition root) must never call
 * `getChromeExtensionRealm()`: business logic there asks an injected
 * `CapabilityBroker` or takes a composition-time answer, it never asks "am I
 * in the extension?" itself (#2276, review-patterns category 10). Only
 * `shell/` and `base/` — the layers that OWN topology — may read it; see
 * `shell/proxied-fetch.ts` and `shell/tray-fetch.ts`. Slice D's lint gate
 * bans this name (and `setChromeExtensionRealm`) for those directories
 * alongside `isExtensionRealm` / `hasLocalNodeServer` / `resolveFloatTopology`
 * — see `work-unit/capability/index.ts`.
 */
let chromeExtensionRealm: boolean | null = null;

/**
 * Override (or, with `null`, clear) the cached extension-realm answer so the
 * next `getChromeExtensionRealm()` call re-probes. Production code never
 * calls this — the lazy probe is the real answer and it never changes mid
 * realm; it exists for tests that stub `globalThis.chrome` per test case.
 */
export function setChromeExtensionRealm(value: boolean | null): void {
  chromeExtensionRealm = value;
}

/**
 * Whether this realm is the real Chrome extension page. Cached after first
 * read — a float probe, not a business-logic call; see the field doc above
 * for who may read it.
 */
export function getChromeExtensionRealm(): boolean {
  if (chromeExtensionRealm === null) {
    chromeExtensionRealm = isChromeExtensionRealm();
  }
  return chromeExtensionRealm;
}

/**
 * Resolve a same-origin `/api/*` path to the absolute URL the bridge
 * configuration says to target. With no `setLocalApiBaseUrl` set (legacy
 * bundled-UI, same-origin case) the path is returned unchanged so
 * `fetch(resolveApiUrl('/api/secrets'))` keeps the relative-URL behavior
 * every existing caller expects. In thin-bridge mode (hosted leader on
 * sliccy.ai, local node-server cross-origin) the configured base is
 * prepended so the call reaches the local /api surface. `path` must
 * include the leading slash — we deliberately do not normalize it so
 * accidental `api/...` callers fail loudly instead of producing
 * `${base}api/...`.
 */
export function resolveApiUrl(path: string): string {
  return localApiBaseUrl ? `${localApiBaseUrl}${path}` : path;
}

/**
 * Build the request headers for a same-origin `/api/*` call, layering an
 * optional `extra` overrides record on top of the bridge-token header.
 * `X-Bridge-Token` is attached ONLY when both a bridge token and a local
 * API base are configured (i.e. the cross-origin thin-bridge case). On
 * the legacy same-origin path the token is omitted even if set — the
 * local node-server doesn't require it for loopback origins, and
 * sending it would needlessly leak a session capability. `extra` wins
 * over the bridge token if a caller deliberately overrides it.
 */
export function apiHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  if (bridgeToken && localApiBaseUrl) {
    headers['X-Bridge-Token'] = bridgeToken;
  }
  if (extra) {
    for (const k of Object.keys(extra)) {
      headers[k] = extra[k];
    }
  }
  return headers;
}

/**
 * Body `error` the local node-server returns when `X-Bridge-Token` is missing
 * or no longer the process token (launcher restart).
 */
export const BRIDGE_TOKEN_REQUIRED_ERROR = 'bridge-token-required';

/** `Error.code` for a boot that must stop because the bridge rejected the token. */
export const STALE_BRIDGE_TOKEN_CODE = 'stale-bridge-token';

/**
 * Shown on the Failed-to-start screen. Reloading the same URL keeps the
 * rejected query token; the launcher mints a new one.
 */
export const STALE_BRIDGE_TOKEN_MESSAGE =
  "This tab's bridge token is no longer valid — the launcher restarted. Reload from the launcher.";

export class StaleBridgeTokenError extends Error {
  readonly code = STALE_BRIDGE_TOKEN_CODE;

  constructor() {
    super(STALE_BRIDGE_TOKEN_MESSAGE);
    this.name = 'StaleBridgeTokenError';
  }
}

export function isStaleBridgeTokenError(err: unknown): err is StaleBridgeTokenError {
  if (err instanceof StaleBridgeTokenError) return true;
  if (!(err instanceof Error)) return false;
  return (err as Error & { code?: unknown }).code === STALE_BRIDGE_TOKEN_CODE;
}

/** Minimal response shape so callers can pass a real `Response` or a test double. */
export interface BridgeStatusResponse {
  status: number;
  clone(): { json(): Promise<unknown> };
}

/**
 * Throw {@link StaleBridgeTokenError} when `response` is the bridge's
 * token rejection. Other statuses and unreadable bodies are ignored so a
 * down or unrelated 403 keeps today's fail-open boot behavior.
 */
export async function throwIfStaleBridgeToken(response: BridgeStatusResponse): Promise<void> {
  if (response.status !== 403) return;
  let errorField: unknown;
  try {
    const body = (await response.clone().json()) as { error?: unknown } | null;
    errorField = body?.error;
  } catch {
    return;
  }
  if (errorField === BRIDGE_TOKEN_REQUIRED_ERROR) {
    throw new StaleBridgeTokenError();
  }
}

/**
 * One local `/api/status` probe. No-op when this realm has no bridge token.
 * A network failure or a non-token 403 resolves; only `bridge-token-required`
 * rejects. Boot calls this before OAuth posts, the CDP retry loop, and the
 * kernel-ready wait.
 */
export async function assertLocalBridgeAcceptsToken(
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  if (!localApiBaseUrl || !bridgeToken) return;
  let response: Response;
  try {
    response = await fetchImpl(resolveApiUrl('/api/status'), {
      cache: 'no-store',
      headers: apiHeaders(),
      signal: AbortSignal.timeout(1500),
    });
  } catch (err) {
    if (isStaleBridgeTokenError(err)) throw err;
    return;
  }
  await throwIfStaleBridgeToken(response);
}
