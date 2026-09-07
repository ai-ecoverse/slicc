/**
 * Leader-tab lifecycle — pin, adopt, reload, reconcile and focus the hosted
 * leader tab, plus the extension-update reload guard.
 *
 * The thin extension opens https://www.sliccy.ai/?slicc=leader in a pinned
 * "home" tab that acts as the tray leader. The on-demand side panel
 * (`sidepanel.html`) iframes a `?cherry=1&ui-only=1` follower that connects to
 * this leader over the tray, so the agent runs even with no page open.
 *
 * `chrome.storage.session` persists the tab id; reconciliation runs at SW
 * startup; `ensureLeaderTab` creates the pinned tab if missing;
 * `tabs.onRemoved` clears the storage when the user closes the leader tab.
 *
 * The bridge transport (`bridge-sw.ts`) reads `LEADER_TAB_ID_KEY` from
 * `chrome.storage.session` for its three-factor pinning — keep the key
 * name and shape stable.
 *
 * Chrome extension API types provided by ./chrome.d.ts
 */

import { LEADER_EXT_ID_QUERY_NAME, SLICC_HOSTED_ORIGIN } from '@slicc/shared-ts';
import { broadcastLeaderGone } from './cherry-panel-sw.js';

const LEADER_TAB_ID_KEY = 'slicc_leader_tab_id';

/** Hosted (production) leader-tab URL and matching tabs.query glob. */
const PROD_LEADER_TAB_URL = `${SLICC_HOSTED_ORIGIN}/?slicc=leader`;
const PROD_LEADER_TAB_URL_GLOB = `${SLICC_HOSTED_ORIGIN}/*`;
const PROD_LEADER_TAB_ORIGIN = SLICC_HOSTED_ORIGIN;
/** Local wrangler dev-server leader-tab URL. Selected when the extension was
 *  built with `SLICC_EXT_DEV=1`. Points at the two-service dev harness UI
 *  origin (wrangler on :8787), NOT the node/swift thin-bridge backend port. */
const DEV_LEADER_TAB_URL = 'http://localhost:8787/?slicc=leader';
const DEV_LEADER_TAB_URL_GLOB = 'http://localhost:8787/*';
const DEV_LEADER_TAB_ORIGIN = 'http://localhost:8787';

/** Pure resolver — returns the leader-tab URL the SW should pin. Parameterized
 *  on the build-time `__SLICC_EXT_DEV__` flag so unit tests exercise both
 *  branches without rebuilding. */
export function getLeaderTabUrl(isExtDev: boolean): string {
  return isExtDev ? DEV_LEADER_TAB_URL : PROD_LEADER_TAB_URL;
}

/** Pure resolver — returns the `tabs.query` URL glob used to adopt a leader
 *  tab restored by Chrome's "Continue where you left off". */
export function getLeaderTabUrlGlob(isExtDev: boolean): string {
  return isExtDev ? DEV_LEADER_TAB_URL_GLOB : PROD_LEADER_TAB_URL_GLOB;
}

/** Pure resolver — returns the canonical origin a leader-tab URL must
 *  match. Used by `isLeaderTabUrl` so a stored tab id is only accepted
 *  when it still points at the build's pinned origin. */
export function getLeaderTabOrigin(isExtDev: boolean): string {
  return isExtDev ? DEV_LEADER_TAB_ORIGIN : PROD_LEADER_TAB_ORIGIN;
}

/** Append the extension id to a leader-tab URL as the `ext` query param so
 *  the leader page can open the bridge Port back to this SW. Returns the URL
 *  unchanged when the id is absent (`chrome.runtime.id` is typed optional) or
 *  the URL can't be parsed. Pure + exported for unit testing. */
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

/** Reports whether a leader-tab URL already carries the correct `ext` query
 *  param for this SW. Used by the adoption branch so a Chrome-restored leader
 *  tab missing `ext=` gets reloaded with it (otherwise the page can never open
 *  the bridge Port back). Returns false when either input is absent or the URL
 *  can't be parsed. Pure + exported for unit testing. */
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

/**
 * Exempt the leader tab from Chrome's tab discarding AND — via Chrome's
 * FreezingFollowsDiscardOptOut — from background-tab freezing. A frozen
 * leader runs no JS, so the tray, bridge, and kernel all stall until the
 * user foregrounds the tab (Chrome 151 then force-reloads it: the "dead
 * tab"). The extension float cannot control launch flags the way the CLI
 * launchers do (chrome-launch.ts / ChromeLauncher.swift disable the
 * freezing features at spawn), so this per-tab opt-out is its parity
 * equivalent. autoDiscardable is per-tab browser state that resets on
 * browser restart; every path that learns a leader tabId (create, adopt,
 * self-adopt via bridge-sw) funnels through writeStoredLeaderTabId, which
 * re-applies it.
 */
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
  // Pin to the exact leader origin selected at build time — `www.sliccy.ai`
  // in production, `http://localhost:8787` when built with `SLICC_EXT_DEV=1`.
  // The Cloudflare worker 301-redirects bare-host requests to `www`, so any
  // prod leader URL the user restored from a previous session has settled at
  // the www subdomain.
  if (u.origin !== LEADER_TAB_ORIGIN) return false;
  return u.searchParams.get('slicc') === 'leader';
}

async function reconcileLeaderTabOnBoot(): Promise<void> {
  const storedId = await readStoredLeaderTabId();
  if (storedId === undefined) return;
  let tab: ChromeTab | undefined;
  try {
    tab = await chrome.tabs.get(storedId);
  } catch {
    // Tab gone (closed while SW was evicted or storage.session restored stale)
  }
  if (tab !== undefined && isLeaderTabUrl(tab.url)) return;
  await clearStoredLeaderTabId();
}

// Serialize concurrent ensureLeaderTab() calls (action-icon click + cherry-panel
// recovery can fire together) so they can't race past the query and create
// duplicate pinned tabs.
let leaderTabLock: Promise<void> | null = null;

/** Query every open tab that is a valid leader tab (origin + `slicc=leader`). */
async function queryLeaderTabs(): Promise<ChromeTab[]> {
  try {
    const matches = await chrome.tabs.query({ url: LEADER_TAB_URL_GLOB });
    return matches.filter((t) => isLeaderTabUrl(t.url) && t.id !== undefined);
  } catch (err) {
    console.error('[slicc-sw] tabs.query for leader tab failed', err);
    return [];
  }
}

/** Create a fresh pinned leader tab and store its id. */
async function createLeaderTab(): Promise<void> {
  const created = await chrome.tabs.create({
    url: appendLeaderExtIdParam(LEADER_TAB_URL, chrome.runtime.id),
    active: false,
    pinned: true,
  });
  if (created.id !== undefined) await writeStoredLeaderTabId(created.id);
}

/** True when the tab exists but runs no JS: discarded by Chrome's memory saver,
 *  or restored-but-never-loaded by lazy session restore. Such a tab can never
 *  dial the bridge Port or deliver `leader.join-url`, so adopting it as-is
 *  strands the side panel on "Disconnected — reopen to retry" (its 20s boot
 *  watchdog fires with no joinUrl, and reopening re-adopts the same dead tab). */
function isUnloadedTab(tab: ChromeTab): boolean {
  return tab.discarded === true || tab.status === 'unloaded';
}

/** Keep the first LIVE leader tab (stamp `ext=` + pin if needed, store its id,
 *  reload it when Chrome unloaded it) and close every duplicate. Preferring a
 *  live match over an unloaded one avoids closing a working leader in favor of
 *  a dead duplicate. `matches` must be non-empty. */
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
  // A discarded/unloaded leader runs no JS, so it can never deliver the tray
  // joinUrl — reload it (loads without focusing) unless the ext= stamp above
  // already navigated it. Without this the panel loops booting → disconnected
  // until the user happens to activate the tab manually.
  if (extIdUrl === undefined && isUnloadedTab(keep)) {
    try {
      await chrome.tabs.reload(keep.id);
    } catch (err) {
      console.error('[slicc-sw] failed to reload unloaded leader tab', err);
    }
  }
  await writeStoredLeaderTabId(keep.id);
}

/**
 * Ensure EXACTLY ONE pinned leader tab exists, keeping/adopting one and closing
 * any duplicates, and creating one only when none is open.
 *
 * This runs ON DEMAND — from the action-icon click (which opens the side panel
 * and connects the cherry-panel Port) and cherry-panel recovery — NOT on browser
 * startup. The pinned leader tab is sticky: Chrome restores it on restart, so
 * there is nothing to create then. Creating on `onStartup`/`onInstalled` is what
 * used to RACE session-restore and spawn a duplicate every launch (the tab is
 * restored a moment after the SW's startup query ran and found nothing). By only
 * ensuring on the user's icon click, restart can never duplicate the tab. The
 * restored tab re-identifies itself to the SW via its bridge connection (see
 * `validateBridgePin` self-adopt), so it doesn't need the SW to find it on boot.
 *
 * Adoption bakes in the `ext=` param the page needs to open the bridge Port and
 * pins the tab, matching a freshly-created leader; the `tabs.update` is skipped
 * when the kept tab is already correct.
 */
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
    return false; // tab vanished between read and reload
  }
}

/** Activate the pinned leader tab and focus its window, (re)creating it when
 *  the stored id is stale. The thin extension's only UI surface. */
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
    // Stored leader tab is gone or has navigated away — clear and re-create.
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

// ---------------------------------------------------------------------------
// Extension update: reload the SW and the pinned leader tab so both pick up
// the new hosted UI. Guarded — skip the leader-tab reload if it was reloaded
// less than 60 s ago (same philosophy as the page-side preload-error guard).
// ---------------------------------------------------------------------------

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
  // Stamp the guard only after the leader tab reload succeeds so that a
  // failed reload (tab vanished) doesn't block the next attempt on Chrome's
  // onUpdateAvailable retry.
  if (await reloadLeaderTabIfExists()) await stampUpdateReloadGuard();
}

async function handleLeaderTabRemoved(tabId: number): Promise<void> {
  const storedId = await readStoredLeaderTabId();
  if (storedId !== tabId) return;
  await clearStoredLeaderTabId();
  broadcastLeaderGone();
}

/**
 * Register the leader-tab listeners and kick off boot reconciliation.
 *
 * Reconciliation touches the STORED id only (clearing it if the stored tab is
 * gone), so a stale id from a crashed/navigated leader doesn't block the
 * bridge's self-adopt of a fresh one. We deliberately DO NOT create a leader
 * tab on startup: the pinned tab is sticky and Chrome restores it on restart,
 * so creating here only races session-restore and spawns a duplicate. The
 * restored tab re-pins itself via its bridge connection (`validateBridgePin`
 * self-adopt); a missing leader is (re)created on the next action-icon click.
 * There are no `onStartup` / `onInstalled` leader-tab listeners for this reason.
 */
export function installLeaderTabListeners(): void {
  reconcileLeaderTabOnBoot().catch((err) => {
    console.error('[slicc-sw] reconcile leader tab failed', err);
  });

  chrome.runtime.onUpdateAvailable.addListener((details) => {
    console.log('[slicc-sw] Extension update available', details.version);
    // Reload the SW to apply the update, then reload the leader tab.
    // chrome.runtime.reload() terminates the current SW context, so the leader
    // tab reload runs first and the new SW picks up from its startup path.
    reloadLeaderTabForUpdate()
      .catch((err) => {
        console.error('[slicc-sw] onUpdateAvailable handler failed', err);
      })
      .finally(() => {
        // Last resort: reload the SW even if the leader tab reload failed.
        chrome.runtime.reload();
      });
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    handleLeaderTabRemoved(tabId).catch((err) => {
      console.error('[slicc-sw] handleLeaderTabRemoved failed', err);
    });
  });
}
