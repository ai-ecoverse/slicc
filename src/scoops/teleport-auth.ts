/**
 * Teleport auth flow — utilities for the follower-side interactive
 * authentication flow during cookie teleport.
 *
 * When a cookie.teleport.request includes a `url`, the follower opens a tab
 * for the human to authenticate, monitors for auth completion, captures
 * cookies, and closes the tab.
 */

import type { CDPTransport } from '../cdp/transport.js';
import type { CookieTeleportCookie } from './tray-sync-protocol.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('teleport-auth');

// ---------------------------------------------------------------------------
// Auth completion detection
// ---------------------------------------------------------------------------

/**
 * Check whether a navigated URL has returned to the initial hostname.
 *
 * During SSO/OAuth flows the browser leaves the initial hostname (redirect to
 * an identity provider) and eventually comes back (callback redirect).  This
 * helper returns `true` when the navigated URL shares the same hostname as the
 * initial URL — i.e. the user has been redirected *back* to where they started.
 *
 * Callers must track whether the page has actually *left* the initial hostname
 * at least once, otherwise the very first same-host path change would
 * incorrectly be treated as auth completion.
 */
export function isAuthRedirect(initialUrl: string, navigatedUrl: string): boolean {
  try {
    const initial = new URL(initialUrl);
    const navigated = new URL(navigatedUrl);
    return initial.hostname === navigated.hostname;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Auth flow execution
// ---------------------------------------------------------------------------

export interface TeleportAuthOptions {
  /** CDP transport for the follower's browser. */
  transport: CDPTransport;
  /** URL to open for authentication. */
  url: string;
  /** Timeout in milliseconds before giving up. Default: 120_000 (2 minutes). */
  timeoutMs?: number;
  /** Callback to notify the UI about auth progress. */
  onNotification?: (message: string) => void;
}

export interface TeleportAuthResult {
  cookies: CookieTeleportCookie[];
  timedOut: boolean;
}

/**
 * Execute the interactive auth flow:
 * 1. Open a new browser tab with the auth URL
 * 2. Wait for auth completion (return to initial hostname after SSO redirect) or timeout
 * 3. Capture all browser cookies
 * 4. Close the auth tab
 */
export async function executeTeleportAuth(options: TeleportAuthOptions): Promise<TeleportAuthResult> {
  const { transport, url, timeoutMs = 120_000, onNotification } = options;

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    hostname = url;
  }

  // 1. Open a new tab
  const createResult = await transport.send('Target.createTarget', { url, background: false });
  const targetId = createResult['targetId'] as string;

  // 2. Attach to the tab and enable Page events
  const attachResult = await transport.send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = attachResult['sessionId'] as string;
  await transport.send('Page.enable', {}, sessionId);

  onNotification?.(`Authentication requested for ${hostname}. Please complete login in the browser tab.`);
  log.info('Teleport auth tab opened', { url, targetId });

  // 3. Wait for auth completion or timeout
  let timedOut = false;
  try {
    await waitForAuthCompletion(transport, url, sessionId, timeoutMs);
  } catch (err) {
    if (err instanceof Error && err.message === 'Teleport auth timeout') {
      timedOut = true;
      log.warn('Teleport auth timed out', { url, timeoutMs });
    } else {
      throw err;
    }
  }

  // 4. Capture cookies (even on timeout — partial auth may have set some)
  const cookieResult = await transport.send('Network.getCookies', {}, sessionId);
  const cookies = (cookieResult['cookies'] as CookieTeleportCookie[]) ?? [];

  // 5. Close the auth tab
  try {
    await transport.send('Target.closeTarget', { targetId });
  } catch {
    // Tab may already be closed
  }

  const status = timedOut
    ? `Authentication timed out after ${Math.round(timeoutMs / 1000)}s. ${cookies.length} cookie(s) captured.`
    : `Authentication complete. ${cookies.length} cookie(s) captured and sent to leader.`;
  onNotification?.(status);
  log.info('Teleport auth complete', { url, cookieCount: cookies.length, timedOut });

  return { cookies, timedOut };
}

/**
 * Wait for auth completion by monitoring Page.frameNavigated events.
 *
 * The flow tracks two phases:
 * 1. The page navigates AWAY from the initial hostname (SSO redirect) —
 *    sets `hasLeftInitialHostname = true`.
 * 2. The page navigates BACK to the initial hostname (callback redirect) —
 *    resolves the promise (auth complete).
 *
 * Same-host path changes before the page has left are ignored (e.g. the
 * initial URL redirecting to a login path on the same host).
 *
 * Rejects with a timeout error if the deadline is exceeded.
 */
function waitForAuthCompletion(
  transport: CDPTransport,
  initialUrl: string,
  sessionId: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let hasLeftInitialHostname = false;

    const cleanup = () => {
      settled = true;
      transport.off('Page.frameNavigated', onNavigated);
      clearTimeout(timer);
    };

    const onNavigated = (params: Record<string, unknown>) => {
      if (settled) return;
      // Only react to events from our session
      if (params['sessionId'] !== sessionId) return;

      const frame = params['frame'] as { url?: string; parentId?: string } | undefined;
      if (!frame?.url || frame.parentId) return; // Only top-level frames

      const backOnInitialHost = isAuthRedirect(initialUrl, frame.url);

      if (!backOnInitialHost && !hasLeftInitialHostname) {
        // First navigation away from the initial hostname — SSO redirect
        hasLeftInitialHostname = true;
        log.info('SSO redirect detected, waiting for callback', { from: initialUrl, to: frame.url });
      } else if (backOnInitialHost && hasLeftInitialHostname) {
        // Navigated back to the initial hostname after leaving — auth complete
        log.info('Auth callback detected', { from: initialUrl, to: frame.url });
        cleanup();
        resolve();
      }
      // Otherwise: same-host navigation before leaving, or still on SSO provider — ignore
    };

    const timer = setTimeout(() => {
      if (settled) return;
      cleanup();
      reject(new Error('Teleport auth timeout'));
    }, timeoutMs);

    transport.on('Page.frameNavigated', onNavigated);
  });
}
