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
  log.info('[teleport-debug] createTarget done', { targetId });

  // 2. Attach to the tab
  const attachResult = await transport.send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = attachResult['sessionId'] as string;
  log.info('[teleport-debug] attachToTarget done', { sessionId });

  // 3. Register the Page.frameNavigated listener BEFORE Page.enable to avoid
  //    a race condition where the redirect completes before the listener is up.
  const { promise: authCompletion, cancel } = waitForAuthCompletion(transport, url, sessionId, timeoutMs, catchPattern, catchNotPattern);
  log.info('[teleport-debug] listener registered (before Page.enable)');

  // 4. Enable Page events — this may flush buffered navigation events to the
  //    already-registered listener.
  await transport.send('Page.enable', {}, sessionId);
  log.info('[teleport-debug] Page.enable done');

  // 5. Check if the URL already matches a catch/catch-not pattern (handles the
  //    case where the redirect completed before Page.enable flushed events).
  let earlyMatchResolved = false;
  if (catchPattern || catchNotPattern) {
    try {
      const evalResult = await transport.send('Runtime.evaluate', { expression: 'window.location.href' }, sessionId);
      const currentUrl = (evalResult as Record<string, unknown>)?.['result'] as { value?: string } | undefined;
      log.info('[teleport-debug] Runtime.evaluate result', { currentUrl: currentUrl?.value });
      if (currentUrl?.value) {
        if (catchPattern && new RegExp(catchPattern).test(currentUrl.value)) {
          log.info('[teleport-debug] catch pattern early match!', { pattern: catchPattern, url: currentUrl.value });
          cancel();
          earlyMatchResolved = true;
        } else if (catchNotPattern) {
          // For catch-not, URL already NOT matching the pattern means auth is done
          const matches = new RegExp(catchNotPattern).test(currentUrl.value);
          log.info('[teleport-debug] catch-not pattern check', { pattern: catchNotPattern, url: currentUrl.value, matches });
          if (!matches) {
            log.info('[teleport-debug] catch-not pattern early match (URL does not match)');
            cancel();
            earlyMatchResolved = true;
          }
        }
      }
    } catch (err) {
      log.info('[teleport-debug] Runtime.evaluate failed', { error: String(err) });
      // Runtime.evaluate may fail if the page is mid-navigation — ignore
    }
  }

  // 5b. Start polling fallback for catch/catch-not patterns.
  // CDP Page.frameNavigated events may not be reliably delivered through
  // the CLI WebSocket proxy, so we poll as a robust fallback.
  let pollInterval: ReturnType<typeof setInterval> | undefined;
  if ((catchPattern || catchNotPattern) && !earlyMatchResolved) {
    let catchNotSeenMatch = false;
    let pollCount = 0;
    pollInterval = setInterval(async () => {
      pollCount++;
      try {
        const result = await transport.send('Runtime.evaluate', { expression: 'window.location.href' }, sessionId);
        const urlValue = (result?.['result'] as { value?: string })?.value;
        if (!urlValue) return;

        log.info('[teleport-debug] poll check', { pollCount, url: urlValue });

        if (catchPattern && new RegExp(catchPattern).test(urlValue)) {
          log.info('[teleport-debug] poll: catch pattern matched!', { pattern: catchPattern, url: urlValue });
          cancel();
          clearInterval(pollInterval);
          pollInterval = undefined;
        } else if (catchNotPattern) {
          const matches = new RegExp(catchNotPattern).test(urlValue);
          if (matches) {
            catchNotSeenMatch = true;
          } else if (catchNotSeenMatch || pollCount >= 3) {
            // Resolve when URL stops matching AND we've seen it match before
            // (or after 3 polls = ~3s grace period for initial page load)
            log.info('[teleport-debug] poll: catch-not pattern no longer matches!', { pattern: catchNotPattern, url: urlValue, catchNotSeenMatch, pollCount });
            cancel();
            clearInterval(pollInterval);
            pollInterval = undefined;
          }
        }
      } catch {
        // Runtime.evaluate may fail during navigation — ignore
      }
    }, 1000);
  }

  onNotification?.(`Authentication requested for ${hostname}. Please complete login in the browser tab.`);
  log.info('[teleport-debug] awaiting authCompletion...', { url, targetId, timeoutMs });

  // 6. Wait for auth completion or timeout
  let timedOut = false;
  try {
    await authCompletion;
  } catch (err) {
    if (err instanceof Error && err.message === 'Teleport auth timeout') {
      timedOut = true;
      log.warn('[teleport-debug] Teleport auth timed out', { url, timeoutMs });
    } else {
      throw err;
    }
  } finally {
    // Clean up polling
    if (pollInterval) {
      clearInterval(pollInterval);
    }
  }

  // 7. Capture cookies (even on timeout — partial auth may have set some)
  const cookieResult = await transport.send('Network.getCookies', {}, sessionId);
  const cookies = (cookieResult['cookies'] as CookieTeleportCookie[]) ?? [];

  // 8. Close the auth tab
  try {
    await transport.send('Target.closeTarget', { targetId });
  } catch {
    // Tab may already be closed
  }

  const status = timedOut
    ? `Authentication timed out after ${Math.round(timeoutMs / 1000)}s. ${cookies.length} cookie(s) captured.`
    : `Authentication complete. ${cookies.length} cookie(s) captured and sent to leader.`;
  onNotification?.(status);
  log.info('[teleport-debug] Teleport auth complete', { url, cookieCount: cookies.length, timedOut });

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
      log.info('[teleport-debug] cancel() called (early match or poll resolved)');
      cleanup();
      resolve();
    };

    const onNavigated = (params: Record<string, unknown>) => {
      log.info('[teleport-debug] onNavigated called', {
        eventSessionId: params['sessionId'],
        expectedSessionId: sessionId,
        match: params['sessionId'] === sessionId,
        frame: params['frame'],
        settled,
      });

      if (settled) return;
      // Only react to events from our session
      if (params['sessionId'] !== sessionId) return;

      const frame = params['frame'] as { url?: string; parentId?: string } | undefined;
      if (!frame?.url || frame.parentId) return; // Only top-level frames

      // Mode A: --catch — complete when URL matches the regex
      if (catchRegex) {
        const matches = catchRegex.test(frame.url);
        log.info('[teleport-debug] catch regex test', { pattern: catchPattern, url: frame.url, matches });
        if (matches) {
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
        const matches = catchNotRegex.test(frame.url);
        log.info('[teleport-debug] catch-not regex test', { pattern: catchNotPattern, url: frame.url, matches });
        if (!matches) {
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

    log.info('[teleport-debug] timer created', { timeoutMs });
    const timer = setTimeout(() => {
      log.info('[teleport-debug] TIMEOUT fired', { timeoutMs, settled });
      if (settled) return;
      cleanup();
      reject(new Error('Teleport auth timeout'));
    }, timeoutMs);

    transport.on('Page.frameNavigated', onNavigated);
  });

  return { promise, cancel: cancelFn! };
}
