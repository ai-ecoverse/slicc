/**
 * Extension service worker — thin-extension bridge + bootstrapper backend.
 *
 * Responsibilities:
 * 1. Open and keep the pinned hosted leader tab alive
 * 2. Focus the leader tab on action icon click
 * 3. Proxy `chrome.debugger` CDP calls for the hosted leader tab over the
 *    `externally_connectable` Port (see `bridge-sw.ts`)
 * 4. Serve the secret-aware fetch proxy + mount sign-and-forward backends
 *    consumed by the hosted webapp
 * 5. Surface SLICC handoff notifications observed via `webRequest`
 *
 * Chrome extension API types provided by ./chrome.d.ts
 */

import {
  type DaSignAndForwardEnvelope,
  executeDaSignAndForward,
  executeS3SignAndForward,
  type FetchProxySecretSource,
  previewSecret,
  type S3SignAndForwardEnvelope,
  type SecretGetter,
  SecretsPipeline,
  SessionSecretStore,
  type SignAndForwardReply,
  SLICC_HOSTED_ORIGIN,
  unmaskCdpFrame,
} from '@slicc/shared-ts';
import type {
  CdpCommandMsg,
  CdpEventMsg,
  CdpResponseMsg,
  ExtensionMessage,
  NavigateLickMsg,
  OAuthRequestMsg,
  OAuthResultMsg,
  TraySocketCommandMessage,
  TraySocketErrorMsg,
  TraySocketMessageMsg,
  TraySocketOpenedMsg,
  TraySocketOpenMsg,
} from '../../webapp/src/kernel/messages.js';
import { LEADER_EXT_ID_QUERY_NAME } from '../../webapp/src/kernel/messages.js';
import {
  extractHandoffFromWebRequest,
  handoffFingerprint,
} from '../../webapp/src/net/handoff-link.js';
import {
  BRIDGE_ALLOWED_ORIGINS,
  BRIDGE_DEV_ORIGINS,
  buildDefaultBridgeSwDeps,
  handleBridgePortConnect,
  postLickToWelcomedLeaderPorts,
  postOpenSettingsToWelcomedLeaderPorts,
  validateBridgePin,
} from './bridge-sw.js';
import { CHERRY_PANEL_PORT_NAME } from './cherry-panel-protocol.js';
import {
  broadcastLeaderGone,
  handleCherryPanelConnect,
  setCherryPanelJoinUrl,
  setCherryPanelRecoveryDeps,
} from './cherry-panel-sw.js';
import { handleFetchProxyConnectionAsync } from './fetch-proxy-shared.js';
import { buildWebAuthFlowOptions } from './oauth-flow-options.js';
import { deleteSecret, listSecrets, listSecretsWithValues, setSecret } from './secrets-storage.js';
import { readOrCreateSwSessionId } from './sw-session-id.js';

// ---------------------------------------------------------------------------
// Leader tab state (Wave 3b — thin extension)
// ---------------------------------------------------------------------------
//
// The thin extension opens https://www.sliccy.ai/?slicc=leader in a pinned
// "home" tab that acts as the tray leader. The on-demand side panel
// (`sidepanel.html`) iframes a `?cherry=1&ui-only=1` follower that connects to
// this leader over the tray, so the agent runs even with no page open.
//
// `chrome.storage.session` persists the tab id; reconciliation runs at SW
// startup + `onStartup` + `onInstalled`; `ensureLeaderTab` creates the
// pinned tab if missing; `tabs.onRemoved` clears the storage when the
// user closes the leader tab.
//
// The bridge transport (`bridge-sw.ts`) reads `LEADER_TAB_ID_KEY` from
// `chrome.storage.session` for its three-factor pinning — keep the key
// name and shape stable.

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

async function readStoredLeaderTabId(): Promise<number | undefined> {
  try {
    const result = await chrome.storage.session.get(LEADER_TAB_ID_KEY);
    const raw = result[LEADER_TAB_ID_KEY];
    return typeof raw === 'number' ? raw : undefined;
  } catch (err) {
    console.error('[slicc-sw] storage.session.get leader tab id failed', err);
    return undefined;
  }
}

async function writeStoredLeaderTabId(tabId: number): Promise<void> {
  await chrome.storage.session.set({ [LEADER_TAB_ID_KEY]: tabId });
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
/** Create a fresh pinned leader tab and store its id. */
async function createLeaderTab(): Promise<void> {
  const created = await chrome.tabs.create({
    url: appendLeaderExtIdParam(LEADER_TAB_URL, chrome.runtime.id),
    active: false,
    pinned: true,
  });
  if (created.id !== undefined) await writeStoredLeaderTabId(created.id);
}

/** Keep the first leader tab (stamp `ext=` + pin if needed, store its id) and
 *  close every duplicate. `matches` must be non-empty. */
async function adoptSingleLeaderTab(matches: ChromeTab[]): Promise<void> {
  const [keep, ...extras] = matches;
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
  await writeStoredLeaderTabId(keep.id);
}

async function ensureLeaderTab(): Promise<void> {
  if (leaderTabLock) return leaderTabLock;
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

async function reloadLeaderTabIfExists(): Promise<boolean> {
  const id = await readStoredLeaderTabId();
  if (typeof id !== 'number') return false;
  try {
    await chrome.tabs.reload(id);
    return true;
  } catch {
    return false; // tab vanished between read and reload
  }
}

// Top-level: reconcile the STORED id only (clear it if the stored tab is gone),
// so a stale id from a crashed/navigated leader doesn't block the bridge's
// self-adopt of a fresh one. We deliberately DO NOT create a leader tab on
// startup: the pinned tab is sticky and Chrome restores it on restart, so
// creating here only races session-restore and spawns a duplicate. The restored
// tab re-pins itself via its bridge connection (`validateBridgePin` self-adopt);
// a missing leader is (re)created on the next action-icon click. There are no
// `onStartup` / `onInstalled` leader-tab listeners for this reason.
reconcileLeaderTabOnBoot().catch((err) => {
  console.error('[slicc-sw] reconcile leader tab failed', err);
});

// Native side-panel toggle — icon click opens the panel (replaces the old
// cherry-injection listener).
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('[slicc-sw] setPanelBehavior failed', err));

// Let the panel state machine recover a dead tray by reloading the leader tab,
// even when no panel is open (so a background leader isn't silently broken).
setCherryPanelRecoveryDeps({ reloadLeaderTabIfExists });

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

chrome.runtime.onUpdateAvailable.addListener((details) => {
  console.log('[slicc-sw] Extension update available', details.version);
  // Reload the SW to apply the update, then reload the leader tab.
  // chrome.runtime.reload() terminates the current SW context, so
  // the leader tab reload runs on the NEW SW's startup via the
  // reconcile path. We stamp the guard and reload the leader tab
  // first, then reload the SW.
  (async () => {
    if (!(await isWithinUpdateReloadGuard())) {
      // Stamp the guard only after the leader tab reload succeeds
      // so that a failed reload (tab vanished) doesn't block the
      // next attempt on Chrome's onUpdateAvailable retry.
      const reloaded = await reloadLeaderTabIfExists();
      if (reloaded) {
        await stampUpdateReloadGuard();
      }
    }
    chrome.runtime.reload();
  })().catch((err) => {
    console.error('[slicc-sw] onUpdateAvailable handler failed', err);
    // Last resort: reload the SW even if the leader tab reload failed.
    chrome.runtime.reload();
  });
});

async function handleLeaderTabRemoved(tabId: number): Promise<void> {
  const storedId = await readStoredLeaderTabId();
  if (storedId !== tabId) return;
  await clearStoredLeaderTabId();
  broadcastLeaderGone();
}

chrome.tabs.onRemoved.addListener((tabId) => {
  handleLeaderTabRemoved(tabId).catch((err) => {
    console.error('[slicc-sw] handleLeaderTabRemoved failed', err);
  });
});

// ---------------------------------------------------------------------------
// Action icon click — focus the pinned leader tab (the thin extension's UI).
// ---------------------------------------------------------------------------

async function focusLeaderTab(): Promise<void> {
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
// Media-capture popup window
// ---------------------------------------------------------------------------
// Media capture (`getUserMedia` / `getDisplayMedia`) needs a *visible* surface
// so Chrome can show its permission prompt / screen picker. Callers ask the
// service worker to open the capture popup here (they can't call
// `chrome.windows.create` themselves). The popup performs the capture and
// broadcasts the bytes back over `chrome.runtime` messaging, which the
// requesting context picks up directly (no SW relay needed for the result).
// See `capture-popup.html` / `capture-popup.js`.
function isCaptureOpenWindowMsg(
  msg: unknown
): msg is { type: 'capture-open-window'; url: string; requestId?: string } {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    (msg as { type?: unknown }).type === 'capture-open-window' &&
    typeof (msg as { url?: unknown }).url === 'string'
  );
}

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!isCaptureOpenWindowMsg(message)) return false;
  const requestId = message.requestId;
  chrome.windows
    .create({ url: message.url, type: 'popup', width: 360, height: 220, focused: true })
    .catch((err) => {
      console.error('[slicc-sw] Failed to open capture popup window:', err);
      // Surface the failure to the requesting context so captureViaPopup
      // rejects promptly instead of waiting out its ~5-minute timeout. The
      // success path never reaches this branch, so there is no double-send.
      if (requestId) {
        chrome.runtime
          .sendMessage({
            source: 'capture-popup',
            requestId,
            ok: false,
            error: `failed to open capture window: ${err?.message || String(err)}`,
          })
          .catch(() => {
            // Requesting context may not be listening — best effort.
          });
      }
    });
  return false;
});

// ---------------------------------------------------------------------------
// Tab grouping — inline copy for service worker (SW can't import shared chunks)
// See packages/chrome-extension/src/tab-group.ts for the canonical implementation.
// ---------------------------------------------------------------------------

let sliccGroupId: number | null = null;

async function addToSliccGroup(tabId: number): Promise<void> {
  try {
    if (sliccGroupId !== null) {
      try {
        await chrome.tabs.group({ tabIds: tabId, groupId: sliccGroupId });
        return;
      } catch (err) {
        console.info('[slicc-tab-group] Tab group removed by user, recreating', {
          tabId,
          previousGroupId: sliccGroupId,
          error: err instanceof Error ? err.message : String(err),
        });
        sliccGroupId = null;
      }
    }
    sliccGroupId = await chrome.tabs.group({ tabIds: tabId });
    await chrome.tabGroups.update(sliccGroupId, {
      title: 'slicc',
      color: 'pink',
      collapsed: false,
    });
  } catch (err) {
    console.warn('[slicc-tab-group] Tab grouping failed (best-effort, continuing without group)', {
      tabId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Handoff notifications — alert the user when a main-frame document response
// advertises a SLICC handoff via RFC 8288 `Link` header, and focus the
// hosted leader tab on notification click (user gesture required).
// ---------------------------------------------------------------------------

const handoffNotificationIds = new Set<string>();

function showHandoffNotification(): void {
  const notificationId = `slicc-handoff-${Date.now()}`;
  handoffNotificationIds.add(notificationId);
  chrome.action.setBadgeText({ text: '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#ff5f72' });
  chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: 'logos/sliccy-color-1scoops-128x128.png',
    title: 'Slicc handoff received',
    message: 'Click to open the Slicc leader tab and process the handoff.',
  });
}

chrome.notifications.onClicked.addListener((notificationId: string) => {
  if (!handoffNotificationIds.delete(notificationId)) return;
  chrome.action.setBadgeText({ text: '' });
  focusLeaderTab().catch(() => {});
});

// ---------------------------------------------------------------------------
// Handoff `Link` header observer — emits a navigate lick when a main-frame
// document response advertises a SLICC handoff rel via RFC 8288 Link.
// ---------------------------------------------------------------------------

/**
 * Payload fingerprints of handoffs whose OS notification has already been
 * shown this service-worker lifetime. A site can advertise the same SLICC
 * `Link` rel on every page response; without this guard each navigation
 * re-shows the toast.
 *
 * IMPORTANT: this set gates ONLY the notification — never the forward. The
 * forward (an `extension.lick` envelope over the welcomed leader Port(s), plus
 * the legacy `chrome.runtime.sendMessage` fallback) is best-effort and
 * silently drops when no port is welcomed yet (e.g. the leader tab still
 * booting). If we suppressed the forward on "seen", a first delivery that was
 * dropped before the leader was ready would lose the handoff permanently. So
 * we always forward and let the receiver dedup the cone turn. MV3 may evict
 * and respawn the worker, resetting this set — an accepted limitation of
 * the in-memory design (a repeat toast can appear once after eviction).
 * See {@link handoffFingerprint}.
 */
const notifiedHandoffFingerprints = new Set<string>();

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const { match } = extractHandoffFromWebRequest(details.responseHeaders, details.url);
    if (!match) return;
    const fingerprint = handoffFingerprint(match);
    const alreadyNotified = notifiedHandoffFingerprints.has(fingerprint);
    notifiedHandoffFingerprints.add(fingerprint);
    const payload: NavigateLickMsg = {
      type: 'navigate-lick',
      url: details.url,
      verb: match.verb,
      target: match.target,
      tabId: details.tabId >= 0 ? details.tabId : undefined,
    };
    if (match.instruction) payload.instruction = match.instruction;
    if (match.branch) payload.branch = match.branch;
    if (match.path) payload.path = match.path;
    const tabId = details.tabId;
    const dispatch = (title?: string) => {
      if (title) payload.title = title;
      // Primary path: push the lick over the live bridge Port(s) the welcomed
      // leader tab holds. The forward is ALWAYS attempted (never gated by the
      // notification fingerprint) so a handoff that arrived before the leader
      // was ready isn't lost; dedup of the resulting cone turn is the
      // receiver's job. The envelope is stamped per-port with that port's
      // pinned channelId inside postLickToWelcomedLeaderPorts.
      postLickToWelcomedLeaderPorts({
        kind: 'extension.lick',
        verb: payload.verb,
        target: payload.target,
        url: payload.url,
        ...(payload.instruction ? { instruction: payload.instruction } : {}),
        ...(payload.branch ? { branch: payload.branch } : {}),
        ...(payload.path ? { path: payload.path } : {}),
        ...(payload.title ? { title: payload.title } : {}),
      });
      // Legacy best-effort broadcast. Retained as a harmless fallback: in thin
      // mode the leader tab has no in-page `chrome.runtime.onMessage` listener
      // for this, so it silently drops — but keeping it costs nothing and
      // covers any legacy/detached receiver that does listen.
      chrome.runtime.sendMessage({ source: 'service-worker' as const, payload }).catch(() => {
        // Leader may not be listening yet — best effort.
      });
    };
    if (!alreadyNotified) showHandoffNotification();
    if (tabId >= 0) {
      chrome.tabs
        .get(tabId)
        .then((tab) => dispatch(tab.title))
        .catch(() => dispatch());
    } else {
      dispatch();
    }
  },
  { urls: ['<all_urls>'], types: ['main_frame'] },
  ['responseHeaders']
);

// ---------------------------------------------------------------------------
// CDP state for proxying chrome.debugger calls
// ---------------------------------------------------------------------------

/** Maps synthetic sessionId → Chrome tab ID. */
const sessionToTab = new Map<string, number>();
/** Tracks which tab IDs we've attached the debugger to. */
const attachedTabs = new Set<number>();
/** Tracks leader tray WebSockets opened on behalf of the offscreen document. */
const traySockets = new Map<number, WebSocket>();

// ---------------------------------------------------------------------------
// Message relay
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender: ChromeMessageSender, _sendResponse: (response?: unknown) => void) => {
    if (!isExtMsg(message)) return false;

    const msg = message as ExtensionMessage;

    if (msg.source === 'panel') {
      chrome.action.setBadgeText({ text: '' });
      const panelPayload = msg.payload;

      // Handle OAuth requests — service worker has chrome.identity access
      if (panelPayload.type === 'oauth-request') {
        const oauthMsg = panelPayload as OAuthRequestMsg;
        handleOAuthRequest(oauthMsg)
          .then((result) => {
            chrome.runtime
              .sendMessage({
                source: 'service-worker' as const,
                payload: result,
              })
              .catch((e) => {
                console.error('[slicc-sw] Failed to send OAuth result:', e);
              });
          })
          .catch((err) => {
            chrome.runtime
              .sendMessage({
                source: 'service-worker' as const,
                payload: {
                  type: 'oauth-result',
                  providerId: oauthMsg.providerId,
                  error: err instanceof Error ? err.message : String(err),
                } satisfies OAuthResultMsg,
              })
              .catch((e) => {
                console.error('[slicc-sw] Failed to send OAuth error:', e);
              });
          });
        return false;
      }

      // Other panel messages reach the offscreen doc directly via
      // chrome.runtime.sendMessage broadcast — no relay needed.
      return false;
    }

    if (msg.source === 'offscreen') {
      const payload = msg.payload;

      // CDP commands from offscreen need to be handled here (service worker has chrome.debugger)
      if (payload.type === 'cdp-command') {
        // Handle CDP command and send response back as a broadcast message.
        // The offscreen CDP proxy listens for cdp-response via onMessage, not sendMessage return.
        handleCdpCommand(payload as CdpCommandMsg)
          .then((response) => {
            chrome.runtime
              .sendMessage({
                source: 'service-worker' as const,
                payload: response,
              })
              .catch(() => {});
          })
          .catch((err) => {
            chrome.runtime
              .sendMessage({
                source: 'service-worker' as const,
                payload: {
                  type: 'cdp-response',
                  id: (payload as CdpCommandMsg).id,
                  error: err instanceof Error ? err.message : String(err),
                } satisfies CdpResponseMsg,
              })
              .catch(() => {});
          });
        return false;
      }

      if (isTraySocketCommand(payload)) {
        void handleTraySocketCommand(payload).catch((err) => {
          void sendServiceWorkerMessage({
            type: 'tray-socket-error',
            id: payload.id,
            error: err instanceof Error ? err.message : String(err),
          } satisfies TraySocketErrorMsg);
        });
        return false;
      }

      // Other offscreen messages reach the side panel directly via
      // chrome.runtime.sendMessage broadcast — no relay needed.
      return false;
    }

    return false;
  }
);

function isExtMsg(msg: unknown): boolean {
  return typeof msg === 'object' && msg !== null && 'source' in msg && 'payload' in msg;
}

// ---------------------------------------------------------------------------
// Mount sign-and-forward — keep credentials out of the offscreen agent.
//
// Browser-side mount backends (running in the offscreen document for the
// agent's bash tool, or the side panel for terminal-typed `mount` commands)
// post envelopes here. The service worker owns the credential channel:
//
//   - S3: reads `s3.<profile>.*` from chrome.storage.local
//   - DA: takes a transient IMS bearer in the envelope (Adobe LLM provider's
//         token, browser-side; v2 will move OAuth here)
//
// The agent's tools never reach chrome.storage (their `bash` runs in a WASM
// context with no chrome APIs; `node -e` runs in a CSP-locked sandbox iframe
// with opaque origin) so secrets stay out of the agent's reach.
//
// Promise-return + sendResponse pattern keeps client code awaitable. Returns
// `false` for unrelated messages so the existing relay listener still runs.
// ---------------------------------------------------------------------------

interface MountSignAndForwardRequest {
  type: 'mount.s3-sign-and-forward' | 'mount.da-sign-and-forward';
  envelope: unknown;
}

function isMountSignAndForwardRequest(msg: unknown): msg is MountSignAndForwardRequest {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    'envelope' in msg &&
    ((msg as { type: string }).type === 'mount.s3-sign-and-forward' ||
      (msg as { type: string }).type === 'mount.da-sign-and-forward')
  );
}

const chromeStorageSecretGetter: SecretGetter = {
  async get(key: string): Promise<string | undefined> {
    const result = await chrome.storage.local.get(key);
    const value = result[key];
    return typeof value === 'string' ? value : undefined;
  },
};

async function handleMountSignAndForward(
  msg: MountSignAndForwardRequest
): Promise<SignAndForwardReply> {
  if (msg.type === 'mount.s3-sign-and-forward') {
    return executeS3SignAndForward(
      msg.envelope as Partial<S3SignAndForwardEnvelope> | undefined,
      chromeStorageSecretGetter
    );
  }
  return executeDaSignAndForward(msg.envelope as Partial<DaSignAndForwardEnvelope> | undefined);
}

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender: ChromeMessageSender, sendResponse: (response?: unknown) => void) => {
    if (!isMountSignAndForwardRequest(message)) return false;
    // Wrap the handler call in a sync try/catch in addition to the promise
    // .catch. If the handler throws synchronously *before* returning a
    // promise (e.g. a cast on a malformed envelope that passed the type
    // guard but fails at first access), the .then().catch() chain never
    // runs and sendResponse is never called → caller hangs forever on
    // chrome.runtime.sendMessage. Belt-and-suspenders.
    const respondError = (err: unknown): void => {
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        errorCode: 'internal' as const,
      });
    };
    try {
      handleMountSignAndForward(message)
        .then((reply) => sendResponse(reply))
        .catch(respondError);
    } catch (err) {
      respondError(err);
    }
    // Keep the channel open so sendResponse can be called asynchronously.
    return true;
  }
);

function isTraySocketCommand(
  payload: ExtensionMessage['payload']
): payload is TraySocketCommandMessage {
  return (
    payload.type === 'tray-socket-open' ||
    payload.type === 'tray-socket-send' ||
    payload.type === 'tray-socket-close'
  );
}

// Note: No relay functions needed. chrome.runtime.sendMessage broadcasts to
// all extension contexts (except the sender). Panel ↔ offscreen messages
// reach each other directly. The service worker only handles CDP + tray socket proxy commands.

async function handleTraySocketCommand(command: TraySocketCommandMessage): Promise<void> {
  switch (command.type) {
    case 'tray-socket-open':
      openTraySocket(command);
      return;
    case 'tray-socket-send': {
      const socket = traySockets.get(command.id);
      if (!socket) {
        throw new Error(`Tray socket ${command.id} is not open`);
      }
      socket.send(command.data);
      return;
    }
    case 'tray-socket-close': {
      const socket = traySockets.get(command.id);
      traySockets.delete(command.id);
      socket?.close(command.code, command.reason);
      return;
    }
  }
}

function openTraySocket(command: TraySocketOpenMsg): void {
  traySockets.get(command.id)?.close(1000, 'replaced');
  const socket = new WebSocket(command.url);
  traySockets.set(command.id, socket);

  socket.addEventListener('open', () => {
    void sendServiceWorkerMessage({
      type: 'tray-socket-opened',
      id: command.id,
    } satisfies TraySocketOpenedMsg);
  });
  socket.addEventListener('message', (event) => {
    void sendServiceWorkerMessage({
      type: 'tray-socket-message',
      id: command.id,
      data: typeof event.data === 'string' ? event.data : String(event.data),
    } satisfies TraySocketMessageMsg);
  });
  socket.addEventListener('error', () => {
    if (traySockets.get(command.id) === socket) {
      traySockets.delete(command.id);
    }
    void sendServiceWorkerMessage({
      type: 'tray-socket-error',
      id: command.id,
      error: 'Tray leader WebSocket failed in extension service worker',
    } satisfies TraySocketErrorMsg);
  });
  socket.addEventListener('close', () => {
    if (traySockets.get(command.id) === socket) {
      traySockets.delete(command.id);
    }
    void sendServiceWorkerMessage({ type: 'tray-socket-closed', id: command.id });
  });
}

async function sendServiceWorkerMessage(payload: ExtensionMessage['payload']): Promise<void> {
  await chrome.runtime.sendMessage({
    source: 'service-worker' as const,
    payload,
  });
}

// ---------------------------------------------------------------------------
// CDP proxy — translate offscreen CDP commands to chrome.debugger calls
// ---------------------------------------------------------------------------

async function handleCdpCommand(cmd: CdpCommandMsg): Promise<CdpResponseMsg> {
  const { id, method, params, sessionId } = cmd;

  try {
    let result: Record<string, unknown>;

    switch (method) {
      case 'Target.getTargets':
        result = await cdpGetTargets();
        break;
      case 'Target.attachToTarget':
        result = await cdpAttachToTarget(params!);
        break;
      case 'Target.detachFromTarget':
        result = await cdpDetachFromTarget(params!);
        break;
      case 'Target.createTarget':
        result = await cdpCreateTarget(params!);
        break;
      case 'Target.closeTarget':
        result = await cdpCloseTarget(params!);
        break;
      default:
        result = await cdpSendCommand(method, params, sessionId);
        break;
    }

    return { type: 'cdp-response', id, result };
  } catch (err) {
    return {
      type: 'cdp-response',
      id,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function cdpGetTargets(): Promise<Record<string, unknown>> {
  const [tabs, activeTabs] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);
  const activeTabIds = new Set(activeTabs.map((t) => t.id));
  // Skip tabs without a numeric id (devtools, anonymous pages). They
  // can't be CDP-attached targets — without this filter, String(undefined)
  // would surface "undefined" as a targetId and tab.id! would crash.
  const targetInfos = tabs
    .filter((tab): tab is typeof tab & { id: number } => typeof tab.id === 'number')
    .map((tab) => ({
      targetId: String(tab.id),
      type: 'page',
      title: tab.title ?? '',
      url: tab.url ?? '',
      attached: attachedTabs.has(tab.id),
      active: activeTabIds.has(tab.id),
    }));
  return { targetInfos };
}

async function cdpAttachToTarget(
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const targetId = params['targetId'] as string;
  const tabId = parseInt(targetId, 10);
  if (!Number.isFinite(tabId) || tabId <= 0) {
    throw new Error(`Invalid targetId: ${targetId}`);
  }

  if (!attachedTabs.has(tabId)) {
    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTabs.add(tabId);
  }

  const sessionId = targetId;
  sessionToTab.set(sessionId, tabId);
  return { sessionId };
}

async function cdpDetachFromTarget(
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const sessionId = params['sessionId'] as string;
  const tabId = sessionToTab.get(sessionId);

  if (tabId !== undefined) {
    sessionToTab.delete(sessionId);
    const stillReferenced = [...sessionToTab.values()].includes(tabId);
    if (!stillReferenced) {
      attachedTabs.delete(tabId);
      await chrome.debugger.detach({ tabId }).catch(() => {
        // Tab may already be closed
      });
    }
  }

  return {};
}

async function cdpCreateTarget(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = (params['url'] as string) ?? 'about:blank';
  const tab = await chrome.tabs.create({ url, active: false });
  await addToSliccGroup(tab.id);
  return { targetId: String(tab.id) };
}

async function cdpCloseTarget(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const targetId = params['targetId'] as string;
  const tabId = parseInt(targetId, 10);
  if (!Number.isFinite(tabId) || tabId <= 0) {
    throw new Error(`Invalid targetId: ${targetId}`);
  }

  // Clean up session/attach state for this tab
  for (const [sid, tid] of sessionToTab) {
    if (tid === tabId) sessionToTab.delete(sid);
  }
  if (attachedTabs.has(tabId)) {
    attachedTabs.delete(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {
      // Tab may already be closed
    });
  }

  await chrome.tabs.remove(tabId);
  return { success: true };
}

/**
 * CDP methods that carry whole-token secret fields on outgoing frames
 * (Wave A D1). Anything else is forwarded verbatim to chrome.debugger.
 * Kept in sync with `unmaskCdpFrame` in `@slicc/shared-ts`.
 */
const CDP_UNMASK_METHODS = new Set<string>([
  'Runtime.evaluate',
  'Runtime.callFunctionOn',
  'Input.insertText',
]);

/**
 * Resolve the target tab's CURRENT URL hostname and unmask whole-token
 * secret fields against it. Fail-closed: any failure to resolve the URL
 * (tab gone, missing url, unparseable) leaves the frame untouched.
 */
async function maybeUnmaskCdpFrame(
  tabId: number,
  method: string,
  params: Record<string, unknown> | undefined
): Promise<Record<string, unknown> | undefined> {
  if (!CDP_UNMASK_METHODS.has(method)) return params;
  if (!params || typeof params !== 'object') return params;

  let hostname: string | null = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab?.url;
    if (typeof url === 'string' && url.length > 0) {
      try {
        hostname = new URL(url).hostname || null;
      } catch {
        hostname = null;
      }
    }
  } catch {
    hostname = null;
  }
  if (!hostname) return params;

  const pipeline = await buildSecretsPipeline();
  await pipeline.reload();
  if (!pipeline.hasSecrets()) return params;

  const { frame, changed } = unmaskCdpFrame({ method, params }, hostname, pipeline);
  if (!changed) return params;
  const nextParams = (frame as { params?: Record<string, unknown> }).params;
  return nextParams ?? params;
}

async function cdpSendCommand(
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string
): Promise<Record<string, unknown>> {
  const tabId = sessionId ? sessionToTab.get(sessionId) : undefined;
  if (tabId === undefined) {
    throw new Error(
      `No tab attached for sessionId: ${sessionId ?? '(none)'}. Attach to a target first.`
    );
  }

  const effectiveParams = await maybeUnmaskCdpFrame(tabId, method, params);
  const result = await chrome.debugger.sendCommand({ tabId }, method, effectiveParams);
  return result ?? {};
}

// ---------------------------------------------------------------------------
// Forward chrome.debugger events to offscreen as cdp-event messages
// ---------------------------------------------------------------------------

chrome.debugger.onEvent.addListener(
  (source: { tabId: number }, method: string, params?: Record<string, unknown>) => {
    if (!attachedTabs.has(source.tabId)) return;

    // Find sessionId for this tabId
    let sessionId: string | undefined;
    for (const [sid, tabId] of sessionToTab) {
      if (tabId === source.tabId) {
        sessionId = sid;
        break;
      }
    }

    const cdpEvent: CdpEventMsg = {
      type: 'cdp-event',
      method,
      params: sessionId ? { ...params, sessionId } : (params ?? {}),
    };

    // Send to offscreen document
    chrome.runtime
      .sendMessage({
        source: 'service-worker' as const,
        payload: cdpEvent,
      })
      .catch(() => {
        // Offscreen may not be listening
      });
  }
);

// ---------------------------------------------------------------------------
// OAuth handler — generic chrome.identity.launchWebAuthFlow for any OAuth provider
// ---------------------------------------------------------------------------

async function handleOAuthRequest(msg: OAuthRequestMsg): Promise<OAuthResultMsg> {
  const redirectUrl = await chrome.identity.launchWebAuthFlow(
    buildWebAuthFlowOptions(msg.authorizeUrl, msg.interactive ?? true)
  );

  if (!redirectUrl) {
    return {
      type: 'oauth-result',
      providerId: msg.providerId,
      error: 'OAuth flow was cancelled or returned no URL',
    };
  }

  const parsed = new URL(redirectUrl);
  const params = parsed.searchParams;
  const hashParams = new URLSearchParams(parsed.hash.slice(1));
  const error = params.get('error') || hashParams.get('error');
  if (error) {
    return {
      type: 'oauth-result',
      providerId: msg.providerId,
      error: params.get('error_description') || hashParams.get('error_description') || error,
    };
  }

  return {
    type: 'oauth-result',
    providerId: msg.providerId,
    code: params.get('code') ?? undefined,
    state: params.get('state') ?? undefined,
    redirectUrl,
  };
}

chrome.debugger.onDetach.addListener((source: { tabId: number }, _reason: string) => {
  attachedTabs.delete(source.tabId);
  for (const [sessionId, tabId] of sessionToTab) {
    if (tabId === source.tabId) {
      sessionToTab.delete(sessionId);
    }
  }
});

// ---------------------------------------------------------------------------
// Secrets-aware fetch-proxy connection handler
// ---------------------------------------------------------------------------

// Session-only secrets: in-memory, never written to chrome.storage. Lives for
// the service worker's lifetime (MV3 may evict it — that matches the
// "vanish on session end" semantics). Layered into every pipeline build so the
// fetch proxy unmasks session secrets like persisted ones.
const sessionSecretStore = new SessionSecretStore();

async function buildSecretsPipeline(): Promise<SecretsPipeline> {
  const sessionId = await readOrCreateSwSessionId();
  const source: FetchProxySecretSource = {
    get: async (name) => {
      const fromSession = sessionSecretStore.get(name);
      if (fromSession !== undefined) return fromSession;
      const got = (await chrome.storage.local.get(name)) as Record<string, string | undefined>;
      return got[name];
    },
    listAll: () => listSecretsWithValues(chrome.storage.local as any),
  };
  return new SecretsPipeline({ sessionId, source, sessionStore: sessionSecretStore });
}

// ---------------------------------------------------------------------------
// Wave 3b: full CDP pass-through bridge for the sliccy.ai leader tab.
//
// The leader opens a long-lived Port via `chrome.runtime.connect(EXT_ID,
// { name: 'slicc.cdp-bridge' })`, gated here by externally_connectable + the
// three-factor pin enforced inside `handleBridgePortConnect` (origin
// allowlist + sender.tab.id === storedLeaderTabId + sender.frameId === 0).
// `slicc_leader_tab_id` is owned by the sibling leader-tab task; absent →
// pin fails closed. The deps here delegate attach/detach to the existing
// `attachedTabs` accounting so the bridge and the offscreen CDP proxy never
// trample each other, and route outbound commands through `maybeUnmaskCdpFrame`
// so raw CDP secrets MUST NEVER reach the leader tab.
// ---------------------------------------------------------------------------

const bridgeSwDeps = buildDefaultBridgeSwDeps({
  attachDebugger: async (tabId) => {
    if (!attachedTabs.has(tabId)) {
      await chrome.debugger.attach({ tabId }, '1.3');
      attachedTabs.add(tabId);
    }
  },
  detachDebugger: async (tabId) => {
    if (!attachedTabs.has(tabId)) return;
    attachedTabs.delete(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {
      /* tab may already be closed */
    });
  },
  sendDebuggerCommand: async (tabId, method, params) => {
    const result = await chrome.debugger.sendCommand({ tabId }, method, params);
    return result ?? {};
  },
  maybeUnmaskCdpFrame,
  allowedOrigins: __SLICC_EXT_DEV__
    ? [...BRIDGE_ALLOWED_ORIGINS, ...BRIDGE_DEV_ORIGINS]
    : BRIDGE_ALLOWED_ORIGINS,
  onLeaderJoinUrl: (joinUrl) => {
    setCherryPanelJoinUrl(joinUrl);
  },
});

/**
 * Build + reload the secrets pipeline for a fetch-proxy Port. Shared by the
 * own-origin `onConnect` path and the external (leader-tab) `onConnectExternal`
 * path so both produce the SAME masked values. The returned promise is handed
 * to `handleFetchProxyConnectionAsync`, which attaches the Port `onMessage`
 * listener SYNCHRONOUSLY and awaits this promise INSIDE the handler — Chrome
 * drops Port messages that arrive before any listener exists, and the page
 * posts its `request` immediately after connect (before the async build).
 */
function buildReloadedPipelinePromise(): Promise<SecretsPipeline> {
  return buildSecretsPipeline().then(async (p) => {
    await p.reload();
    return p;
  });
}

chrome.runtime.onConnectExternal.addListener((port: ChromeRuntimePort) => {
  // The hosted leader tab uses TWO externally-connectable Port names: the CDP
  // bridge and (in extension-delegate mode) the secret-aware fetch proxy. The
  // fetch-proxy branch is gated by the SAME three-factor pin as the bridge so
  // a non-leader allowlisted origin can't reach the proxy.
  if (port.name === 'fetch-proxy.fetch') {
    // Fold the pin check into the pipeline promise so the listener still
    // attaches synchronously (no microtask gap before the page's `request`).
    // A pin failure rejects the promise → the handler posts response-error.
    const pipelinePromise = (async () => {
      const pin = await validateBridgePin(port.sender, {
        readStoredLeaderTabId: bridgeSwDeps.readStoredLeaderTabId,
        writeStoredLeaderTabId: bridgeSwDeps.writeStoredLeaderTabId,
        allowedOrigins: bridgeSwDeps.allowedOrigins,
      });
      if (!pin.ok) throw new Error(`fetch-proxy pin failed: ${pin.reason ?? 'pin-failed'}`);
      return buildReloadedPipelinePromise();
    })();
    pipelinePromise.catch((err) => {
      console.error('[sw] external fetch-proxy init failed', err);
    });
    handleFetchProxyConnectionAsync(port as any, pipelinePromise);
    return;
  }
  if (port.name === 'secrets.crud') {
    // The hosted leader tab proxies secrets CRUD through this Port because
    // pages other than the extension's own origin can't reach chrome.storage.
    // Gated by the SAME three-factor pin as the bridge + fetch proxy. The
    // listener attaches SYNCHRONOUSLY and awaits the pin INSIDE the handler —
    // Chrome drops Port messages that arrive before any listener exists, and
    // the leader may post its first request immediately after connect (before
    // the async pin read completes). Mirrors the fetch-proxy branch above.
    const pinPromise = validateBridgePin(port.sender, {
      readStoredLeaderTabId: bridgeSwDeps.readStoredLeaderTabId,
      writeStoredLeaderTabId: bridgeSwDeps.writeStoredLeaderTabId,
      allowedOrigins: bridgeSwDeps.allowedOrigins,
    });
    pinPromise.catch((err) => {
      console.error('[sw] external secrets.crud pin check failed', err);
    });
    port.onMessage.addListener(async (raw) => {
      const id = (raw as { id?: unknown } | null)?.id;
      const reply = (response: unknown): void => port.postMessage({ id, response });
      let pin: { ok: boolean; reason?: string };
      try {
        pin = await pinPromise;
      } catch (err) {
        reply({
          error: `secrets.crud pin failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
      if (!pin.ok) {
        reply({ error: `secrets.crud pin failed: ${pin.reason ?? 'pin-failed'}` });
        return;
      }
      const type = getMsgType(raw);
      const handler = type === undefined ? undefined : SECRETS_HANDLERS[type];
      if (!handler) {
        reply({ error: `unknown secrets type: ${type ?? 'undefined'}` });
        return;
      }
      handler(raw, reply);
    });
    return;
  }
  if (port.name === 'mount.sign-and-forward') {
    // The hosted leader tab proxies S3 / DA mount sign-and-forward through this
    // Port: chrome.storage (S3 creds) is unreachable from a non-extension
    // origin, and DA envelopes carry a transient IMS bearer the SW forwards
    // server-side. Gated by the SAME three-factor pin as the bridge + fetch
    // proxy + secrets.crud. Listener attaches SYNCHRONOUSLY and awaits the pin
    // INSIDE the handler. Mirrors the secrets.crud branch above (EXT8).
    const pinPromise = validateBridgePin(port.sender, {
      readStoredLeaderTabId: bridgeSwDeps.readStoredLeaderTabId,
      writeStoredLeaderTabId: bridgeSwDeps.writeStoredLeaderTabId,
      allowedOrigins: bridgeSwDeps.allowedOrigins,
    });
    pinPromise.catch((err) => {
      console.error('[sw] external mount.sign-and-forward pin check failed', err);
    });
    port.onMessage.addListener(async (raw) => {
      const id = (raw as { id?: unknown } | null)?.id;
      const reply = (response: unknown): void => port.postMessage({ id, response });
      const replyError = (message: string): void =>
        reply({ ok: false, error: message, errorCode: 'internal' });
      let pin: { ok: boolean; reason?: string };
      try {
        pin = await pinPromise;
      } catch (err) {
        replyError(
          `mount.sign-and-forward pin failed: ${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }
      if (!pin.ok) {
        replyError(`mount.sign-and-forward pin failed: ${pin.reason ?? 'pin-failed'}`);
        return;
      }
      if (!isMountSignAndForwardRequest(raw)) {
        replyError('invalid mount.sign-and-forward request');
        return;
      }
      try {
        reply(await handleMountSignAndForward(raw));
      } catch (err) {
        replyError(err instanceof Error ? err.message : String(err));
      }
    });
    return;
  }
  handleBridgePortConnect(port, bridgeSwDeps).catch((err) => {
    console.error('[slicc-sw] CDP bridge connect failed', err);
  });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === CHERRY_PANEL_PORT_NAME) {
    // Opening the cockpit means the user is attending SLICC — clear any pending
    // handoff badge. The old `chrome.action.onClicked` handler cleared it, but
    // `openPanelOnActionClick` consumes the icon click so `onClicked` no longer
    // fires; the panel-connect is now the "user is here" signal.
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
    handleCherryPanelConnect(port, {
      ensureLeaderTab,
      reloadLeaderTabIfExists,
      focusLeaderTab,
      openSettingsOnLeader: () => {
        postOpenSettingsToWelcomedLeaderPorts();
      },
    }).catch((err) => console.error('[slicc-sw] handleCherryPanelConnect failed', err));
    return;
  }
  if (port.name !== 'fetch-proxy.fetch') return;
  const pipelinePromise = buildReloadedPipelinePromise();
  pipelinePromise.catch((err) => {
    console.error('[sw] fetch-proxy init failed', err);
    // The handler's await pipelinePromise will throw and post response-error,
    // so we just log here. Don't disconnect — the handler needs the port.
  });
  handleFetchProxyConnectionAsync(port as any, pipelinePromise);
});

// ---------------------------------------------------------------------------
// Secrets message handlers
// ---------------------------------------------------------------------------

type SendResponse = (response?: unknown) => void;
type SecretsHandler = (msg: unknown, sendResponse: SendResponse) => boolean;

function getMsgType(msg: unknown): string | undefined {
  if (typeof msg !== 'object' || msg === null || !('type' in msg)) return undefined;
  const t = (msg as { type: unknown }).type;
  return typeof t === 'string' ? t : undefined;
}

function getStringField(msg: unknown, field: string): string | undefined {
  if (typeof msg !== 'object' || msg === null || !(field in msg)) return undefined;
  const v = (msg as Record<string, unknown>)[field];
  return typeof v === 'string' ? v : undefined;
}

function getStringArrayField(msg: unknown, field: string): string[] | undefined {
  if (typeof msg !== 'object' || msg === null || !(field in msg)) return undefined;
  const v = (msg as Record<string, unknown>)[field];
  if (!Array.isArray(v)) return undefined;
  return v.filter((d): d is string => typeof d === 'string');
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function runSecretsListMaskedEntries(_msg: unknown, sendResponse: SendResponse): boolean {
  (async () => {
    try {
      const pipeline = await buildSecretsPipeline();
      await pipeline.reload();
      sendResponse({ entries: pipeline.getMaskedEntries() });
    } catch (err) {
      // Without this catch, the unhandled rejection closes the
      // message port and the caller resolves with `undefined` —
      // indistinguishable from "no entries", which silently
      // populates the agent shell with an empty env.
      console.error('[sw] secrets.list-masked-entries failed', err);
      sendResponse({ entries: [], error: errMsg(err) });
    }
  })();
  return true;
}
// Tool-output real→masked scrub. The offscreen agent realm holds
// only masked entries (no real values), so the scrub runs here
// against the SW-owned `SecretsPipeline`. Direction is real→masked
// ONLY; idempotent for already-masked tokens and secret-free
// output. Errors degrade to the input text so a transient SW issue
// never blocks a tool result from reaching the agent loop.
function runSecretsScrubToolResult(msg: unknown, sendResponse: SendResponse): boolean {
  const text = getStringField(msg, 'text');
  if (text === undefined) return false;
  (async () => {
    try {
      const pipeline = await buildSecretsPipeline();
      await pipeline.reload();
      sendResponse({ text: pipeline.scrubResponse(text) });
    } catch (err) {
      console.error('[sw] secrets.scrub-tool-result failed', err);
      sendResponse({ text, error: errMsg(err) });
    }
  })();
  return true;
}

// Offscreen-only: snapshot the secrets needed to seed the outbound-scrub
// pipeline (defense-in-depth real → masked scrub on the LLM-wire `fetch`
// leg). The offscreen has no `chrome.storage`, so it RPCs here for the
// sessionId + merged {persisted, session} entry list. Mirrors
// `buildSecretsPipeline()` above so the offscreen's pipeline produces the
// same masked values as the SW fetch-proxy pipeline.
function runSecretsListWithValuesForPipeline(_msg: unknown, sendResponse: SendResponse): boolean {
  (async () => {
    try {
      const sessionId = await readOrCreateSwSessionId();
      const persisted = await listSecretsWithValues(chrome.storage.local as any);
      const persistedNames = new Set(persisted.map((e) => e.name));
      const session = sessionSecretStore.listAll().filter((s) => !persistedNames.has(s.name));
      const entries = [...persisted, ...session];
      sendResponse({ sessionId, entries });
    } catch (err) {
      console.error('[sw] secrets.list-with-values-for-pipeline failed', err);
      sendResponse({ sessionId: undefined, entries: [], error: errMsg(err) });
    }
  })();
  return true;
}

// The panel-terminal `secret` command can't touch chrome.storage directly:
// it runs in the offscreen document, which lacks chrome.storage even when
// the manifest grants it (MV3 quirk). Route the management ops through
// the SW, which DOES have chrome.storage.
function runSecretsList(_msg: unknown, sendResponse: SendResponse): boolean {
  (async () => {
    try {
      const entries = await listSecrets(chrome.storage.local as any);
      sendResponse({ entries });
    } catch (err) {
      console.error('[sw] secrets.list failed', err);
      sendResponse({ entries: [], error: errMsg(err) });
    }
  })();
  return true;
}

function runSecretsSet(msg: unknown, sendResponse: SendResponse): boolean {
  const name = getStringField(msg, 'name');
  const value = getStringField(msg, 'value');
  const domains = getStringArrayField(msg, 'domains');
  if (name === undefined || value === undefined || domains === undefined) return false;
  (async () => {
    try {
      await setSecret(chrome.storage.local as any, name, value, domains);
      sendResponse({ ok: true });
    } catch (err) {
      console.error('[sw] secrets.set failed', err);
      sendResponse({ ok: false, error: errMsg(err) });
    }
  })();
  return true;
}

function runSecretsDelete(msg: unknown, sendResponse: SendResponse): boolean {
  const name = getStringField(msg, 'name');
  if (name === undefined) return false;
  (async () => {
    try {
      // Session secrets win over persisted on name collision (mirrors the
      // node-server endpoint), so they are also checked first on delete.
      if (sessionSecretStore.has(name)) {
        sessionSecretStore.delete(name);
        sendResponse({ ok: true, removed: true, fromSession: true });
        return;
      }
      const existing = await listSecrets(chrome.storage.local as any);
      if (!existing.some((e) => e.name === name)) {
        sendResponse({ ok: true, removed: false });
        return;
      }
      await deleteSecret(chrome.storage.local as any, name);
      sendResponse({ ok: true, removed: true, fromSession: false });
    } catch (err) {
      console.error('[sw] secrets.delete failed', err);
      sendResponse({ ok: false, error: errMsg(err) });
    }
  })();
  return true;
}

// Session-secret set — in-memory only, never written to chrome.storage.
function runSecretsSessionSet(msg: unknown, sendResponse: SendResponse): boolean {
  const name = getStringField(msg, 'name');
  const value = getStringField(msg, 'value');
  const domains = getStringArrayField(msg, 'domains');
  if (name === undefined || value === undefined || domains === undefined) return false;
  sessionSecretStore.set(name, value, domains);
  sendResponse({ ok: true });
  return true;
}

function runSecretsSessionList(_msg: unknown, sendResponse: SendResponse): boolean {
  sendResponse({ entries: sessionSecretStore.list() });
  return true;
}

// Peek — returns an elided preview of the unmasked value (session or
// persisted). The full value never leaves the SW.
function runSecretsPeek(msg: unknown, sendResponse: SendResponse): boolean {
  const name = getStringField(msg, 'name');
  if (name === undefined) return false;
  (async () => {
    try {
      const sessionRec = sessionSecretStore.getRecord(name);
      if (sessionRec) {
        sendResponse({
          record: {
            name,
            preview: previewSecret(sessionRec.value),
            domains: sessionRec.domains,
          },
        });
        return;
      }
      const all = await listSecretsWithValues(chrome.storage.local as any);
      const found = all.find((e) => e.name === name);
      sendResponse({
        record: found
          ? { name, preview: previewSecret(found.value), domains: found.domains }
          : undefined,
      });
    } catch (err) {
      console.error('[sw] secrets.peek failed', err);
      sendResponse({ record: undefined, error: errMsg(err) });
    }
  })();
  return true;
}

// Scope edit — update the allowed domains of an existing secret (session or
// persisted), preserving the value.
function runSecretsSetDomains(msg: unknown, sendResponse: SendResponse): boolean {
  const name = getStringField(msg, 'name');
  const domains = getStringArrayField(msg, 'domains');
  if (name === undefined || domains === undefined) return false;
  (async () => {
    try {
      if (sessionSecretStore.has(name)) {
        sessionSecretStore.setDomains(name, domains);
        sendResponse({ ok: true });
        return;
      }
      const all = await listSecretsWithValues(chrome.storage.local as any);
      const found = all.find((e) => e.name === name);
      if (!found) {
        sendResponse({ ok: false, error: `no secret named "${name}"` });
        return;
      }
      await setSecret(chrome.storage.local as any, name, found.value, domains);
      sendResponse({ ok: true });
    } catch (err) {
      console.error('[sw] secrets.set-domains failed', err);
      sendResponse({ ok: false, error: errMsg(err) });
    }
  })();
  return true;
}

async function runMaskOauthTokenWrite(
  providerId: string,
  accessToken: string | undefined,
  domains: string | undefined
): Promise<string | undefined> {
  // #847: the caller may be the offscreen document, which has
  // `chrome.runtime` but NOT `chrome.storage` (MV3 quirk — same reason
  // `secrets.set` proxies through the SW). Write the secret here, where
  // the SW owns `chrome.storage`, before building the pipeline that
  // masks it. `domains` is the comma-joined `_DOMAINS` companion.
  if (accessToken && domains) {
    await chrome.storage.local.set({
      [`oauth.${providerId}.token`]: accessToken,
      [`oauth.${providerId}.token_DOMAINS`]: domains,
    });
  }
  const pipeline = await buildSecretsPipeline();
  await pipeline.reload();
  const name = `oauth.${providerId}.token`;
  return pipeline.getMaskedEntries().find((e) => e.name === name)?.maskedValue;
}

function runSecretsMaskOauthToken(msg: unknown, sendResponse: SendResponse): boolean {
  const providerId = getStringField(msg, 'providerId');
  if (providerId === undefined) return false;
  const accessToken = getStringField(msg, 'accessToken');
  const domains = getStringField(msg, 'domains');
  (async () => {
    try {
      const maskedValue = await runMaskOauthTokenWrite(providerId, accessToken, domains);
      // We just wrote the secret above, so a missing entry here is NOT a
      // cold-start miss — it's a real fault (write didn't land, or the
      // pipeline stopped emitting it). Surface it so the page side can
      // distinguish "not warm yet" from "wrote it and still missing".
      if (accessToken && domains && maskedValue === undefined) {
        const name = `oauth.${providerId}.token`;
        // Real fault (not a cold miss): surface a reason so the page can
        // distinguish it and the give-up log isn't reason-less (#847).
        console.warn('[sw] secrets.mask-oauth-token: entry missing after write', { name });
        sendResponse({ maskedValue: undefined, error: 'entry missing after write' });
        return;
      }
      sendResponse({ maskedValue });
    } catch (err) {
      console.error('[sw] secrets.mask-oauth-token failed', err);
      sendResponse({ maskedValue: undefined, error: errMsg(err) });
    }
  })();
  return true;
}

const SECRETS_HANDLERS: Record<string, SecretsHandler> = {
  'secrets.list-masked-entries': runSecretsListMaskedEntries,
  'secrets.scrub-tool-result': runSecretsScrubToolResult,
  'secrets.list-with-values-for-pipeline': runSecretsListWithValuesForPipeline,
  'secrets.list': runSecretsList,
  'secrets.set': runSecretsSet,
  'secrets.delete': runSecretsDelete,
  'secrets.session.set': runSecretsSessionSet,
  'secrets.session.list': runSecretsSessionList,
  'secrets.peek': runSecretsPeek,
  'secrets.set-domains': runSecretsSetDomains,
  'secrets.mask-oauth-token': runSecretsMaskOauthToken,
};

chrome.runtime.onMessage.addListener(
  (msg: unknown, _sender: ChromeMessageSender, sendResponse: (response?: unknown) => void) => {
    const type = getMsgType(msg);
    if (type === undefined) return false;
    const handler = SECRETS_HANDLERS[type];
    return handler ? handler(msg, sendResponse) : false;
  }
);
