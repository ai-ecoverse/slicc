import { type CookieTeleportCookie, isSliccAppUrl } from '@slicc/shared-ts';
import { createLogger } from '../../base/logger.js';
import type { BrowserAPI } from '../../cdp/index.js';
import {
  captureTeleportStorageSnapshot,
  countTeleportStorageEntries,
  EMPTY_TELEPORT_STORAGE,
  installTeleportStorageInitScript,
  removeTeleportStorageScript,
  type TeleportStorageScript,
} from '../../shell/supplemental-commands/playwright/teleport-storage.js';
import type { TeleportStorageSnapshot } from '../../shell/supplemental-commands/playwright/types.js';

const log = createLogger('tab-teleport');

function selfUiOrigins(): string[] | undefined {
  return typeof location !== 'undefined' && location.origin ? [location.origin] : undefined;
}

const TAB_TELEPORT_TIMEOUT_MS = 30_000;

const INIT_SCRIPT_LINGER_MS = 10_000;

export type TabTeleportDestination = { kind: 'leader' } | { kind: 'runtime'; runtimeId: string };

export interface TabTeleportSpec {
  sourceTargetId: string;
  destination: TabTeleportDestination;

  url?: string;
}

export interface TabTeleportResult {
  targetId: string;
  url: string;
  cookieCount: number;
  storageEntryCount: number;

  degraded: 'none' | 'no-source-state' | 'no-source-cookies' | 'no-dest-cookies';
}

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
  return browser.withTab(sourceTargetId, async (page) => {
    let url = urlOverride;
    if (!url) {
      const raw = await page.evaluate('window.location.href');
      url = typeof raw === 'string' ? raw : String(raw);
    }
    if (!url || url === 'about:blank') {
      throw new Error(`source tab ${sourceTargetId} has no usable URL`);
    }

    if (isSliccAppUrl(url, { selfOrigins: selfUiOrigins() })) {
      throw new Error('refusing to teleport SLICC’s own app tab (it carries a bridge capability)');
    }

    let cookies: CookieTeleportCookie[] = [];
    let cookiesCaptured = false;
    try {
      const cookieResult = await page.send('Network.getCookies', {});
      cookies = cookiesFromCdpResult(cookieResult['cookies']);
      cookiesCaptured = true;
    } catch (err) {
      log.warn('Could not capture source cookies', { error: String(err) });
    }

    let storage = EMPTY_TELEPORT_STORAGE;
    try {
      storage = await captureTeleportStorageSnapshot(page, 'leader');
    } catch (err) {
      log.warn('Could not capture source storage', { error: String(err) });
    }

    return { url, cookies, cookiesCaptured, storage };
  });
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

function scheduleInitScriptRemoval(
  browser: BrowserAPI,
  script: TeleportStorageScript | null
): void {
  if (!script) return;
  const timer = setTimeout(() => {
    browser
      .withTab(script.targetId, (page) => removeTeleportStorageScript(page, script, 'follower'))
      .catch((err) => {
        log.warn('Deferred init-script removal failed', { error: String(err) });
      });
  }, INIT_SCRIPT_LINGER_MS);

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

  const { cookiesInjected, initScript } = await browser.withTab(destTargetId, async (page) => {
    await page.send('Page.enable');

    let injected = true;
    if (source.cookies.length > 0) {
      try {
        await page.send('Network.setCookies', { cookies: source.cookies });
      } catch (err) {
        injected = false;
        log.warn('Destination rejected cookie injection', { error: String(err) });
      }
    }

    const script = await installTeleportStorageInitScript(page, source.storage, 'follower');

    await page.send('Page.navigate', { url: source.url });
    try {
      await page.bringToFront();
    } catch (err) {
      log.warn('Could not foreground destination tab', { error: String(err) });
    }
    return { cookiesInjected: injected, initScript: script };
  });
  scheduleInitScriptRemoval(browser, initScript);

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
