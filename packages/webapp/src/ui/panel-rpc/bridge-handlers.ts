import type { PanelRpcHandlers } from '../../kernel/panel-rpc.js';

export function buildSecretsBridgeHandler() {
  return {
    'secrets-bridge': async ({ type, payload }) => {
      const { callSecretsBridge } = await import('../../core/secrets-bridge-client.js');
      const response = await callSecretsBridge(type, payload);
      return { response };
    },
  } satisfies Partial<PanelRpcHandlers>;
}

export function buildMountBridgeHandler() {
  return {
    'mount-sign-and-forward': async ({ type, envelope }) => {
      const { callMountBridge } = await import('../../fs/mount/mount-bridge-client.js');
      const response = await callMountBridge(type, envelope);
      return { response };
    },
  } satisfies Partial<PanelRpcHandlers>;
}

export function buildSudoRequestHandler() {
  return {
    'sudo-request': async ({ request, mode }) => {
      const { resolveSudoApprovalInPage } = await import('../../sudo/page-approval-service.js');
      return resolveSudoApprovalInPage(request, mode ?? 'resolve');
    },
  } satisfies Partial<PanelRpcHandlers>;
}

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

export function buildProxiedFetchHandler() {
  return {
    'proxied-fetch': async ({ url, method, headers, body }) => {
      const { collectViaExtensionDelegate } = await import('../../shell/proxied-fetch.js');
      const { head, body: respBody } = await collectViaExtensionDelegate(url, {
        method,
        headers,

        body: body as string | undefined,
      });
      return { head, body: respBody };
    },
  } satisfies Partial<PanelRpcHandlers>;
}
