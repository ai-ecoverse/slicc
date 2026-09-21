import type { SliccPermissions } from '@slicc/webcomponents';

import type { PanelRpcHandlers } from '../../kernel/panel-rpc.js';
import { apiHeaders, resolveApiUrl } from '../../shell/proxied-fetch.js';
import type { StandalonePanelRpcHandlerOptions } from '../panel-rpc-handlers.js';
import { getAllExtraOAuthDomains, setExtraOAuthDomains } from '../provider-settings.js';

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
      setExtraOAuthDomains(providerId, domains);
      return { storeAfter: getAllExtraOAuthDomains() };
    },

    'silent-renew': async ({ providerId }) => {
      const { getRegisteredProviderConfig } = await import('../../providers/index.js');
      const cfg = getRegisteredProviderConfig(providerId);
      if (!cfg?.onSilentRenew) return { accessToken: null };
      return { accessToken: await cfg.onSilentRenew() };
    },

    'save-oauth-accounts': ({ accountsJson }) => {
      localStorage.setItem('slicc_accounts', accountsJson);
      const storedJson = localStorage.getItem('slicc_accounts') ?? accountsJson;
      return { storedJson };
    },
  } satisfies Partial<PanelRpcHandlers>;
}

export async function openOAuthPopup(
  authorizeUrl: string,
  getPermissionsSurface?: () => SliccPermissions | null
): Promise<string | null> {
  const ua = (typeof navigator !== 'undefined' ? navigator.userActivation : undefined) as
    | { isActive?: boolean }
    | undefined;
  if (ua?.isActive === true) {
    const popup = window.open(authorizeUrl, '_blank', 'width=500,height=700,popup=yes');
    return runOauthPopupRace(popup);
  }
  const surface = getPermissionsSurface?.() ?? null;
  if (surface) {
    const popup = await openOAuthPopupViaSurface(surface, authorizeUrl);
    if (popup === undefined) return null;
    return runOauthPopupRace(popup);
  }

  const popup = window.open(authorizeUrl, '_blank', 'width=500,height=700,popup=yes');
  return runOauthPopupRace(popup);
}

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

    pollTimer = setInterval(async () => {
      if (resolved) return;
      try {
        const res = await fetch(resolveApiUrl('/api/oauth-result'), {
          headers: apiHeaders(),
        });
        if (res.status === 204) return;
        if (!res.ok) return;
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
      } catch {}
      resolve(null);
    }, 120_000);
  });
}

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
