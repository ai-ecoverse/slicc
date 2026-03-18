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
  /** Timeout in milliseconds before giving up. Default: 300_000 (5 minutes). */
  timeoutMs?: number;
  /** Callback to notify the UI about auth progress. */
  onNotification?: (message: string) => void;
  /** When set, auth completes when the URL MATCHES this regex. */
  catchPattern?: string;
  /** When set, auth completes when the URL NO LONGER MATCHES this regex (skips first navigation). */
  catchNotPattern?: string;
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
  const { transport, url, timeoutMs = 300_000, onNotification, catchPattern, catchNotPattern } = options;

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    hostname = url;
  }

  // 1. Open a new tab
  const createResult = await transport.send('Target.createTarget', { url, background: false });
  const targetId = createResult['targetId'] as string;

  // 2. Attach to the tab
  const attachResult = await transport.send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = attachResult['sessionId'] as string;

  // 3. Register the Page.frameNavigated listener BEFORE Page.enable to avoid
  //    a race condition where the redirect completes before the listener is up.
  const { promise: authCompletion, cancel } = waitForAuthCompletion(transport, url, sessionId, timeoutMs, catchPattern, catchNotPattern);

  // 4. Enable Page events — this may flush buffered navigation events to the
  //    already-registered listener.
  await transport.send('Page.enable', {}, sessionId);

  // 5. Check if the URL already matches a catch/catch-not pattern (handles the
  //    case where the redirect completed before Page.enable flushed events).
  if (catchPattern || catchNotPattern) {
    try {
      const evalResult = await transport.send('Runtime.evaluate', { expression: 'window.location.href' }, sessionId);
      const currentUrl = (evalResult as Record<string, unknown>)?.['result'] as { value?: string } | undefined;
      if (currentUrl?.value) {
        if (catchPattern && new RegExp(catchPattern).test(currentUrl.value)) {
          log.info('Catch pattern already matches current URL', { pattern: catchPattern, url: currentUrl.value });
          cancel();
        } else if (catchNotPattern) {
          // For catch-not, URL already NOT matching the pattern means auth is done
          if (!new RegExp(catchNotPattern).test(currentUrl.value)) {
            log.info('Catch-not pattern already does not match current URL', { pattern: catchNotPattern, url: currentUrl.value });
            cancel();
          }
        }
      }
    } catch {
      // Runtime.evaluate may fail if the page is mid-navigation — ignore
    }
  }

  onNotification?.(`Authentication requested for ${hostname}. Please complete login in the browser tab.`);
  log.info('Teleport auth tab opened', { url, targetId });

  // 6. Wait for auth completion or timeout
  let timedOut = false;
  try {
    await authCompletion;
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
 * Three completion modes:
 *
 * **Mode A (catchPattern)**: Completes when a navigated URL matches the
 * provided regex pattern.
 *
 * **Mode B (catchNotPattern)**: Completes when a navigated URL *no longer*
 * matches the provided regex pattern. The first navigation event is skipped
 * to avoid false positives from the initial page load.
 *
 * **Mode C (default)**: The hostname-return heuristic. Tracks two phases:
 * 1. The page navigates AWAY from the initial hostname (SSO redirect).
 * 2. The page navigates BACK to the initial hostname (callback redirect).
 *
 * Rejects with a timeout error if the deadline is exceeded.
 */
interface AuthCompletionHandle {
  /** Promise that resolves on auth completion or rejects on timeout. */
  promise: Promise<void>;
  /** Cancel the wait — resolves the promise immediately (used for early URL match). */
  cancel: () => void;
}

function waitForAuthCompletion(
  transport: CDPTransport,
  initialUrl: string,
  sessionId: string,
  timeoutMs: number,
  catchPattern?: string,
  catchNotPattern?: string,
): AuthCompletionHandle {
  let cancelFn: () => void;

  const promise = new Promise<void>((resolve, reject) => {
    let settled = false;
    let hasLeftInitialHostname = false;
    let hasNavigated = false; // For catch-not: skip the first navigation

    const catchRegex = catchPattern ? new RegExp(catchPattern) : undefined;
    const catchNotRegex = catchNotPattern ? new RegExp(catchNotPattern) : undefined;

    const cleanup = () => {
      settled = true;
      transport.off('Page.frameNavigated', onNavigated);
      clearTimeout(timer);
    };

    cancelFn = () => {
      if (settled) return;
      cleanup();
      resolve();
    };

    const onNavigated = (params: Record<string, unknown>) => {
      if (settled) return;
      // Only react to events from our session
      if (params['sessionId'] !== sessionId) return;

      const frame = params['frame'] as { url?: string; parentId?: string } | undefined;
      if (!frame?.url || frame.parentId) return; // Only top-level frames

      // Mode A: --catch — complete when URL matches the regex
      if (catchRegex) {
        if (catchRegex.test(frame.url)) {
          log.info('Catch pattern matched', { pattern: catchPattern, url: frame.url });
          cleanup();
          resolve();
        }
        return;
      }

      // Mode B: --catch-not — complete when URL no longer matches the regex
      if (catchNotRegex) {
        if (!hasNavigated) {
          hasNavigated = true;
          log.info('Catch-not: skipping first navigation', { url: frame.url });
          return; // Skip the first navigation event (initial page load)
        }
        if (!catchNotRegex.test(frame.url)) {
          log.info('Catch-not pattern no longer matches', { pattern: catchNotPattern, url: frame.url });
          cleanup();
          resolve();
        }
        return;
      }

      // Mode C: default hostname-return heuristic
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

  return { promise, cancel: cancelFn! };
}
