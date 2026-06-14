/**
 * Teleport auth-state capture/replay helpers: cookie summaries, local/session
 * storage snapshotting, init-script installation, and page diagnostics.
 */

import type { BrowserAPI } from '../../../cdp/index.js';
import { createLogger } from '../../../core/logger.js';
import type { TeleportPageDiagnostics, TeleportStorageSnapshot, TeleportWatcher } from './types.js';

const log = createLogger('playwright-teleport');

export const EMPTY_TELEPORT_STORAGE: TeleportStorageSnapshot = {
  origin: '',
  localStorage: {},
  sessionStorage: {},
};

/** Format a per-domain cookie count summary. */
export function formatCookieDomainSummary(cookies: Array<{ domain?: string }>): string {
  const counts = new Map<string, number>();
  for (const c of cookies) {
    const d = c.domain ?? 'unknown';
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return sorted.map(([domain, count]) => `${count} ${domain}`).join(', ');
}

export function countTeleportStorageEntries(snapshot: TeleportStorageSnapshot): number {
  return Object.keys(snapshot.localStorage).length + Object.keys(snapshot.sessionStorage).length;
}

export function tryGetTeleportUrlOrigin(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function buildTeleportStorageHydrationUrl(origin: string): string {
  try {
    return new URL('/favicon.ico', origin).toString();
  } catch {
    return origin;
  }
}

export function chooseTeleportLeaderLandingUrl(
  storageOrigin: string,
  originalLeaderUrl?: string,
  finalUrl?: string
): string | undefined {
  const originalOrigin = tryGetTeleportUrlOrigin(originalLeaderUrl);
  if (originalLeaderUrl && originalOrigin === storageOrigin) return originalLeaderUrl;

  const finalOrigin = tryGetTeleportUrlOrigin(finalUrl);
  if (finalUrl && finalOrigin === storageOrigin) return finalUrl;

  if (storageOrigin) return storageOrigin;
  return originalLeaderUrl ?? finalUrl;
}

export async function captureTeleportStorageSnapshot(
  browser: BrowserAPI,
  label: 'leader' | 'follower'
): Promise<TeleportStorageSnapshot> {
  const raw = await browser.evaluate(`(() => {
    const collect = (storage) => {
      const items = {};
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key !== null) items[key] = storage.getItem(key) ?? '';
      }
      return items;
    };
    return JSON.stringify({
      origin: window.location.origin,
      localStorage: collect(window.localStorage),
      sessionStorage: collect(window.sessionStorage),
    });
  })()`);

  if (typeof raw !== 'string' || raw.length === 0) {
    log.warn('Teleport storage capture returned non-string result', { label, type: typeof raw });
    return EMPTY_TELEPORT_STORAGE;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<TeleportStorageSnapshot>;
    return {
      origin: typeof parsed.origin === 'string' ? parsed.origin : '',
      localStorage: parsed.localStorage ?? {},
      sessionStorage: parsed.sessionStorage ?? {},
    };
  } catch (err) {
    log.warn('Could not parse teleport storage snapshot', { label, error: String(err) });
    return EMPTY_TELEPORT_STORAGE;
  }
}

export function buildTeleportStorageInitScript(snapshot: TeleportStorageSnapshot): string {
  const serialized = JSON.stringify(snapshot);
  return `(() => {
    const snapshot = ${serialized};
    if (!snapshot.origin || window.location.origin !== snapshot.origin) return;
    const markerKey = '__slicc_teleport_storage_applied__:' + snapshot.origin;
    try {
      if (window.sessionStorage.getItem(markerKey) === '1') return;
    } catch {}
    const apply = (storage, values) => {
      try { storage.clear(); } catch {}
      for (const [key, value] of Object.entries(values || {})) {
        storage.setItem(key, String(value));
      }
    };
    apply(window.localStorage, snapshot.localStorage || {});
    apply(window.sessionStorage, snapshot.sessionStorage || {});
    try { window.sessionStorage.setItem(markerKey, '1'); } catch {}
  })();`;
}

export function buildTeleportStorageApplyScript(snapshot: TeleportStorageSnapshot): string {
  const serialized = JSON.stringify(snapshot);
  return `(() => {
    const snapshot = ${serialized};
    if (!snapshot.origin || globalThis.location.origin !== snapshot.origin) {
      throw new Error('Teleport storage origin mismatch');
    }
    const apply = (storage, values) => {
      try { storage.clear(); } catch {}
      for (const [key, value] of Object.entries(values || {})) {
        storage.setItem(key, String(value));
      }
    };
    apply(localStorage, snapshot.localStorage || {});
    apply(sessionStorage, snapshot.sessionStorage || {});
    return JSON.stringify({
      origin: globalThis.location.origin,
      localStorageCount: Object.keys(snapshot.localStorage || {}).length,
      sessionStorageCount: Object.keys(snapshot.sessionStorage || {}).length,
    });
  })();`;
}

export async function applyTeleportStorageSnapshot(
  browser: BrowserAPI,
  snapshot: TeleportStorageSnapshot,
  target: 'leader' | 'follower'
): Promise<void> {
  const totalEntries = countTeleportStorageEntries(snapshot);
  if (totalEntries === 0) return;

  const raw = await browser.evaluate(buildTeleportStorageApplyScript(snapshot));
  log.info('Applied teleport storage snapshot on current page', {
    target,
    totalEntries,
    resultType: typeof raw,
  });
  log.debug('Applied teleport storage snapshot details', {
    target,
    origin: snapshot.origin || '(unknown)',
    totalEntries,
    resultType: typeof raw,
  });
}

export async function installTeleportStorageInitScript(
  browser: BrowserAPI,
  snapshot: TeleportStorageSnapshot,
  targetId: string,
  target: 'leader' | 'follower'
): Promise<(() => Promise<void>) | null> {
  const totalEntries = countTeleportStorageEntries(snapshot);
  if (totalEntries === 0) return null;

  const result = await browser.sendCDP('Page.addScriptToEvaluateOnNewDocument', {
    source: buildTeleportStorageInitScript(snapshot),
  });
  const identifier = typeof result['identifier'] === 'string' ? result['identifier'] : null;

  log.info('Installed teleport storage init script', {
    target,
    totalEntries,
    hasIdentifier: !!identifier,
  });
  log.debug('Installed teleport storage init script details', {
    target,
    origin: snapshot.origin || '(unknown)',
    localStorageCount: Object.keys(snapshot.localStorage).length,
    sessionStorageCount: Object.keys(snapshot.sessionStorage).length,
    hasIdentifier: !!identifier,
  });

  if (!identifier) return null;
  return async () => {
    try {
      await browser.attachToPage(targetId);
      await browser.sendCDP('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    } catch (err) {
      log.warn('Failed to remove teleport storage init script', { target, error: String(err) });
    }
  };
}

export async function captureTeleportPageDiagnostics(
  browser: BrowserAPI
): Promise<TeleportPageDiagnostics> {
  const raw = await browser.evaluate(`(() => JSON.stringify({
    url: window.location.href,
    title: document.title || '',
    bodySnippet: document.body?.innerText?.replace(/\\s+/g, ' ').trim().slice(0, 500) || '(empty)',
  }))()`);

  if (typeof raw !== 'string' || raw.length === 0) {
    return { url: '', title: '', bodySnippet: '(unavailable)' };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<TeleportPageDiagnostics>;
    return {
      url: typeof parsed.url === 'string' ? parsed.url : '',
      title: typeof parsed.title === 'string' ? parsed.title : '',
      bodySnippet:
        typeof parsed.bodySnippet === 'string' && parsed.bodySnippet.length > 0
          ? parsed.bodySnippet
          : '(empty)',
    };
  } catch {
    return { url: '', title: '', bodySnippet: '(unparseable)' };
  }
}

export function shouldCaptureTeleportDiagnostics(href: string): boolean {
  return /callback|authorize\/resume|error/i.test(href);
}

export async function logFollowerTeleportDiagnosticsOnce(
  browser: BrowserAPI,
  watcher: TeleportWatcher,
  reason: string
): Promise<void> {
  try {
    const diagnostics = await captureTeleportPageDiagnostics(browser);
    const key = `${reason}:${diagnostics.url}:${diagnostics.title}`;
    if (watcher.lastFollowerDiagnosticKey === key) return;
    watcher.lastFollowerDiagnosticKey = key;
    log.debug('Teleport follower diagnostics', {
      reason,
      url: diagnostics.url,
      title: diagnostics.title,
      bodySnippet: diagnostics.bodySnippet,
    });
  } catch (err) {
    log.warn('Could not capture teleport follower diagnostics', { reason, error: String(err) });
  }
}

export async function removeFollowerTeleportStorageScript(
  watcher: TeleportWatcher,
  reason: string
): Promise<void> {
  const remove = watcher.removeFollowerStorageScript;
  if (!remove) return;
  watcher.removeFollowerStorageScript = null;
  try {
    await remove();
    log.info('Removed follower teleport storage init script', { reason });
  } catch (err) {
    log.warn('Failed to remove follower teleport storage init script', {
      reason,
      error: String(err),
    });
  }
}
