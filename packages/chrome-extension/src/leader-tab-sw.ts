import { LEADER_EXT_ID_QUERY_NAME, SLICC_HOSTED_ORIGIN } from '@slicc/shared-ts';
import { broadcastLeaderGone } from './cherry-panel-sw.js';

const LEADER_TAB_ID_KEY = 'slicc_leader_tab_id';

const PROD_LEADER_TAB_URL = `${SLICC_HOSTED_ORIGIN}/?slicc=leader`;
const PROD_LEADER_TAB_URL_GLOB = `${SLICC_HOSTED_ORIGIN}/*`;
const PROD_LEADER_TAB_ORIGIN = SLICC_HOSTED_ORIGIN;

const DEV_LEADER_TAB_URL = 'http://localhost:8787/?slicc=leader';
const DEV_LEADER_TAB_URL_GLOB = 'http://localhost:8787/*';
const DEV_LEADER_TAB_ORIGIN = 'http://localhost:8787';

export function getLeaderTabUrl(isExtDev: boolean): string {
  return isExtDev ? DEV_LEADER_TAB_URL : PROD_LEADER_TAB_URL;
}

export function getLeaderTabUrlGlob(isExtDev: boolean): string {
  return isExtDev ? DEV_LEADER_TAB_URL_GLOB : PROD_LEADER_TAB_URL_GLOB;
}

export function getLeaderTabOrigin(isExtDev: boolean): string {
  return isExtDev ? DEV_LEADER_TAB_ORIGIN : PROD_LEADER_TAB_ORIGIN;
}

export function appendLeaderExtIdParam(leaderUrl: string, extensionId: string | undefined): string {
  if (!extensionId) return leaderUrl;
  try {
    const u = new URL(leaderUrl);
    u.searchParams.set(LEADER_EXT_ID_QUERY_NAME, extensionId);
    return u.toString();
  } catch {
    return leaderUrl;
  }
}

export function leaderUrlHasExtId(
  rawUrl: string | undefined,
  extensionId: string | undefined
): boolean {
  if (!rawUrl || !extensionId) return false;
  try {
    return new URL(rawUrl).searchParams.get(LEADER_EXT_ID_QUERY_NAME) === extensionId;
  } catch {
    return false;
  }
}

const LEADER_TAB_URL = getLeaderTabUrl(__SLICC_EXT_DEV__);
const LEADER_TAB_URL_GLOB = getLeaderTabUrlGlob(__SLICC_EXT_DEV__);
const LEADER_TAB_ORIGIN = getLeaderTabOrigin(__SLICC_EXT_DEV__);

export async function readStoredLeaderTabId(): Promise<number | undefined> {
  try {
    const result = await chrome.storage.session.get(LEADER_TAB_ID_KEY);
    const raw = result[LEADER_TAB_ID_KEY];
    return typeof raw === 'number' ? raw : undefined;
  } catch (err) {
    console.error('[slicc-sw] storage.session.get leader tab id failed', err);
    return undefined;
  }
}

export async function writeStoredLeaderTabId(tabId: number): Promise<void> {
  await chrome.storage.session.set({ [LEADER_TAB_ID_KEY]: tabId });
  await markLeaderTabNotDiscardable(tabId);
}

async function markLeaderTabNotDiscardable(tabId: number): Promise<void> {
  try {
    await chrome.tabs.update(tabId, { autoDiscardable: false });
  } catch (err) {
    console.warn('[slicc-sw] failed to exempt leader tab from discard/freeze', err);
  }
}

async function clearStoredLeaderTabId(): Promise<void> {
  await chrome.storage.session.remove(LEADER_TAB_ID_KEY);
}

function isLeaderTabUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }

  if (u.origin !== LEADER_TAB_ORIGIN) return false;
  return u.searchParams.get('slicc') === 'leader';
}

async function reconcileLeaderTabOnBoot(): Promise<void> {
  const storedId = await readStoredLeaderTabId();
  if (storedId === undefined) return;
  let tab: ChromeTab | undefined;
  try {
    tab = await chrome.tabs.get(storedId);
  } catch {}
  if (tab !== undefined && isLeaderTabUrl(tab.url)) return;
  await clearStoredLeaderTabId();
}

let leaderTabLock: Promise<void> | null = null;

async function queryLeaderTabs(): Promise<ChromeTab[]> {
  try {
    const matches = await chrome.tabs.query({ url: LEADER_TAB_URL_GLOB });
    return matches.filter((t) => isLeaderTabUrl(t.url) && t.id !== undefined);
  } catch (err) {
    console.error('[slicc-sw] tabs.query for leader tab failed', err);
    return [];
  }
}

async function createLeaderTab(): Promise<void> {
  const created = await chrome.tabs.create({
    url: appendLeaderExtIdParam(LEADER_TAB_URL, chrome.runtime.id),
    active: false,
    pinned: true,
  });
  if (created.id !== undefined) await writeStoredLeaderTabId(created.id);
}

function isUnloadedTab(tab: ChromeTab): boolean {
  return tab.discarded === true || tab.status === 'unloaded';
}

async function adoptSingleLeaderTab(matches: ChromeTab[]): Promise<void> {
  const keep = matches.find((t) => !isUnloadedTab(t)) ?? matches[0];
  const extras = matches.filter((t) => t !== keep);
  if (keep.id === undefined) return;

  for (const extra of extras) {
    if (extra.id === undefined || extra.id === keep.id) continue;
    try {
      await chrome.tabs.remove(extra.id);
    } catch (err) {
      console.error('[slicc-sw] failed to close duplicate leader tab', err);
    }
  }

  const extIdUrl =
    keep.url !== undefined &&
    chrome.runtime.id !== undefined &&
    !leaderUrlHasExtId(keep.url, chrome.runtime.id)
      ? appendLeaderExtIdParam(keep.url, chrome.runtime.id)
      : undefined;
  if (extIdUrl !== undefined || keep.pinned !== true) {
    const props: { pinned: true; url?: string } = { pinned: true };
    if (extIdUrl !== undefined) props.url = extIdUrl;
    await chrome.tabs.update(keep.id, props);
  }

  if (extIdUrl === undefined && isUnloadedTab(keep)) {
    try {
      await chrome.tabs.reload(keep.id);
    } catch (err) {
      console.error('[slicc-sw] failed to reload unloaded leader tab', err);
    }
  }
  await writeStoredLeaderTabId(keep.id);
}

export async function ensureLeaderTab(): Promise<void> {
  if (leaderTabLock !== null) return leaderTabLock;
  leaderTabLock = (async () => {
    try {
      const matches = await queryLeaderTabs();
      if (matches.length === 0) await createLeaderTab();
      else await adoptSingleLeaderTab(matches);
    } finally {
      leaderTabLock = null;
    }
  })();
  return leaderTabLock;
}

export async function reloadLeaderTabIfExists(): Promise<boolean> {
  const id = await readStoredLeaderTabId();
  if (typeof id !== 'number') return false;
  try {
    await chrome.tabs.reload(id);
    return true;
  } catch {
    return false;
  }
}

export async function focusLeaderTab(): Promise<void> {
  const storedId = await readStoredLeaderTabId();
  if (storedId !== undefined) {
    let leaderTab: ChromeTab | undefined;
    try {
      leaderTab = await chrome.tabs.get(storedId);
    } catch {
      leaderTab = undefined;
    }
    if (leaderTab !== undefined && isLeaderTabUrl(leaderTab.url)) {
      await chrome.tabs.update(storedId, { active: true });
      if (leaderTab.windowId !== undefined) {
        await chrome.windows.update(leaderTab.windowId, { focused: true });
      }
      return;
    }

    await clearStoredLeaderTabId();
  }
  await ensureLeaderTab();
  const newId = await readStoredLeaderTabId();
  if (newId === undefined) return;
  const tab = await chrome.tabs.get(newId).catch(() => undefined);
  if (tab === undefined) return;
  await chrome.tabs.update(newId, { active: true });
  if (tab.windowId !== undefined) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
}

const UPDATE_RELOAD_GUARD_KEY = 'slicc_update_reload_at';
const UPDATE_RELOAD_GUARD_MS = 60_000;

async function isWithinUpdateReloadGuard(): Promise<boolean> {
  const result = await chrome.storage.session.get(UPDATE_RELOAD_GUARD_KEY);
  const stamp = result[UPDATE_RELOAD_GUARD_KEY];
  if (typeof stamp !== 'number') return false;
  return Date.now() - stamp < UPDATE_RELOAD_GUARD_MS;
}

async function stampUpdateReloadGuard(): Promise<void> {
  await chrome.storage.session.set({ [UPDATE_RELOAD_GUARD_KEY]: Date.now() });
}

async function reloadLeaderTabForUpdate(): Promise<void> {
  if (await isWithinUpdateReloadGuard()) return;

  if (await reloadLeaderTabIfExists()) await stampUpdateReloadGuard();
}

async function handleLeaderTabRemoved(tabId: number): Promise<void> {
  const storedId = await readStoredLeaderTabId();
  if (storedId !== tabId) return;
  await clearStoredLeaderTabId();
  broadcastLeaderGone();
}

export function installLeaderTabListeners(): void {
  reconcileLeaderTabOnBoot().catch((err) => {
    console.error('[slicc-sw] reconcile leader tab failed', err);
  });

  chrome.runtime.onUpdateAvailable.addListener((details) => {
    console.log('[slicc-sw] Extension update available', details.version);

    reloadLeaderTabForUpdate()
      .catch((err) => {
        console.error('[slicc-sw] onUpdateAvailable handler failed', err);
      })
      .finally(() => {
        chrome.runtime.reload();
      });
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    handleLeaderTabRemoved(tabId).catch((err) => {
      console.error('[slicc-sw] handleLeaderTabRemoved failed', err);
    });
  });
}
