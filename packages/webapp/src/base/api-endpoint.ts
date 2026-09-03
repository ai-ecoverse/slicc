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
 * re-probing on every call is pure waste — and every reader (`shell/proxied-
 * fetch.ts`, `scoops/tray-leader.ts`) is the SAME fact, asked repeatedly, not
 * an independent probe each needs to make. `null` means "not yet resolved";
 * `setChromeExtensionRealm` overrides it, mainly for tests that toggle
 * `globalThis.chrome` per test case after this module has already run its
 * first lazy probe.
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

/** Whether this realm is the real Chrome extension page. Cached after first read. */
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
