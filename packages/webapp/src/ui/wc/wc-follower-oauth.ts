import type { SliccPermissions } from '@slicc/webcomponents';
import { createLogger } from '../../base/logger.js';

const log = createLogger('follower-oauth');

const OAUTH_RELAY_CHANNEL = 'slicc-oauth-relay';

const OAUTH_POPUP_TIMEOUT_MS = 120_000;

const POPUP_CLOSED_GRACE_MS = 1500;

export interface DelegatedOAuthPopupDeps {
  getPermissionsSurface: () => SliccPermissions | null;
  window: Window;
}

interface CallbackMessage {
  type?: string;
  redirectUrl?: string;
  nonce?: string;
}

export function expectedNonceFromAuthorizeUrl(authorizeUrl: string): string | null {
  try {
    const state = new URL(authorizeUrl).searchParams.get('state');
    if (!state) return null;
    const decoded = JSON.parse(atob(state)) as { nonce?: unknown };
    return typeof decoded.nonce === 'string' && decoded.nonce ? decoded.nonce : null;
  } catch {
    return null;
  }
}

function runFollowerOAuthRace(
  popup: Window | null,
  deps: DelegatedOAuthPopupDeps,
  signal: AbortSignal,
  expectedNonce: string | null
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const cleanups: Array<() => void> = [];
    let settled = false;
    const settle = (value: string | null): void => {
      if (settled) return;
      settled = true;
      for (const cleanup of cleanups) cleanup();
      try {
        popup?.close();
      } catch {}
      resolve(value);
    };

    const accept = (data: CallbackMessage | undefined, via: string): void => {
      if (data?.type !== 'oauth-callback' || typeof data.redirectUrl !== 'string') return;

      if (expectedNonce && data.nonce && data.nonce !== expectedNonce) {
        log.debug('Ignoring an OAuth callback for a different flow', { via });
        return;
      }
      log.info('Delegated OAuth callback received', { via });
      settle(data.redirectUrl);
    };

    try {
      const channel = new BroadcastChannel(OAUTH_RELAY_CHANNEL);
      channel.onmessage = (event) => accept(event.data as CallbackMessage, 'broadcast');
      cleanups.push(() => channel.close());
    } catch (err) {
      log.warn('BroadcastChannel unavailable for OAuth delivery', { error: String(err) });
    }

    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== deps.window.location.origin) return;
      accept(event.data as CallbackMessage, 'postMessage');
    };
    deps.window.addEventListener('message', onMessage);
    cleanups.push(() => deps.window.removeEventListener('message', onMessage));

    if (popup) {
      const poll = setInterval(() => {
        if (!popup.closed) return;
        clearInterval(poll);

        const grace = setTimeout(() => settle(null), POPUP_CLOSED_GRACE_MS);
        cleanups.push(() => clearTimeout(grace));
      }, 500);
      cleanups.push(() => clearInterval(poll));
    }

    const timeout = setTimeout(() => {
      log.warn('Delegated OAuth popup timed out');
      settle(null);
    }, OAUTH_POPUP_TIMEOUT_MS);
    cleanups.push(() => clearTimeout(timeout));

    const onAbort = (): void => settle(null);
    signal.addEventListener('abort', onAbort);
    cleanups.push(() => signal.removeEventListener('abort', onAbort));
    if (signal.aborted) settle(null);
  });
}

export async function openDelegatedOAuthPopup(
  url: string,
  signal: AbortSignal,
  deps: DelegatedOAuthPopupDeps
): Promise<string | null> {
  if (signal.aborted) return null;
  const surface = deps.getPermissionsSurface();
  if (!surface) {
    throw new Error('no permissions surface available to approve the login');
  }

  const result = await surface.prompt({
    kinds: ['popup'],
    description: 'Continue to sign in. A new window will open to the provider.',
    grantLabel: 'Continue',
    requestOptions: { popup: { url } },
  });
  if (result.status !== 'granted') return null;
  const grant = result.grants.find((g) => g.kind === 'popup');
  const popup = grant && grant.kind === 'popup' ? grant.window : null;

  return runFollowerOAuthRace(popup, deps, signal, expectedNonceFromAuthorizeUrl(url));
}
