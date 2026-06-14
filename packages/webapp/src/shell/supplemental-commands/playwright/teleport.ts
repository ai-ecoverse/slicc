/**
 * Teleport watcher state machine: arms a watcher on a leader tab, drives the
 * follower auth handoff, and replays captured cookies + storage back to the
 * leader. The auth-state capture/replay primitives live in
 * `teleport-storage.ts`.
 */

import type { BrowserAPI } from '../../../cdp/index.js';
import { createLogger } from '../../../core/logger.js';
import {
  applyTeleportStorageSnapshot,
  buildTeleportStorageHydrationUrl,
  captureTeleportStorageSnapshot,
  chooseTeleportLeaderLandingUrl,
  countTeleportStorageEntries,
  EMPTY_TELEPORT_STORAGE,
  formatCookieDomainSummary,
  installTeleportStorageInitScript,
  logFollowerTeleportDiagnosticsOnce,
  removeFollowerTeleportStorageScript,
  shouldCaptureTeleportDiagnostics,
  tryGetTeleportUrlOrigin,
} from './teleport-storage.js';
import type {
  GetBestFollowerFn,
  GetConnectedFollowersFn,
  PlaywrightState,
  TeleportStorageSnapshot,
  TeleportWatcher,
} from './types.js';

interface FollowerAuthState {
  cookies: Array<Record<string, unknown>>;
  followerStorage: TeleportStorageSnapshot;
  finalUrl?: string;
}

const log = createLogger('playwright-teleport');

let getBestFollowerGetter: (() => GetBestFollowerFn | null) | null = null;
let getConnectedFollowersGetter: (() => GetConnectedFollowersFn | null) | null = null;

export function setPlaywrightTeleportBestFollower(
  getter: (() => GetBestFollowerFn | null) | null
): void {
  getBestFollowerGetter = getter;
}

export function setPlaywrightTeleportConnectedFollowers(
  getter: (() => GetConnectedFollowersFn | null) | null
): void {
  getConnectedFollowersGetter = getter;
}

/** Resolve the connected-followers accessor, or null when not connected to a tray. */
export function resolveConnectedFollowers(): GetConnectedFollowersFn | null {
  return getConnectedFollowersGetter?.() ?? null;
}

export async function handleTeleportTimeout(
  browser: BrowserAPI,
  watcher: TeleportWatcher
): Promise<void> {
  log.warn('Teleport timed out', {
    timeoutMs: watcher.timeoutMs,
    phase: watcher.phase,
  });
  log.debug('Teleport timeout details', {
    timeoutMs: watcher.timeoutMs,
    phase: watcher.phase,
    followerTargetId: watcher.followerTargetId,
  });
  watcher.phase = 'timedOut';

  if (watcher.followerTargetId) {
    try {
      await browser.attachToPage(watcher.followerTargetId);
      await logFollowerTeleportDiagnosticsOnce(browser, watcher, 'timeout');
    } catch (err) {
      log.warn('Could not attach to follower for timeout diagnostics', { error: String(err) });
    }
    await removeFollowerTeleportStorageScript(watcher, 'timeout');
  }

  cleanupTeleportWatcher(watcher);
  if (watcher.followerTargetId) {
    try {
      await browser.closePage(watcher.followerTargetId);
    } catch (err) {
      log.warn('Failed to close follower tab after timeout', { error: String(err) });
    }
  }
  watcher.rejectBlock?.(
    new Error(
      `Teleport timed out after ${Math.round(watcher.timeoutMs / 1000)}s — human did not complete auth`
    )
  );
}

/** Clean up all timers and listeners on a teleport watcher. */
export function cleanupTeleportWatcher(watcher: TeleportWatcher): void {
  log.info('Cleaning up teleport watcher', {
    phase: watcher.phase,
    hadPoll: !!watcher.pollInterval,
    hadTimeout: !!watcher.timeoutTimer,
    hadListener: !!watcher.cleanupListener,
  });
  if (watcher.pollInterval) {
    clearInterval(watcher.pollInterval);
    watcher.pollInterval = undefined;
  }
  if (watcher.timeoutTimer) {
    clearTimeout(watcher.timeoutTimer);
    watcher.timeoutTimer = undefined;
  }
  if (watcher.cleanupListener) {
    watcher.cleanupListener();
    watcher.cleanupListener = undefined;
  }
}

/**
 * Arm a teleport watcher on the current leader tab.
 * Starts monitoring navigation via polling + CDP events.
 */
export function armTeleportWatcher(
  browser: BrowserAPI,
  state: PlaywrightState,
  startPattern: RegExp,
  returnPattern: RegExp,
  timeoutMs: number,
  runtimeId?: string,
  originalUrl?: string,
  leaderTargetId?: string
): TeleportWatcher {
  log.info('Arming teleport watcher', {
    timeoutMs,
    runtimeSelection: runtimeId ? 'explicit' : 'auto',
  });
  log.debug('Arming teleport watcher details', {
    startPattern: startPattern.source,
    returnPattern: returnPattern.source,
    timeoutMs,
    runtimeId: runtimeId ?? 'auto',
    originalUrl,
  });

  const watcher: TeleportWatcher = {
    startPattern,
    returnPattern,
    timeoutMs,
    runtimeId,
    phase: 'armed',
    leaderTargetId,
    originalLeaderUrl: originalUrl,
  };

  // Create a completion promise that blocks the current/next command.
  // Attach a no-op catch to prevent unhandled rejection warnings when the
  // watcher times out or errors without anyone awaiting the promise.
  watcher.completionPromise = new Promise<string>((resolve, reject) => {
    watcher.resolveBlock = resolve;
    watcher.rejectBlock = reject;
  });
  watcher.completionPromise.catch(() => {
    /* swallow unhandled rejections */
  });

  // Start polling the leader tab URL for start pattern match
  watcher.pollInterval = setInterval(async () => {
    if (watcher.phase !== 'armed') return;
    const targetId = watcher.leaderTargetId;
    if (!targetId) return;

    try {
      await browser.attachToPage(targetId);
      const raw = await browser.evaluate('window.location.href');
      const href = typeof raw === 'string' ? raw : String(raw);
      log.debug('Polling leader tab URL', { targetId, href, startPattern: startPattern.source });
      if (startPattern.test(href)) {
        log.info('Teleport start pattern matched on leader');
        log.debug('Teleport start pattern matched on leader details', {
          targetId,
          href,
          startPattern: startPattern.source,
        });
        triggerTeleport(browser, state, watcher, href);
      }
    } catch (err) {
      log.warn('Error polling leader tab URL', { targetId, error: String(err) });
    }
  }, 1000);

  if (leaderTargetId) {
    state.teleportWatchers.set(leaderTargetId, watcher);
  }
  return watcher;
}

/**
 * Trigger the teleport flow: open the current URL on a follower,
 * monitor the follower for returnPattern, capture cookies, inject on leader.
 */
async function triggerTeleport(
  browser: BrowserAPI,
  state: PlaywrightState,
  watcher: TeleportWatcher,
  triggerUrl: string
): Promise<void> {
  if (watcher.phase !== 'armed') return;
  watcher.phase = 'teleporting';
  log.info('Teleport triggered');
  log.debug('Teleport trigger details', { triggerUrl });

  // Stop polling the leader
  if (watcher.pollInterval) {
    clearInterval(watcher.pollInterval);
    watcher.pollInterval = undefined;
  }

  try {
    // 1. Capture cookies from leader tab (before switching transport)
    let leaderCookies: Array<Record<string, unknown>> = [];
    let leaderStorage = EMPTY_TELEPORT_STORAGE;
    try {
      const cookieResult = await browser.sendCDP('Network.getCookies', {});
      leaderCookies = (cookieResult['cookies'] as Array<Record<string, unknown>>) ?? [];
      log.info('Captured leader cookies for follower', { count: leaderCookies.length });
    } catch (err) {
      log.warn('Could not capture leader cookies', { error: String(err) });
    }
    try {
      leaderStorage = await captureTeleportStorageSnapshot(browser, 'leader');
      log.info('Captured leader storage for follower', {
        totalEntries: countTeleportStorageEntries(leaderStorage),
        localStorageCount: Object.keys(leaderStorage.localStorage).length,
        sessionStorageCount: Object.keys(leaderStorage.sessionStorage).length,
      });
      log.debug('Captured leader storage for follower details', {
        origin: leaderStorage.origin || '(unknown)',
        localStorageCount: Object.keys(leaderStorage.localStorage).length,
        sessionStorageCount: Object.keys(leaderStorage.sessionStorage).length,
      });
    } catch (err) {
      log.warn('Could not capture leader storage', { error: String(err) });
    }

    // 2. Select follower
    let runtimeId = watcher.runtimeId;
    if (!runtimeId) {
      const getBestFollower = getBestFollowerGetter?.();
      if (!getBestFollower)
        throw new Error('No follower selection available — not connected to a tray');
      const best = getBestFollower();
      if (!best) throw new Error('No followers connected to teleport to');
      runtimeId = best.runtimeId;
    }
    log.info('Selected follower for teleport');
    log.debug('Selected follower for teleport details', { runtimeId });

    // 3. Open about:blank on the follower (we navigate manually after injecting cookies)
    const rawTargetId = await browser.createRemotePage(runtimeId, 'about:blank');
    // Ensure composite runtimeId:localTargetId format for attachToPage() to detect as remote
    const followerTargetId = rawTargetId.includes(':')
      ? rawTargetId
      : `${runtimeId}:${rawTargetId}`;
    watcher.followerTargetId = followerTargetId;
    log.info('Opened follower tab for teleport');
    log.debug('Opened follower tab for teleport details', { followerTargetId });

    // 4. Attach to the follower tab (auto-swaps to RemoteCDPTransport)
    await browser.attachToPage(followerTargetId);
    log.info('Attached to follower tab for teleport');
    log.debug('Attached to follower tab for teleport details', { followerTargetId });

    // Enable Page events on the follower
    await browser.sendCDP('Page.enable');

    // 5. Inject leader cookies into follower before navigating
    if (leaderCookies.length > 0) {
      try {
        await browser.sendCDP('Network.setCookies', { cookies: leaderCookies });
        log.info('Injected leader cookies into follower', { count: leaderCookies.length });
      } catch (err) {
        log.warn('Could not inject leader cookies into follower', { error: String(err) });
      }
    }

    // 6. Navigate follower directly to the intercepted auth/IdP URL so the human
    // can continue the in-progress flow without re-entering the earlier step.
    const followerUrl = triggerUrl;
    watcher.removeFollowerStorageScript = await installTeleportStorageInitScript(
      browser,
      leaderStorage,
      followerTargetId,
      'follower'
    );
    log.info('Navigating follower to intercepted auth URL');
    log.debug('Navigating follower to intercepted auth URL details', {
      url: followerUrl,
      originalLeaderUrl: watcher.originalLeaderUrl,
      triggerUrl,
      storageOrigin: leaderStorage.origin || '(unknown)',
    });
    await browser.sendCDP('Page.navigate', { url: followerUrl });

    // 4. Start timeout timer
    log.info('Starting teleport timeout timer', { timeoutMs: watcher.timeoutMs });
    watcher.timeoutTimer = setTimeout(() => {
      if (
        watcher.phase === 'teleporting' ||
        watcher.phase === 'waitingForAuth' ||
        watcher.phase === 'waitingForReturn'
      ) {
        void handleTeleportTimeout(browser, watcher);
      }
    }, watcher.timeoutMs);

    // 5. Monitor follower tab: first wait for auth redirect (startPattern), then watch for return
    watcher.phase = 'waitingForAuth';
    log.info('Teleport waiting for follower auth redirect');
    log.debug('Teleport waiting for follower auth redirect details', {
      startPattern: watcher.startPattern.source,
    });
    watcher.pollInterval = setInterval(async () => {
      if (watcher.phase !== 'waitingForAuth' && watcher.phase !== 'waitingForReturn') return;
      try {
        await browser.attachToPage(followerTargetId);
        const raw = await browser.evaluate('window.location.href');
        const href = typeof raw === 'string' ? raw : String(raw);
        if (!href) return;
        if (watcher.lastFollowerUrl !== href) {
          watcher.lastFollowerUrl = href;
          log.debug('Follower teleport navigation', { href, phase: watcher.phase });
        }

        if (watcher.phase === 'waitingForAuth') {
          // Waiting for follower to redirect to auth (e.g. Okta)
          if (watcher.startPattern.test(href)) {
            watcher.phase = 'waitingForReturn';
            log.info('Follower reached auth provider; waiting for return pattern');
            log.debug('Follower reached auth provider details', {
              href,
              startPattern: watcher.startPattern.source,
            });
          } else {
            log.debug('Waiting for auth redirect on follower', {
              href,
              startPattern: watcher.startPattern.source,
            });
          }
          return; // Don't check return pattern yet
        }

        // Waiting for return from auth
        log.debug('Polling follower tab URL for return', {
          href,
          returnPattern: watcher.returnPattern.source,
        });
        if (shouldCaptureTeleportDiagnostics(href)) {
          await logFollowerTeleportDiagnosticsOnce(browser, watcher, 'waiting-for-return');
        }
        if (watcher.returnPattern.test(href)) {
          log.info('Follower return pattern matched after auth');
          log.debug('Follower return pattern matched after auth details', {
            href,
            returnPattern: watcher.returnPattern.source,
          });
          captureCookiesAndComplete(browser, state, watcher, runtimeId!);
        }
      } catch (err) {
        log.warn('Error polling follower tab URL', { error: String(err) });
      }
    }, 1000);
  } catch (err) {
    log.error('Teleport trigger failed', { error: String(err) });
    await removeFollowerTeleportStorageScript(watcher, 'trigger-error');
    watcher.phase = 'done';
    cleanupTeleportWatcher(watcher);
    watcher.rejectBlock?.(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Capture the follower's post-auth state: final URL, cookies, and page storage.
 * Also runs diagnostics, removes the follower replay script, and closes the tab.
 */
async function captureFollowerAuthState(
  browser: BrowserAPI,
  watcher: TeleportWatcher
): Promise<FollowerAuthState> {
  // 1. Wait for redirect chain to settle
  log.info('Waiting for redirect chain to settle (2s)');
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // 2. Attach to follower and capture final URL + cookies
  await browser.attachToPage(watcher.followerTargetId!);
  let finalUrl: string | undefined;
  try {
    const raw = await browser.evaluate('window.location.href');
    finalUrl = typeof raw === 'string' ? raw : String(raw);
    log.debug('Captured final URL from follower', { finalUrl });
  } catch (err) {
    log.warn('Could not read follower URL (may be mid-navigation)', { error: String(err) });
  }

  // Log follower page content for debugging auth flow errors
  try {
    const bodyText = await browser.evaluate(
      'document.body?.innerText?.substring(0, 500) || "(empty)"'
    );
    log.debug('Follower page content at capture time', { bodyText });
  } catch (err) {
    log.warn('Could not read follower page content', { error: String(err) });
  }

  const cookieResult = await browser.sendCDP('Network.getCookies');
  const cookies = (cookieResult['cookies'] as Array<Record<string, unknown>>) ?? [];
  const domainSummary =
    cookies.length > 0 ? formatCookieDomainSummary(cookies as Array<{ domain?: string }>) : 'none';
  log.info('Captured cookies from follower', { count: cookies.length });
  log.debug('Captured cookies from follower details', {
    count: cookies.length,
    domains: domainSummary,
  });

  let followerStorage = EMPTY_TELEPORT_STORAGE;
  try {
    followerStorage = await captureTeleportStorageSnapshot(browser, 'follower');
    log.info('Captured follower storage for leader', {
      totalEntries: countTeleportStorageEntries(followerStorage),
      localStorageCount: Object.keys(followerStorage.localStorage).length,
      sessionStorageCount: Object.keys(followerStorage.sessionStorage).length,
    });
    log.debug('Captured follower storage for leader details', {
      origin: followerStorage.origin || '(unknown)',
      localStorageCount: Object.keys(followerStorage.localStorage).length,
      sessionStorageCount: Object.keys(followerStorage.sessionStorage).length,
    });
  } catch (err) {
    log.warn('Could not capture follower storage', { error: String(err) });
  }

  await logFollowerTeleportDiagnosticsOnce(browser, watcher, 'capture');
  await removeFollowerTeleportStorageScript(watcher, 'capture');

  // 3. Close follower tab
  try {
    await browser.closePage(watcher.followerTargetId!);
    log.info('Closed follower tab after teleport');
    log.debug('Closed follower tab after teleport details', {
      followerTargetId: watcher.followerTargetId,
    });
  } catch (err) {
    log.warn('Failed to close follower tab', { error: String(err) });
  }

  return { cookies, followerStorage, finalUrl };
}

/**
 * Cross-origin path: navigate the leader to a captured-origin URL, apply storage
 * directly, then land. Falls back to an init-script replay if direct apply fails.
 */
async function hydrateLeaderOriginThenLand(
  browser: BrowserAPI,
  leaderTargetId: string,
  followerStorage: TeleportStorageSnapshot,
  hydrationUrl: string,
  landingUrl: string | undefined
): Promise<void> {
  try {
    await browser.navigate(hydrationUrl);
    await applyTeleportStorageSnapshot(browser, followerStorage, 'leader');
    if (landingUrl && landingUrl !== hydrationUrl) {
      await browser.navigate(landingUrl);
    }
  } catch (err) {
    log.warn('Direct leader origin hydration failed, falling back to init-script replay', {
      error: String(err),
    });
    log.debug('Direct leader origin hydration fallback details', {
      hydrationUrl,
      landingUrl,
      error: String(err),
    });
    const removeLeaderStorageScript = await installTeleportStorageInitScript(
      browser,
      followerStorage,
      leaderTargetId,
      'leader'
    );
    try {
      if (landingUrl) {
        await browser.navigate(landingUrl);
      }
    } finally {
      await removeLeaderStorageScript?.();
    }
  }
}

/**
 * Same-origin path: install the storage replay init-script, then navigate the
 * leader to the landing URL with the script installed through the load.
 */
async function replayLeaderStorageThenLand(
  browser: BrowserAPI,
  watcher: TeleportWatcher,
  followerStorage: TeleportStorageSnapshot,
  landingUrl: string | undefined,
  finalUrl: string | undefined
): Promise<void> {
  const leaderTargetId = watcher.leaderTargetId!;
  const removeLeaderStorageScript = await installTeleportStorageInitScript(
    browser,
    followerStorage,
    leaderTargetId,
    'leader'
  );
  // Keep the replay script installed through the actual navigation/load so auth-state
  // restoration is not a best-effort race against navigation returning.
  try {
    if (landingUrl) {
      log.info('Navigating leader after auth-state injection', {
        hasLandingUrl: true,
        storageEntries: countTeleportStorageEntries(followerStorage),
      });
      log.debug('Navigating leader after auth-state injection details', {
        landingUrl,
        originalLeaderUrl: watcher.originalLeaderUrl,
        finalUrl,
        leaderTargetId,
        storageOrigin: followerStorage.origin || '(unknown)',
        storageEntries: countTeleportStorageEntries(followerStorage),
      });
      await browser.navigate(landingUrl);
    }
  } finally {
    await removeLeaderStorageScript?.();
  }
}

/**
 * Switch back to the leader tab and inject the captured cookies + app state.
 * For cross-origin SSO handoffs, hydrate the captured app origin first so SPA
 * auth caches are materialized on the right origin before landing. Returns the
 * landing URL the leader was navigated to (if any).
 */
async function injectAuthStateIntoLeader(
  browser: BrowserAPI,
  watcher: TeleportWatcher,
  cookies: Array<Record<string, unknown>>,
  followerStorage: TeleportStorageSnapshot,
  finalUrl: string | undefined
): Promise<string | undefined> {
  const leaderTargetId = watcher.leaderTargetId;
  const leaderStorageOrigin = followerStorage.origin || '';
  const landingUrl = chooseTeleportLeaderLandingUrl(
    leaderStorageOrigin,
    watcher.originalLeaderUrl,
    finalUrl
  );
  const originalLeaderOrigin = tryGetTeleportUrlOrigin(watcher.originalLeaderUrl);
  const shouldHydrateLeaderOrigin =
    !!leaderStorageOrigin && originalLeaderOrigin !== leaderStorageOrigin;
  const hydrationUrl = shouldHydrateLeaderOrigin
    ? buildTeleportStorageHydrationUrl(leaderStorageOrigin)
    : null;

  if (!leaderTargetId) {
    log.warn('No leader tab available for auth-state injection');
    return landingUrl;
  }

  await browser.attachToPage(leaderTargetId);
  if (cookies.length > 0) {
    await browser.sendCDP('Network.setCookies', { cookies });
    log.info('Injected cookies into leader tab', { count: cookies.length });
    log.debug('Injected cookies into leader tab details', {
      count: cookies.length,
      leaderTargetId,
    });
  }

  if (shouldHydrateLeaderOrigin && hydrationUrl) {
    log.info('Hydrating leader storage origin before landing', {
      storageEntries: countTeleportStorageEntries(followerStorage),
    });
    log.debug('Hydrating leader storage origin before landing details', {
      hydrationUrl,
      landingUrl,
      originalLeaderUrl: watcher.originalLeaderUrl,
      finalUrl,
      leaderTargetId,
      storageOrigin: leaderStorageOrigin,
      storageEntries: countTeleportStorageEntries(followerStorage),
    });
    await hydrateLeaderOriginThenLand(
      browser,
      leaderTargetId,
      followerStorage,
      hydrationUrl,
      landingUrl
    );
  } else {
    await replayLeaderStorageThenLand(browser, watcher, followerStorage, landingUrl, finalUrl);
  }

  return landingUrl;
}

/**
 * Capture cookies + app state from the follower, inject into the leader, navigate leader to the final URL.
 */
async function captureCookiesAndComplete(
  browser: BrowserAPI,
  _state: PlaywrightState,
  watcher: TeleportWatcher,
  runtimeId: string
): Promise<void> {
  if (watcher.phase !== 'teleporting' && watcher.phase !== 'waitingForReturn') return;
  watcher.phase = 'capturing';
  log.info('Capturing auth state from follower');
  log.debug('Capturing auth state from follower details', {
    followerTargetId: watcher.followerTargetId,
    runtimeId,
  });

  // Stop polling and timeout
  if (watcher.pollInterval) {
    clearInterval(watcher.pollInterval);
    watcher.pollInterval = undefined;
  }
  if (watcher.timeoutTimer) {
    clearTimeout(watcher.timeoutTimer);
    watcher.timeoutTimer = undefined;
  }

  try {
    const { cookies, followerStorage, finalUrl } = await captureFollowerAuthState(browser, watcher);
    const followerStorageEntries = countTeleportStorageEntries(followerStorage);
    const landingUrl = await injectAuthStateIntoLeader(
      browser,
      watcher,
      cookies,
      followerStorage,
      finalUrl
    );

    // Complete
    watcher.phase = 'done';
    cleanupTeleportWatcher(watcher);
    const domainNote =
      cookies.length > 0
        ? ` (${formatCookieDomainSummary(cookies as Array<{ domain?: string }>)})`
        : '';
    const storageNote =
      followerStorageEntries > 0
        ? ` + ${followerStorageEntries} storage entr${followerStorageEntries === 1 ? 'y' : 'ies'}`
        : '';
    const landedNote = landingUrl ? ` (navigated to ${landingUrl})` : '';
    const resultMsg = `Teleported ${cookies.length} cookie(s)${domainNote}${storageNote} from ${runtimeId}${landedNote}`;
    log.info('Teleport completed successfully', {
      cookieCount: cookies.length,
      storageEntries: followerStorageEntries,
      landed: !!landingUrl,
    });
    log.debug('Teleport completed successfully details', { result: resultMsg });
    watcher.resolveBlock?.(resultMsg);
  } catch (err) {
    log.error('Teleport auth-state capture failed', { error: String(err) });
    await removeFollowerTeleportStorageScript(watcher, 'capture-error');
    watcher.phase = 'done';
    cleanupTeleportWatcher(watcher);
    watcher.rejectBlock?.(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Check if a teleport watcher has been triggered and needs to block.
 * Returns a result string if blocked, null if not blocking.
 */
async function _checkTeleportBlock(
  state: PlaywrightState,
  targetId: string
): Promise<string | null> {
  const watcher = state.teleportWatchers.get(targetId);
  if (!watcher) return null;
  if (watcher.phase === 'done' || watcher.phase === 'timedOut') {
    log.info('Clearing completed teleport watcher', { phase: watcher.phase, targetId });
    state.teleportWatchers.delete(targetId);
    return null;
  }
  if (
    watcher.phase === 'teleporting' ||
    watcher.phase === 'waitingForAuth' ||
    watcher.phase === 'waitingForReturn' ||
    watcher.phase === 'capturing'
  ) {
    log.info('Blocking command — teleport in progress', { phase: watcher.phase, targetId });
    // Block until the teleport completes
    try {
      const result = await watcher.completionPromise!;
      log.info('Teleport block resolved');
      log.debug('Teleport block resolved details', { result });
      state.teleportWatchers.delete(targetId);
      return result;
    } catch (err) {
      log.warn('Teleport block rejected', { error: String(err), targetId });
      state.teleportWatchers.delete(targetId);
      throw err;
    }
  }
  return null;
}
