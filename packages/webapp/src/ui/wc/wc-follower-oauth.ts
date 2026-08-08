/**
 * Follower side of a leader-delegated OAuth login (issue #1915).
 *
 * The leader owns everything secret — PKCE/state/nonce, the code exchange,
 * account persistence. This module owns only what needs a human: an approval
 * prompt, the popup, and reporting the terminal callback URL back.
 *
 * Two things make this different from the leader's own popup path:
 *
 *  1. **Activation.** The request arrives over the tray, so there is no user
 *     activation left. The popup is opened inside the permissions surface's
 *     Continue click, exactly as `openOAuthPopupViaSurface` does on the leader.
 *  2. **Delivery.** The leader's `/api/oauth-result` poll is loopback-only and
 *     unreachable from another machine. Instead the follower listens for the
 *     worker relay's callback on a same-origin `BroadcastChannel` (COOP-proof:
 *     a provider serving `same-origin` severs `window.opener`) and, as a
 *     second signal, the classic opener `postMessage`.
 */

import type { SliccPermissions } from '@slicc/webcomponents';
import { createLogger } from '../../base/logger.js';

const log = createLogger('follower-oauth');

/** Same channel name the worker relay posts on. */
const OAUTH_RELAY_CHANNEL = 'slicc-oauth-relay';
/** Matches the leader-side popup race so both ends give up together. */
const OAUTH_POPUP_TIMEOUT_MS = 120_000;
/** Grace after the popup closes, so an in-flight callback can still land. */
const POPUP_CLOSED_GRACE_MS = 1500;

export interface DelegatedOAuthPopupDeps {
  /** The follower's permissions surface; null when none is mounted. */
  getPermissionsSurface: () => SliccPermissions | null;
  window: Window;
}

interface CallbackMessage {
  type?: string;
  redirectUrl?: string;
  nonce?: string;
}

/**
 * The CSRF nonce the leader embedded in this login's `state`.
 *
 * The relay's broadcast reaches every same-origin listener, so a second SLICC
 * tab with its own pending login would otherwise settle on this flow's
 * callback (and this one on its). Both sides already have the nonce — the
 * leader put it in `state`, the relay echoes it — so it is the natural
 * correlation id. Returns null for an authorize URL we cannot parse, in which
 * case the receiver falls back to accepting any callback.
 */
export function expectedNonceFromAuthorizeUrl(authorizeUrl: string): string | null {
  try {
    const state = new URL(authorizeUrl).searchParams.get('state');
    if (!state) return null;
    const decoded = JSON.parse(atob(state)) as { nonce?: unknown };
    return typeof decoded.nonce === 'string' && decoded.nonce ? decoded.nonce : null;
  } catch {
    // Opaque or non-JSON state (a provider we do not shape): no correlation
    // available, so the caller accepts any callback as before.
    return null;
  }
}

/**
 * Race every signal that can deliver the callback URL, plus the popup-closed
 * and timeout terminators. Resolves null when the human gave up.
 */
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
      } catch {
        // The popup may already be gone or cross-origin — nothing to do.
      }
      resolve(value);
    };

    const accept = (data: CallbackMessage | undefined, via: string): void => {
      if (data?.type !== 'oauth-callback' || typeof data.redirectUrl !== 'string') return;
      // Another same-origin SLICC tab's login: not ours to settle on. Only
      // filter when both sides supplied a nonce — an older relay sends none,
      // and an opaque provider state gives us nothing to compare.
      if (expectedNonce && data.nonce && data.nonce !== expectedNonce) {
        log.debug('Ignoring an OAuth callback for a different flow', { via });
        return;
      }
      log.info('Delegated OAuth callback received', { via });
      settle(data.redirectUrl);
    };

    // 1. Origin-scoped broadcast from the worker relay — survives COOP.
    try {
      const channel = new BroadcastChannel(OAUTH_RELAY_CHANNEL);
      channel.onmessage = (event) => accept(event.data as CallbackMessage, 'broadcast');
      cleanups.push(() => channel.close());
    } catch (err) {
      log.warn('BroadcastChannel unavailable for OAuth delivery', { error: String(err) });
    }

    // 2. Classic opener postMessage, when COOP left the reference intact.
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== deps.window.location.origin) return;
      accept(event.data as CallbackMessage, 'postMessage');
    };
    deps.window.addEventListener('message', onMessage);
    cleanups.push(() => deps.window.removeEventListener('message', onMessage));

    // 3. The human closed the popup without finishing.
    if (popup) {
      const poll = setInterval(() => {
        if (!popup.closed) return;
        clearInterval(poll);
        // Give a callback that is already in flight time to arrive.
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

/**
 * Show the approval prompt, open the provider popup inside the resulting
 * click, and resolve with the captured callback URL (null when cancelled).
 */
export async function openDelegatedOAuthPopup(
  url: string,
  signal: AbortSignal,
  deps: DelegatedOAuthPopupDeps
): Promise<string | null> {
  if (signal.aborted) return null;
  const surface = deps.getPermissionsSurface();
  if (!surface) {
    // No surface means no gesture to borrow, and a bare window.open here
    // would be blocked. Fail loudly rather than hanging the leader.
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
