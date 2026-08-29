/**
 * One-way, leave-open tab teleport: capture cookies + web storage from a
 * source tab (local or federated), open a FOREGROUND tab at the destination,
 * replay the state, navigate, and leave the tab there.
 *
 * This is the user-facing "open this tab in front of me" primitive behind the
 * browser rail. Unlike the Okta auth watcher in `teleport.ts` there is no
 * start/return pattern, no polling, no return leg, and the destination tab is
 * never closed on success. Both flows share the capture/replay primitives in
 * `teleport-storage.ts`.
 */

import { type CookieTeleportCookie, isSliccAppUrl } from '@slicc/shared-ts';
import { createLogger } from '../../base/logger.js';
import type { BrowserAPI } from '../../cdp/index.js';
import {
  captureTeleportStorageSnapshot,
  countTeleportStorageEntries,
  EMPTY_TELEPORT_STORAGE,
  installTeleportStorageInitScript,
} from '../../shell/supplemental-commands/playwright/teleport-storage.js';
import type { TeleportStorageSnapshot } from '../../shell/supplemental-commands/playwright/types.js';

const log = createLogger('tab-teleport');

/**
 * The origin serving this float's own UI. In development that is a local
 * wrangler rather than a hosted origin, so it has to be discovered rather
 * than assumed. Undefined in the kernel worker, where `location` is absent.
 */
function selfUiOrigins(): string[] | undefined {
  return typeof location !== 'undefined' && location.origin ? [location.origin] : undefined;
}

/** Overall cap on capture + open + inject + navigation start. */
const TAB_TELEPORT_TIMEOUT_MS = 30_000;
/** How long the storage-replay init script may stay installed after navigate. */
const INIT_SCRIPT_LINGER_MS = 10_000;

export type TabTeleportDestination = { kind: 'leader' } | { kind: 'runtime'; runtimeId: string };

export interface TabTeleportSpec {
  /** Source tab: local targetId or composite `runtimeId:localTargetId`. */
  sourceTargetId: string;
  destination: TabTeleportDestination;
  /** URL to open at the destination. Defaults to the source tab's current URL. */
  url?: string;
}

export interface TabTeleportResult {
  /** The destination tab id (composite for remote destinations). */
  targetId: string;
  url: string;
  cookieCount: number;
  storageEntryCount: number;
  /**
   * How much session state actually traveled:
   * - `none`: cookies + storage captured and injected.
   * - `no-source-state`: nothing could be captured — bare URL open.
   * - `no-source-cookies`: the source refused cookie capture but storage
   *   travelled. A cookie-authenticated site still lands logged out, so this
   *   is reported rather than folded into `none`.
   * - `no-dest-cookies`: captured, but the destination rejected cookie
   *   injection (storage may still have replayed via the init script).
   */
  degraded: 'none' | 'no-source-state' | 'no-source-cookies' | 'no-dest-cookies';
}

/** Narrow CDP `Network.getCookies` result into the shared cookie shape. */
function cookiesFromCdpResult(cookies: unknown): CookieTeleportCookie[] {
  if (!Array.isArray(cookies)) return [];
  return cookies as CookieTeleportCookie[];
}

interface SourceCapture {
  url: string;
  cookies: CookieTeleportCookie[];
  cookiesCaptured: boolean;
  storage: TeleportStorageSnapshot;
}

async function captureSourceState(
  browser: BrowserAPI,
  sourceTargetId: string,
  urlOverride: string | undefined
): Promise<SourceCapture> {
  await browser.attachToPage(sourceTargetId);
  let url = urlOverride;
  if (!url) {
    const raw = await browser.evaluate('window.location.href');
    url = typeof raw === 'string' ? raw : String(raw);
  }
  if (!url || url === 'about:blank') {
    throw new Error(`source tab ${sourceTargetId} has no usable URL`);
  }
  // Hard stop, not just a UI filter: SLICC's own app shell carries
  // `bridgeToken` in its URL, so teleporting it would copy a capability for
  // this machine's CDP bridge into another browser. Enforced here because
  // every path — both rails and the tray router — funnels through this
  // capture.
  if (isSliccAppUrl(url, { selfOrigins: selfUiOrigins() })) {
    throw new Error('refusing to teleport SLICC’s own app tab (it carries a bridge capability)');
  }

  let cookies: CookieTeleportCookie[] = [];
  let cookiesCaptured = false;
  try {
    const cookieResult = await browser.sendCDP('Network.getCookies', {});
    cookies = cookiesFromCdpResult(cookieResult['cookies']);
    cookiesCaptured = true;
  } catch (err) {
    log.warn('Could not capture source cookies', { error: String(err) });
  }

  let storage = EMPTY_TELEPORT_STORAGE;
  try {
    storage = await captureTeleportStorageSnapshot(browser, 'leader');
  } catch (err) {
    log.warn('Could not capture source storage', { error: String(err) });
  }

  return { url, cookies, cookiesCaptured, storage };
}

async function openDestinationTab(
  browser: BrowserAPI,
  destination: TabTeleportDestination
): Promise<string> {
  if (destination.kind === 'leader') {
    return browser.createPage('about:blank');
  }
  const rawTargetId = await browser.createRemotePage(destination.runtimeId, 'about:blank');
  return rawTargetId.includes(':') ? rawTargetId : `${destination.runtimeId}:${rawTargetId}`;
}

/**
 * Remove the storage-replay init script once the navigation has had a chance
 * to load (the script is origin-guarded and once-only, so a short linger is
 * safe). Detached on purpose: the teleport result must not wait on it.
 */
function scheduleInitScriptRemoval(remove: (() => Promise<void>) | null): void {
  if (!remove) return;
  const timer = setTimeout(() => {
    remove().catch((err) => {
      log.warn('Deferred init-script removal failed', { error: String(err) });
    });
  }, INIT_SCRIPT_LINGER_MS);
  // Node-style timers keep the process alive; in workers this is a no-op.
  (timer as { unref?: () => void }).unref?.();
}

async function runTabTeleport(
  browser: BrowserAPI,
  spec: TabTeleportSpec,
  onDestinationCreated: (targetId: string) => void
): Promise<TabTeleportResult> {
  const source = await captureSourceState(browser, spec.sourceTargetId, spec.url);
  const storageEntryCount = countTeleportStorageEntries(source.storage);
  const sourceStateEmpty = !source.cookiesCaptured && storageEntryCount === 0;
  log.info('Captured source state for tab teleport', {
    cookieCount: source.cookies.length,
    storageEntryCount,
    degradedToBareUrl: sourceStateEmpty,
  });

  const destTargetId = await openDestinationTab(browser, spec.destination);
  onDestinationCreated(destTargetId);
  await browser.attachToPage(destTargetId);
  await browser.sendCDP('Page.enable');

  let cookiesInjected = true;
  if (source.cookies.length > 0) {
    try {
      await browser.sendCDP('Network.setCookies', { cookies: source.cookies });
    } catch (err) {
      cookiesInjected = false;
      log.warn('Destination rejected cookie injection', { error: String(err) });
    }
  }

  const removeInitScript = await installTeleportStorageInitScript(
    browser,
    source.storage,
    destTargetId,
    'follower'
  );

  await browser.sendCDP('Page.navigate', { url: source.url });
  try {
    await browser.bringToFront();
  } catch (err) {
    log.warn('Could not foreground destination tab', { error: String(err) });
  }
  scheduleInitScriptRemoval(removeInitScript);

  const degraded = sourceStateEmpty
    ? 'no-source-state'
    : !source.cookiesCaptured
      ? 'no-source-cookies'
      : cookiesInjected
        ? 'none'
        : 'no-dest-cookies';
  log.info('Tab teleport completed', {
    destTargetId,
    cookieCount: source.cookies.length,
    storageEntryCount,
    degraded,
  });
  return {
    targetId: destTargetId,
    url: source.url,
    cookieCount: source.cookies.length,
    storageEntryCount,
    degraded,
  };
}

/**
 * Teleport a tab's URL + session state to a destination, foreground, and
 * leave it open. Throws on timeout or setup failure; a half-created
 * destination tab is closed on the way out.
 */
export async function teleportTabOneWay(
  browser: BrowserAPI,
  spec: TabTeleportSpec
): Promise<TabTeleportResult> {
  let destTargetId: string | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(
      () =>
        reject(
          new Error(`tab teleport timed out after ${Math.round(TAB_TELEPORT_TIMEOUT_MS / 1000)}s`)
        ),
      TAB_TELEPORT_TIMEOUT_MS
    );
  });

  const run = runTabTeleport(browser, spec, (targetId) => {
    destTargetId = targetId;
  });
  // If the timeout wins the race, the still-running attempt must not surface
  // an unhandled rejection when it eventually fails.
  run.catch(() => {});

  try {
    return await Promise.race([run, timeout]);
  } catch (err) {
    if (destTargetId) {
      try {
        await browser.closePage(destTargetId);
      } catch (closeErr) {
        log.warn('Failed to close half-created destination tab', { error: String(closeErr) });
      }
    }
    throw err;
  } finally {
    clearTimeout(timeoutTimer);
  }
}
