/**
 * Run a delegated OAuth login by DRIVING the follower's browser (issue #1915),
 * rather than asking its page to open a popup.
 *
 * The leader opens the authorize URL as an ordinary tab on the follower over
 * federated CDP, watches that tab's navigations for the provider's redirect
 * back to the registered callback, and reads the authorization code straight
 * off the URL. The human just signs in in a normal tab.
 *
 * Why this is the primary path, with the popup kept only as a fallback:
 *
 *  - **No user activation needed.** `window.open` from a message handler is
 *    blocked, which is why the popup path must borrow a click.
 *  - **COOP is irrelevant.** Providers that send `Cross-Origin-Opener-Policy:
 *    same-origin` (GitHub does) sever `window.opener`; we read a URL instead
 *    of relying on cross-context messaging, so nothing to sever.
 *  - **No same-origin coupling.** The popup path needs the follower and the
 *    relay to share an origin to receive the broadcast; this needs nothing.
 *  - **iOS can serve it.** iOS has no popup model at all, but it does host
 *    CDP targets and emit `Page.frameNavigated`.
 *
 * The token never travels: only the callback URL comes back, and the leader
 * still validates the nonce and performs the code exchange. SLICC already used
 * this shape for the controlled browser in `providers/intercepted-oauth.ts`;
 * this applies it across the tray.
 */

import { createLogger } from '../../base/logger.js';
import type { BrowserAPI } from '../../cdp/browser-api.js';

const log = createLogger('oauth-cdp-login');

/** Matches the popup path's budget so both give up together. */
const CDP_LOGIN_TIMEOUT_MS = 120_000;
/**
 * Backstop for transports that do not emit navigation events. `Page.frameNavigated`
 * fires at commit — before the callback page's own script can redirect or close
 * it — so polling is only ever the slower of the two.
 */
const URL_POLL_INTERVAL_MS = 500;

export interface DelegatedCdpLoginDeps {
  browser: BrowserAPI;
  /** Follower runtime to open the tab on. */
  runtimeId: string;
  authorizeUrl: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * The provider redirects back to the `redirect_uri` baked into the authorize
 * URL, so that is what a terminal callback looks like — no provider-specific
 * knowledge required. Returns null when the URL carries no usable redirect.
 */
export function callbackMatcherFor(authorizeUrl: string): ((url: string) => boolean) | null {
  let redirectUri: string | null;
  try {
    redirectUri = new URL(authorizeUrl).searchParams.get('redirect_uri');
  } catch {
    return null;
  }
  if (!redirectUri) return null;
  let base: string;
  try {
    const parsed = new URL(redirectUri);
    base = `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
  return (candidate: string): boolean => {
    try {
      const parsed = new URL(candidate);
      if (`${parsed.origin}${parsed.pathname}` !== base) return false;
      // Only a terminal callback carries the grant (or an explicit failure);
      // the bare callback path mid-flow must not settle the wait.
      return (
        parsed.searchParams.has('code') ||
        parsed.searchParams.has('error') ||
        parsed.hash.includes('access_token')
      );
    } catch {
      return false;
    }
  };
}

/**
 * Mirror the worker relay's param handling for a callback we intercept BEFORE
 * the relay gets to run.
 *
 * The relay page lifts `nonce` out of the base64 `state` onto the URL it
 * delivers, and drops `state` (see `OAUTH_RELAY_HTML` in the cloudflare-worker).
 * The providers' CSRF check reads the nonce from there. Driving the tab
 * ourselves means we settle on the relay's ENTRY url — `?code=…&state=…`, no
 * `nonce` — so without this every delegated login is rejected as a nonce
 * mismatch.
 *
 * This is not a weaker check than the relay's: the relay derives the nonce
 * from the same `state` param, so a forged callback still carries a nonce that
 * does not match the one the provider generated for this login.
 */
export function liftNonceFromState(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.searchParams.has('nonce')) return rawUrl;
    const raw = url.searchParams.get('state');
    if (!raw) return rawUrl;
    const parsed: unknown = JSON.parse(atob(raw));
    const nonce = (parsed as { nonce?: unknown } | null)?.nonce;
    if (typeof nonce !== 'string' || !nonce) return rawUrl;
    url.searchParams.delete('state');
    url.searchParams.set('nonce', nonce);
    return url.toString();
  } catch {
    // Unparseable state is the relay's problem to reject, not ours to guess at.
    return rawUrl;
  }
}

/**
 * Read the tab's current URL, or null when it cannot be read right now.
 *
 * Goes through `withTab`: attaching swaps the shared CDP client's session, so
 * a bare `attachToPage` on a 500 ms timer would keep retargeting any
 * concurrent operation's transport at the OAuth tab. A tab mid-navigation or
 * already gone simply yields null — the caller's timeout owns the terminal
 * case.
 */
async function readCurrentHref(browser: BrowserAPI, targetId: string): Promise<string | null> {
  try {
    const raw = await browser.withTab(targetId, () => browser.evaluate('window.location.href'));
    return typeof raw === 'string' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Open the authorize URL on a follower and resolve with the callback URL it
 * lands on. Resolves null when the human never finished (timeout, abort, or a
 * closed tab). The tab is always closed on the way out.
 */
export async function runDelegatedCdpLogin(deps: DelegatedCdpLoginDeps): Promise<string | null> {
  const { browser, runtimeId, authorizeUrl, signal } = deps;
  const isCallback = callbackMatcherFor(authorizeUrl);
  if (!isCallback) {
    throw new Error('authorize URL has no redirect_uri to watch for');
  }

  const rawTargetId = await browser.createRemotePage(runtimeId, authorizeUrl);
  const targetId = rawTargetId.includes(':') ? rawTargetId : `${runtimeId}:${rawTargetId}`;
  log.info('Opened delegated login tab on follower', { runtimeId });

  return await new Promise<string | null>((resolve) => {
    const cleanups: Array<() => void> = [];
    let settled = false;
    const settle = (value: string | null): void => {
      if (settled) return;
      settled = true;
      for (const cleanup of cleanups) cleanup();
      // Close in the background: the caller should not wait on teardown, and a
      // follower that vanished mid-login would otherwise stall the exchange.
      void browser.closePage(targetId).catch((err) => {
        log.warn('Could not close delegated login tab', { error: String(err) });
      });
      resolve(typeof value === 'string' ? liftNonceFromState(value) : value);
    };

    void (async () => {
      try {
        // Every attach here goes through `withTab`. Attaching replaces the
        // shared CDP client's session, so a bare `attachToPage` — especially
        // one on a 500 ms timer, running for up to two minutes while a human
        // signs in — can retarget a concurrent operation's transport at the
        // OAuth tab mid-command.
        await browser.withTab(targetId, async () => {
          await browser.sendCDP('Page.enable');
        });

        // Primary signal: navigation commit, before the page's own script runs.
        const transport = browser.getTransport();
        const onNavigated = (params: Record<string, unknown>): void => {
          const frame = (params as { frame?: { url?: string; parentId?: string } }).frame;
          if (!frame?.url || frame.parentId) return; // main frame only
          if (isCallback(frame.url)) {
            log.info('Delegated login reached the callback', { via: 'frameNavigated' });
            settle(frame.url);
          }
        };
        transport.on('Page.frameNavigated', onNavigated);
        cleanups.push(() => transport.off('Page.frameNavigated', onNavigated));

        // Backstop for transports that never emit it.
        const pollOnce = async (): Promise<void> => {
          if (settled) return;
          const href = await readCurrentHref(browser, targetId);
          if (settled || !href || !isCallback(href)) return;
          log.info('Delegated login reached the callback', { via: 'poll' });
          settle(href);
        };
        const poll = setInterval(() => void pollOnce(), URL_POLL_INTERVAL_MS);
        cleanups.push(() => clearInterval(poll));
      } catch (err) {
        log.warn('Delegated CDP login could not start', { error: String(err) });
        settle(null);
      }
    })();

    const timer = setTimeout(() => {
      log.warn('Delegated CDP login timed out');
      settle(null);
    }, deps.timeoutMs ?? CDP_LOGIN_TIMEOUT_MS);
    cleanups.push(() => clearTimeout(timer));

    const onAbort = (): void => settle(null);
    signal?.addEventListener('abort', onAbort);
    cleanups.push(() => signal?.removeEventListener('abort', onAbort));
    if (signal?.aborted) settle(null);
  });
}
