/**
 * Worker→page bridges: proxied fetch, secrets, secret-request, mount, sudo.
 */
import type { PanelRpcHandlers } from '../../kernel/panel-rpc.js';

/**
 * `secrets-bridge`: relay a `secrets.crud` control message from the kernel
 * worker (which has no `chrome`) to the thin-bridge extension. This handler
 * runs in the PAGE realm, so `callSecretsBridge` takes its direct-Port branch
 * (a) — `chrome.runtime.connect(<delegateId>, { name: 'secrets.crud' })` — and
 * returns the SW handler's `sendResponse` shape verbatim. Mirrors the
 * `proxied-fetch` worker→page delegate; secret values never cross the bridge,
 * only HMAC-masked replicas / scrubbed text.
 */
export function buildSecretsBridgeHandler() {
  return {
    'secrets-bridge': async ({ type, payload }) => {
      const { callSecretsBridge } = await import('../../core/secrets-bridge-client.js');
      const response = await callSecretsBridge(type, payload);
      return { response };
    },
  } satisfies Partial<PanelRpcHandlers>;
}

/**
 * `mount-sign-and-forward`: relay an S3 / DA mount envelope from the kernel
 * worker (which has no `chrome`) to the thin-bridge extension. This handler
 * runs in the PAGE realm, so `callMountBridge` takes its direct-Port branch
 * (a) — `chrome.runtime.connect(<delegateId>, { name: 'mount.sign-and-forward'
 * })` — and returns the SW's `SignAndForwardReply` verbatim. Mirrors the
 * `secrets-bridge` worker→page delegate; S3 credentials never cross the bridge
 * (the SW reads them from chrome.storage) and DA envelopes carry only a
 * transient IMS bearer the SW forwards (EXT8).
 */
export function buildMountBridgeHandler() {
  return {
    'mount-sign-and-forward': async ({ type, envelope }) => {
      const { callMountBridge } = await import('../../fs/mount/mount-bridge-client.js');
      const response = await callMountBridge(type, envelope);
      return { response };
    },
  } satisfies Partial<PanelRpcHandlers>;
}

/**
 * `sudo-request`: settle a sudo approval in the page realm on behalf of the
 * kernel-worker broker. The page is where the tray leader lives, so it can
 * delegate the prompt to a follower's human (iOS + Face ID, issue #2062); it
 * also owns the in-page dialog for floats with no native modal. `mode`
 * decides whether the page must settle (`resolve`) or may decline and let the
 * worker's native broker run (`tray-first`) — see `page-approval-service.ts`.
 * The request already carries the worker-computed `suggestedPattern`. Mirrors
 * the `proxied-fetch` worker→page delegate.
 */
export function buildSudoRequestHandler() {
  return {
    'sudo-request': async ({ request, mode }) => {
      const { resolveSudoApprovalInPage } = await import('../../sudo/page-approval-service.js');
      return resolveSudoApprovalInPage(request, mode ?? 'resolve');
    },
  } satisfies Partial<PanelRpcHandlers>;
}

/**
 * `secret-request`: raise the page's secret-entry dialog for a worker-realm
 * caller (today the `request_secret` tool) and return the VALUE-FREE outcome.
 *
 * The registry is consulted per call rather than captured: the surface is
 * installed during leader boot, so a tool constructed earlier still resolves it.
 * An absent surface resolves `{ stored: false, reason: 'unavailable' }` instead
 * of rejecting — "this float cannot collect a secret" is an answer the caller
 * reports to the user, not a transport failure.
 */
export function buildSecretRequestHandler() {
  return {
    'secret-request': async (payload) => {
      const { getSecretRequestSurface } = await import('../../base/secret-request-registry.js');
      const surface = getSecretRequestSurface();
      if (!surface) return { stored: false, reason: 'unavailable' };
      return surface(payload);
    },
  } satisfies Partial<PanelRpcHandlers>;
}

/**
 * `proxied-fetch`: bridge a worker-realm shell fetch to the thin-bridge
 * extension. The kernel worker has no `chrome`, so it forwards the request
 * here; the page realm opens the `chrome.runtime` Port to the extension via
 * `collectViaExtensionDelegate` (which reads the page-realm `extensionDelegateId`
 * set at boot) and returns the RAW streamed head + body. The forbidden-header
 * transport is encoded exactly once inside the collector — the worker sends
 * PLAIN headers — and the worker finalizes the returned bytes so its own
 * binary-cache is populated.
 */
export function buildProxiedFetchHandler() {
  return {
    'proxied-fetch': async ({ url, method, headers, body }) => {
      const { collectViaExtensionDelegate } = await import('../../shell/proxied-fetch.js');
      const { head, body: respBody } = await collectViaExtensionDelegate(url, {
        method,
        headers,
        // Uint8Array binary bodies are structured-clone-safe; prepareRequestBody
        // wraps them as a Blob. The SecureFetch type still says `string`.
        body: body as string | undefined,
      });
      return { head, body: respBody };
    },
  } satisfies Partial<PanelRpcHandlers>;
}
