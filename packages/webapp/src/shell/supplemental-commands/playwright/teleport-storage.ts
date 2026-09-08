/**
 * Teleport auth-state capture/replay helpers: cookie summaries, local/session
 * storage snapshotting, init-script installation, and page diagnostics.
 */

import { createLogger } from '../../../base/logger.js';
import type { TeleportPageDiagnostics, TeleportStorageSnapshot, TeleportWatcher } from './types.js';

const log = createLogger('playwright-teleport');

/**
 * Duck type for the CDP surface teleport-storage needs — avoids a shell → cdp
 * layer back-edge (`docs/review-patterns.md` § Layer-stack import direction).
 * Callers pass the real `TabHandle` from `withTab`, so every command below
 * names the session it runs on instead of borrowing a bridge-wide cursor.
 */
export interface TeleportStorageTab {
  readonly targetId: string;
  evaluate(expression: string): Promise<unknown>;
  send(
    method: string,
    params?: { source?: string; identifier?: string }
  ): Promise<{ identifier?: unknown }>;
}

/** The `withTab` half of the same duck type, for callers holding no handle. */
export interface TeleportStorageBrowser {
  withTab<T>(targetId: string, fn: (tab: TeleportStorageTab) => Promise<T>): Promise<T>;
}

/**
 * An installed `Page.addScriptToEvaluateOnNewDocument` registration.
 *
 * Carries its own `targetId` so a caller that is NOT inside the tab's
 * `withTab` body (the timeout handler, an error path) can re-enter it to
 * remove the script — the per-tab lock is not reentrant, so a caller that IS
 * inside one must pass its handle instead.
 */
export interface TeleportStorageScript {
  identifier: string;
  targetId: string;
}

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
  page: TeleportStorageTab,
  label: 'leader' | 'follower'
): Promise<TeleportStorageSnapshot> {
  const raw = await page.evaluate(`(() => {
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
  page: TeleportStorageTab,
  snapshot: TeleportStorageSnapshot,
  target: 'leader' | 'follower'
): Promise<void> {
  const totalEntries = countTeleportStorageEntries(snapshot);
  if (totalEntries === 0) return;

  const raw = await page.evaluate(buildTeleportStorageApplyScript(snapshot));
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
  page: TeleportStorageTab,
  snapshot: TeleportStorageSnapshot,
  target: 'leader' | 'follower'
): Promise<TeleportStorageScript | null> {
  const totalEntries = countTeleportStorageEntries(snapshot);
  if (totalEntries === 0) return null;

  const result = await page.send('Page.addScriptToEvaluateOnNewDocument', {
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
  return { identifier, targetId: page.targetId };
}

/** Remove an installed init script through a handle the caller already holds. */
export async function removeTeleportStorageScript(
  page: TeleportStorageTab,
  script: TeleportStorageScript | null,
  target: 'leader' | 'follower'
): Promise<void> {
  if (!script) return;
  try {
    await page.send('Page.removeScriptToEvaluateOnNewDocument', {
      identifier: script.identifier,
    });
  } catch (err) {
    log.warn('Failed to remove teleport storage init script', { target, error: String(err) });
  }
}

export async function captureTeleportPageDiagnostics(
  page: TeleportStorageTab
): Promise<TeleportPageDiagnostics> {
  const raw = await page.evaluate(`(() => JSON.stringify({
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
  page: TeleportStorageTab,
  watcher: TeleportWatcher,
  reason: string
): Promise<void> {
  try {
    const diagnostics = await captureTeleportPageDiagnostics(page);
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

/**
 * Remove the follower's init script, re-entering its tab to do so.
 *
 * Must NOT be called from inside that tab's own `withTab` body — the per-tab
 * lock is not reentrant. Every caller here is on an error / timeout path that
 * holds no handle.
 */
export async function removeFollowerTeleportStorageScript(
  browser: TeleportStorageBrowser,
  watcher: TeleportWatcher,
  reason: string
): Promise<void> {
  const script = watcher.followerStorageScript;
  if (!script) return;
  watcher.followerStorageScript = null;
  try {
    await browser.withTab(script.targetId, (page) =>
      removeTeleportStorageScript(page, script, 'follower')
    );
    log.info('Removed follower teleport storage init script', { reason });
  } catch (err) {
    log.warn('Failed to remove follower teleport storage init script', {
      reason,
      error: String(err),
    });
  }
}
