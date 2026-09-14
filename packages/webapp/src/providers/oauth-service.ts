import { getLeaderPermissionsSurface } from '../core/permissions-surface-registry.js';
import { isExtensionRealm } from '../core/runtime-env.js';
import { getPanelRpcClient } from '../kernel/panel-rpc.js';
import { apiHeaders, resolveApiUrl } from '../shell/proxied-fetch.js';
import { createInterceptingOAuthLauncher } from './intercepted-oauth.js';
import type { InterceptingOAuthLauncher, OAuthLauncher } from './types.js';

const isExtension = isExtensionRealm();

export class OAuthLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthLaunchError';
  }
}

export async function resolveOAuthDelegation(): Promise<boolean> {
  if (typeof window !== 'undefined') return false;
  const rpcClient = getPanelRpcClient();
  if (!rpcClient) return false;
  try {
    const result = await rpcClient.call('oauth-route', {}, { timeoutMs: 5_000 });
    return result.delegate === true;
  } catch {
    return false;
  }
}

export function createOAuthLauncher(): OAuthLauncher {
  if (isExtension) return launchOAuthExtension;

  if (typeof window === 'undefined') return launchOAuthViaPanel;
  return launchOAuthCli;
}

export async function createInterceptingOAuthLauncherForCurrentRuntime(): Promise<InterceptingOAuthLauncher | null> {
  const transport = await resolveActiveCdpTransport();
  if (!transport) return null;
  return createInterceptingOAuthLauncher(transport);
}

async function resolveActiveCdpTransport() {
  try {
    const { getActiveCdpTransport } = await import('../cdp/active-transport.js');
    return await getActiveCdpTransport();
  } catch (err) {
    console.warn(
      '[oauth-service] could not resolve active CDP transport:',
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

export async function getOAuthPageOrigin(): Promise<{ origin: string; href: string }> {
  if (typeof window !== 'undefined') {
    return { origin: window.location.origin, href: window.location.href };
  }
  const rpc = getPanelRpcClient();
  if (!rpc) {
    throw new Error(
      'OAuth from worker context requires the panel-RPC bridge (no page-info available)'
    );
  }
  const info = await rpc.call('page-info', undefined);
  return { origin: info.origin, href: info.href };
}

async function launchOAuthViaPanel(authorizeUrl: string): Promise<string | null> {
  const rpcClient = getPanelRpcClient();
  if (!rpcClient) {
    console.error('[oauth-service] panel-RPC client unavailable in worker');
    return null;
  }
  try {
    const result = await rpcClient.call(
      'oauth-popup',
      { url: authorizeUrl },
      { timeoutMs: 130_000 }
    );

    if (!result.redirectUrl && result.error) {
      throw new OAuthLaunchError(result.error);
    }
    return result.redirectUrl;
  } catch (err) {
    if (err instanceof OAuthLaunchError) throw err;
    console.error(
      '[oauth-service] oauth-popup RPC failed:',
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

async function launchOAuthCli(authorizeUrl: string): Promise<string | null> {
  if (hasActiveUserActivation()) {
    const popup = window.open(authorizeUrl, '_blank', 'width=500,height=700,popup=yes');
    return runOAuthRedirectRace(popup);
  }
  const surface = getLeaderPermissionsSurface();
  if (surface) {
    const popup = await acquireOAuthPopupViaSurface(surface, authorizeUrl);
    if (popup === undefined) return null;
    return runOAuthRedirectRace(popup);
  }

  const popup = window.open(authorizeUrl, '_blank', 'width=500,height=700,popup=yes');
  return runOAuthRedirectRace(popup);
}

function hasActiveUserActivation(): boolean {
  const ua = (typeof navigator !== 'undefined' ? navigator.userActivation : undefined) as
    | { isActive?: boolean }
    | undefined;
  return ua?.isActive === true;
}

function runOAuthRedirectRace(popup: Window | null): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let resolved = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let closedTimer: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      window.removeEventListener('message', handler);
      clearTimeout(timer);
      if (pollTimer) clearInterval(pollTimer);
      if (closedTimer) clearInterval(closedTimer);
    };

    const handler = (event: MessageEvent) => {
      if (event.data?.type !== 'oauth-callback') return;
      if (event.origin !== window.location.origin) return;
      if (popup && event.source !== popup) return;
      cleanup();

      if (event.data.error) {
        console.error('[oauth-service] CLI OAuth error:', event.data.error);
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
          console.error('[oauth-service] Server relay OAuth error:', data.error);
          resolve(null);
          return;
        }

        resolve(data.redirectUrl ?? null);
      } catch (err) {
        console.warn(
          '[oauth-service] Poll failed:',
          err instanceof Error ? err.message : String(err)
        );
      }
    }, 1000);

    if (popup) {
      closedTimer = setInterval(() => {
        if (!popup.closed) return;
        clearInterval(closedTimer!);
        closedTimer = null;
        setTimeout(() => {
          if (!resolved) {
            cleanup();
            resolve(null);
          }
        }, 1500);
      }, 500);
    }

    const timer = setTimeout(() => {
      cleanup();
      try {
        popup?.close();
      } catch {}
      resolve(null);
    }, 120000);
  });
}

async function acquireOAuthPopupViaSurface(
  surface: import('@slicc/webcomponents').SliccPermissions,
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

export async function openIdpLogoutUrl(url: string, timeoutMs = 3 * 60 * 1000): Promise<void> {
  if (typeof window === 'undefined') return;
  if (isExtension) return;
  const popup = window.open(url, '_blank', 'width=500,height=600,popup=yes');
  if (!popup) {
    console.warn('[oauth-service] Could not open IdP logout popup — popups may be blocked');
    return;
  }

  await new Promise<void>((resolve) => {
    const deadline = setTimeout(() => {
      clearInterval(poll);
      try {
        popup.close();
      } catch {}
      resolve();
    }, timeoutMs);
    const poll = setInterval(() => {
      if (popup.closed) {
        clearTimeout(deadline);
        clearInterval(poll);
        resolve();
      }
    }, 500);
  });
}

async function launchOAuthExtension(
  authorizeUrl: string,
  opts?: { interactive?: boolean }
): Promise<string | null> {
  const runtime = (
    chrome as unknown as {
      runtime: {
        onMessage: {
          addListener(callback: (message: unknown) => void): void;
          removeListener(callback: (message: unknown) => void): void;
        };
        sendMessage(message: unknown): Promise<unknown>;
      };
    }
  ).runtime;
  return new Promise<string | null>((resolve) => {
    let resolved = false;
    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      runtime.onMessage.removeListener(handler);
      clearTimeout(timer);
    };

    const handler = (message: unknown) => {
      if (typeof message !== 'object' || message === null) return;
      const envelope = message as {
        source?: string;
        payload?: { type?: string; error?: string; redirectUrl?: string };
      };
      if (envelope.source !== 'service-worker') return;
      if (envelope.payload?.type !== 'oauth-result') return;
      cleanup();

      if (envelope.payload.error) {
        console.error('[oauth-service] Extension OAuth error:', envelope.payload.error);
        resolve(null);
        return;
      }

      resolve(envelope.payload.redirectUrl ?? null);
    };

    runtime.onMessage.addListener(handler);
    runtime
      .sendMessage({
        source: 'panel',
        payload: {
          type: 'oauth-request',
          providerId: 'oauth',
          authorizeUrl,
          interactive: opts?.interactive ?? true,
        },
      })
      .catch((err: unknown) => {
        console.error('[oauth-service] Failed to send OAuth request to service worker:', err);
      });

    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, 120000);
  });
}
