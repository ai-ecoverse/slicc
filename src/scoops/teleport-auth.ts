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
 * Detect whether a navigation event signals auth completion.
 * Auth is considered complete when the hostname of the navigated URL differs
 * from the initial URL hostname (typical redirect-after-login pattern).
 */
export function isAuthRedirect(initialUrl: string, navigatedUrl: string): boolean {
  try {
    const initial = new URL(initialUrl);
    const navigated = new URL(navigatedUrl);
    return initial.hostname !== navigated.hostname;
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
 * 2. Wait for auth completion (hostname redirect) or timeout
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
 * Resolves when a navigation to a different hostname is detected.
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

      if (isAuthRedirect(initialUrl, frame.url)) {
        log.info('Auth redirect detected', { from: initialUrl, to: frame.url });
        cleanup();
        resolve();
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      cleanup();
      reject(new Error('Teleport auth timeout'));
    }, timeoutMs);

    transport.on('Page.frameNavigated', onNavigated);
  });
}
