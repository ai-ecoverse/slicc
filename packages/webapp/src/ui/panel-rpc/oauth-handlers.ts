/**
 * Tray lifecycle, OAuth storage writes, and the page-side OAuth popup.
 */
import type { SliccPermissions } from '@slicc/webcomponents';

import type { PanelRpcHandlers } from '../../kernel/panel-rpc.js';
import { apiHeaders, resolveApiUrl } from '../../shell/proxied-fetch.js';
import type { StandalonePanelRpcHandlerOptions } from '../panel-rpc-handlers.js';
import { getAllExtraOAuthDomains, setExtraOAuthDomains } from '../provider-settings.js';

/** Tray lifecycle, cherry emit, and OAuth storage writes. */
export function buildTrayOauthHandlers(options: StandalonePanelRpcHandlerOptions) {
  return {
    'tray-reset': async () => {
      if (!options.resetTray) {
        throw new Error('host reset: no active tray session to reset');
      }
      return await options.resetTray();
    },

    'tray-webhook-rotate': async () => {
      if (!options.rotateWebhook) {
        throw new Error('webhook rotate: no active leader tray');
      }
      return await options.rotateWebhook();
    },

    'tray-webhook-revoke': async (payload) => {
      if (!options.revokeWebhook) throw new Error('webhook delete: no active leader tray');
      await options.revokeWebhook(payload.webhookId);
      return { ok: true };
    },

    'tray-open-preview': async (payload) => {
      if (!options.mintPreview) {
        throw new Error('serve: no active leader tray; cannot mint preview');
      }
      return await options.mintPreview(payload);
    },

    'tray-revoke-preview': async (payload) => {
      if (!options.revokePreview) {
        throw new Error('serve: no active leader tray; cannot revoke preview');
      }
      return await options.revokePreview(payload);
    },

    'tray-list-previews': async () => {
      if (!options.listPreviews) {
        throw new Error('serve: no active leader tray; cannot list previews');
      }
      return await options.listPreviews();
    },

    // Payloads forwarded WHOLE, never rebuilt field-by-field — a rebuild at a
    // boundary is how `approver`, `requester` and `approverJid` were each
    // silently dropped elsewhere in this feature.
    'tray-mint-biscotto': async (payload) => {
      if (!options.mintBiscotto) {
        throw new Error('biscotto: no active leader tray; cannot mint a seat');
      }
      return await options.mintBiscotto(payload);
    },

    'tray-revoke-biscotto': async (payload) => {
      if (!options.revokeBiscotto) {
        throw new Error('biscotto revoke: no active leader tray; cannot revoke a seat');
      }
      return await options.revokeBiscotto(payload);
    },

    'tray-list-biscotti': async () => {
      if (!options.listBiscotti) {
        throw new Error('biscotti: no active leader tray; cannot list seats');
      }
      return await options.listBiscotti();
    },

    'tray-preview-logs': async ({ previewToken }) => {
      if (!options.getPreviewLifecycleRecords) {
        throw new Error('serve --logs: no active leader tray; cannot read preview logs');
      }
      return options.getPreviewLifecycleRecords(previewToken);
    },

    'tray-preview-truncate': async ({ previewToken }) => {
      if (!options.truncatePreviewLifecycleRecords) {
        throw new Error('serve --truncate: no active leader tray; cannot truncate preview logs');
      }
      return options.truncatePreviewLifecycleRecords(previewToken);
    },

    'tray-leave': async ({ workerBaseUrl, requestId }) => {
      if (!options.leaveTray) {
        throw new Error('host leave: tray leave is not available in this environment');
      }
      return await options.leaveTray({ workerBaseUrl, requestId });
    },

    'tray-join': async ({ joinUrl, requestId }) => {
      if (!options.joinTray) {
        throw new Error('host join: tray join is not available in this environment');
      }
      return await options.joinTray({ joinUrl, requestId });
    },

    'cherry-emit': async ({ runtimeId, name, detail }) => {
      if (!options.emitCherrySliccEvent) {
        throw new Error('cherry-emit: not available in this environment');
      }
      return { delivered: options.emitCherrySliccEvent(runtimeId, name, detail) };
    },

    'tray-exec': async (payload) => {
      if (!options.execOnRemote) {
        throw new Error('ssh: no active leader tray in this environment');
      }
      return await options.execOnRemote(payload);
    },

    'tray-exec-signal': ({ execToken }) => {
      options.signalRemoteExec?.({ execToken });
      return { ok: true };
    },

    'tray-computer-native': async (payload) => {
      if (!options.computerNative) {
        throw new Error('computer native: no active leader tray in this environment');
      }
      return await options.computerNative(payload);
    },

    'oauth-extras-set': ({ providerId, domains }) => {
      // Page-side write to real `window.localStorage` for the
      // `oauth-domain` shell command running in the kernel worker.
      // `installPageStorageSync` patches `Storage.prototype.setItem`
      // so this write also fans out to the worker shim — but on a
      // different channel than the panel-rpc response, with no
      // ordering guarantee. Returning the full post-write store lets
      // the worker mirror it into its shim before resolving so a
      // follow-up `oauth-domain list` in the same session sees the
      // new value without waiting for the cross-channel forward.
      setExtraOAuthDomains(providerId, domains);
      return { storeAfter: getAllExtraOAuthDomains() };
    },

    'silent-renew': async ({ providerId }) => {
      // Page-side silent token renewal for a worker-realm provider that
      // can't drive the IMS popup/iframe flow without a `window` (issue
      // #1181). Runs the provider's registered `onSilentRenew`, which
      // persists the rotated token via `saveOAuthAccount` so it fans back
      // into the worker's localStorage shim. Returns null when the provider
      // is unknown or exposes no renewal hook.
      const { getRegisteredProviderConfig } = await import('../../providers/index.js');
      const cfg = getRegisteredProviderConfig(providerId);
      if (!cfg?.onSilentRenew) return { accessToken: null };
      return { accessToken: await cfg.onSilentRenew() };
    },

    'save-oauth-accounts': ({ accountsJson }) => {
      // Page-side write of `slicc_accounts` for `saveOAuthAccount`
      // calls originating in the kernel worker (`mcp add`, MCP
      // `onSilentRenew`). Same shim trap as `oauth-extras-set`:
      // worker writes to its Map-backed shim don't echo back to the
      // page, so without this bridge the MCP OAuth account is lost
      // on reload (issue #701). Returning the stored JSON lets the
      // worker mirror it into its shim immediately, avoiding a race
      // with the `local-storage-set` forward.
      localStorage.setItem('slicc_accounts', accountsJson);
      const storedJson = localStorage.getItem('slicc_accounts') ?? accountsJson;
      return { storedJson };
    },
  } satisfies Partial<PanelRpcHandlers>;
}

// ── OAuth popup (page-side) ─────────────────────────────────────────

/**
 * Open an OAuth popup and wait for the /auth/callback page to deliver
 * the redirect URL back. Mirrors `launchOAuthCli` from
 * `oauth-service.ts` but runs inside a panel-RPC handler so worker-side
 * commands (e.g. `oauth-token adobe`, `silentRenewToken`) can reach
 * `window.open` through the bridge.
 *
 * The popup is opened through the leader `<slicc-permissions>` surface
 * (when mounted) as a gesture-gated `popup` permission — the user's
 * Allow-button click supplies the user activation that worker-initiated
 * `window.open` otherwise lacks (the panel-RPC call is async, so the
 * ambient activation has been consumed). When the surface is unavailable
 * (tests, transitional boot) it falls back to a direct `window.open`.
 *
 * Two parallel signals race to deliver the redirect URL:
 *   1. postMessage from the /auth/callback page back to this window (only
 *      accepted from `window.location.origin` below — this is the ONLY
 *      signal that can ever fire in the legacy same-origin case, and can
 *      never fire in thin-bridge mode, where the callback page is always
 *      served cross-origin from the local node-server).
 *   2. Polling /api/oauth-result on the backing server — the sole signal
 *      that works in thin-bridge mode (`window.opener` staying intact
 *      doesn't help there; the callback page now always POSTs the result
 *      regardless of opener — see `oauth-callback.ts`), and also covers
 *      Electron overlay mode where window.open spawns the system browser.
 *
 * Whichever signal arrives first wins; the other is cancelled in
 * cleanup(). The 120 s timeout still applies.
 */
export async function openOAuthPopup(
  authorizeUrl: string,
  getPermissionsSurface?: () => SliccPermissions | null
): Promise<string | null> {
  // Fast path: when a fresh transient user activation still exists (e.g. the
  // panel-RPC `oauth-popup` op was triggered by a page-realm gesture such as
  // a terminal Enter keystroke), skip the surface prompt and open directly.
  // The typical worker-initiated path (agent `oauth-token <provider>`) has
  // crossed an `await` and `isActive` is false → falls through to the
  // gesture-gated prompt.
  const ua = (typeof navigator !== 'undefined' ? navigator.userActivation : undefined) as
    | { isActive?: boolean }
    | undefined;
  if (ua?.isActive === true) {
    const popup = window.open(authorizeUrl, '_blank', 'width=500,height=700,popup=yes');
    return runOauthPopupRace(popup);
  }
  const surface = getPermissionsSurface?.() ?? null;
  if (surface) {
    // Gesture-gated path: the user's Allow click on the permissions
    // surface supplies the user activation `window.open` needs (the
    // panel-RPC call to `oauth-popup` has already crossed an `await`,
    // so the original ambient activation is gone).
    const popup = await openOAuthPopupViaSurface(surface, authorizeUrl);
    if (popup === undefined) return null;
    return runOauthPopupRace(popup);
  }
  // No leader surface mounted yet (tests, transitional boot): fall back
  // to direct `window.open`. Synchronous so any ambient user activation
  // that may still be in scope is preserved.
  const popup = window.open(authorizeUrl, '_blank', 'width=500,height=700,popup=yes');
  return runOauthPopupRace(popup);
}

/**
 * Shared postMessage + `/api/oauth-result` poll race used by both the
 * gesture-gated and fallback paths above.
 */
function runOauthPopupRace(popup: Window | null): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let resolved = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      window.removeEventListener('message', handler);
      clearTimeout(timer);
      if (pollTimer) clearInterval(pollTimer);
    };

    const handler = (event: MessageEvent) => {
      if (event.data?.type !== 'oauth-callback') return;
      // Only accept messages from the same origin (the /auth/callback page)
      // and from the popup window we opened. This prevents spoofing by
      // arbitrary frames or cross-origin windows.
      if (event.origin !== window.location.origin) return;
      if (popup && event.source !== popup) return;
      cleanup();
      if (event.data.error) {
        console.error('[panel-rpc:oauth-popup] OAuth error:', event.data.error);
        resolve(null);
        return;
      }
      const redirectUrl = event.data.redirectUrl;
      if (typeof redirectUrl !== 'string' && redirectUrl !== null && redirectUrl !== undefined)
        return;
      resolve(redirectUrl ?? null);
    };

    window.addEventListener('message', handler);

    // Always poll the server for the OAuth result as a fallback to
    // postMessage. The callback page POSTs the result to /api/oauth-result
    // when window.opener is null; both node-server and swift-server stash
    // it for GET retrieval. Whichever signal arrives first wins.
    pollTimer = setInterval(async () => {
      if (resolved) return;
      try {
        const res = await fetch(resolveApiUrl('/api/oauth-result'), {
          headers: apiHeaders(),
        });
        if (res.status === 204) return;
        if (!res.ok) return; // server hiccup — keep polling
        const data = (await res.json()) as { redirectUrl?: string; error?: string };
        if (resolved) return;
        cleanup();
        if (data.error) {
          console.error('[panel-rpc:oauth-popup] Server relay OAuth error:', data.error);
          resolve(null);
          return;
        }
        resolve(data.redirectUrl ?? null);
      } catch (err) {
        // Network error or JSON parse failure — log and keep polling
        console.warn(
          '[panel-rpc:oauth-popup] Poll failed:',
          err instanceof Error ? err.message : String(err)
        );
      }
    }, 1000);

    const timer = setTimeout(() => {
      cleanup();
      try {
        popup?.close();
      } catch {
        /* best-effort */
      }
      resolve(null);
    }, 120_000);
  });
}

/**
 * Open the OAuth popup via the leader `<slicc-permissions>` surface so the
 * `window.open` call lives inside the Allow-button click handler's user
 * activation. Returns:
 *   - `Window` when the user allowed and the window opened
 *   - `null` when the surface granted but `window.open` returned null
 *     (popup blocked)
 *   - `undefined` when the user cancelled the surface prompt — caller
 *     should resolve the outer flow to null without surfacing an error
 */
async function openOAuthPopupViaSurface(
  surface: SliccPermissions,
  authorizeUrl: string
): Promise<Window | null | undefined> {
  const result = await surface.prompt({
    kinds: ['popup'],
    description: 'Continue to sign in. A new window will open to the provider.',
    grantLabel: 'Continue',
    requestOptions: { popup: { url: authorizeUrl } },
  });
  if (result.status !== 'granted') return undefined;
  const popupGrant = result.grants.find((g) => g.kind === 'popup');
  return popupGrant && popupGrant.kind === 'popup' ? popupGrant.window : null;
}
