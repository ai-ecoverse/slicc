/**
 * Extension service worker — thin MV3 entry point.
 *
 * This file OWNS NO BACKEND LOGIC. It registers listeners and wires the
 * focused SW modules together, each of which keeps its own state and exposes an
 * `install*` / `handle*` entry point:
 *
 * | Module                       | Concern                                     |
 * | ---------------------------- | ------------------------------------------- |
 * | `leader-tab-sw.ts`           | pinned leader tab lifecycle + update reload |
 * | `handoff-notifications-sw.ts`| handoff `Link` observer + OS toasts         |
 * | `discovery-sw.ts`            | agentic-resource discovery observer         |
 * | `cdp-proxy-sw.ts`            | `chrome.debugger` translation + attachments |
 * | `bridge-sw.ts`               | leader-tab CDP pass-through Port            |
 * | `cherry-panel-sw.ts`         | side-panel tri-state Port hub               |
 * | `secrets-sw.ts`              | secrets pipeline + `secrets.*` handlers      |
 * | `mount-backends-sw.ts`       | S3 / DA sign-and-forward                    |
 * | `relay-sw.ts`                | panel/offscreen relay (OAuth, CDP, tray)    |
 * | `tray-socket-sw.ts`          | leader tray WebSocket relay                 |
 * | `capture-popup-sw.ts`        | media-capture popup window                  |
 *
 * Chrome extension API types provided by ./chrome.d.ts
 */

import {
  BRIDGE_ALLOWED_ORIGINS,
  BRIDGE_DEV_ORIGINS,
  buildDefaultBridgeSwDeps,
  handleBridgePortConnect,
  postOpenSettingsToWelcomedLeaderPorts,
} from './bridge-sw.js';
import { handleCapturePopupMessage } from './capture-popup-sw.js';
import {
  acquireDebuggerAttachment,
  installCdpProxyListeners,
  maybeUnmaskCdpFrame,
  releaseDebuggerAttachment,
} from './cdp-proxy-sw.js';
import { CHERRY_PANEL_PORT_NAME } from './cherry-panel-protocol.js';
import {
  handleCherryPanelConnect,
  setCherryPanelJoinUrl,
  setCherryPanelRecoveryDeps,
} from './cherry-panel-sw.js';
import { installDiscoveryObserver } from './discovery-sw.js';
import { handleFetchProxyConnectionAsync, type PortLike } from './fetch-proxy-shared.js';
import { installHandoffNotifications } from './handoff-notifications-sw.js';
import {
  ensureLeaderTab,
  focusLeaderTab,
  installLeaderTabListeners,
  readStoredLeaderTabId,
  reloadLeaderTabIfExists,
  writeStoredLeaderTabId,
} from './leader-tab-sw.js';
import { handleMountMessage, handleMountSignAndForwardPort } from './mount-backends-sw.js';
import { handleRelayMessage } from './relay-sw.js';
import {
  buildReloadedPipelinePromise,
  handleSecretsCrudPort,
  handleSecretsMessage,
} from './secrets-sw.js';
import { routeSwMessage, type SwMessageHandler } from './sw-message-router.js';
import { beginPortPin, type PortPinDeps } from './sw-pinned-port.js';

const BRIDGE_ORIGINS = __SLICC_EXT_DEV__
  ? [...BRIDGE_ALLOWED_ORIGINS, ...BRIDGE_DEV_ORIGINS]
  : BRIDGE_ALLOWED_ORIGINS;

// ---------------------------------------------------------------------------
// Wave 3b: full CDP pass-through bridge for the sliccy.ai leader tab.
//
// The leader opens a long-lived Port via `chrome.runtime.connect(EXT_ID,
// { name: 'slicc.cdp-bridge' })`, gated by externally_connectable + the
// three-factor pin enforced inside `handleBridgePortConnect` (origin
// allowlist + sender.tab.id === storedLeaderTabId + sender.frameId === 0).
// `slicc_leader_tab_id` is owned by `leader-tab-sw.ts`; absent → the pin fails
// closed. The deps here report whether the bridge actually performed an attach,
// so it never claims or detaches a session already tracked by the legacy
// offscreen compatibility path. Outbound commands route through
// `maybeUnmaskCdpFrame` so raw CDP secrets MUST NEVER reach the leader tab.
// ---------------------------------------------------------------------------

/**
 * `buildDefaultBridgeSwDeps` writes only the session key; route self-adopt
 * through `writeStoredLeaderTabId` so a Chrome-restored leader also regains its
 * discard/freeze exemption (autoDiscardable resets on browser restart).
 * Best-effort like the default: a storage failure must not fail the pin.
 */
const selfAdoptLeaderTabId = async (tabId: number): Promise<void> => {
  try {
    await writeStoredLeaderTabId(tabId);
  } catch {
    /* storage unavailable; self-adopt is best-effort */
  }
};

const bridgeSwDeps = buildDefaultBridgeSwDeps({
  writeStoredLeaderTabId: selfAdoptLeaderTabId,
  attachDebugger: (tabId) => acquireDebuggerAttachment(tabId, 'bridge'),
  detachDebugger: (tabId) => releaseDebuggerAttachment(tabId, 'bridge'),
  sendDebuggerCommand: async (tabId, method, params) => {
    const result = await chrome.debugger.sendCommand({ tabId }, method, params);
    return result ?? {};
  },
  maybeUnmaskCdpFrame,
  allowedOrigins: BRIDGE_ORIGINS,
  onLeaderJoinUrl: (joinUrl) => {
    setCherryPanelJoinUrl(joinUrl);
  },
});

/** The pin deps every externally-connectable Port shares with the bridge. */
const portPinDeps: PortPinDeps = {
  readStoredLeaderTabId,
  writeStoredLeaderTabId: selfAdoptLeaderTabId,
  allowedOrigins: BRIDGE_ORIGINS,
};

// ---------------------------------------------------------------------------
// Listener registration
// ---------------------------------------------------------------------------

installLeaderTabListeners();

// Native side-panel toggle — icon click opens the panel.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('[slicc-sw] setPanelBehavior failed', err));

// Let the panel state machine recover a dead tray by reloading the leader tab,
// even when no panel is open (so a background leader isn't silently broken).
setCherryPanelRecoveryDeps({ reloadLeaderTabIfExists });

// The handoff observer must be installed BEFORE the discovery observer: Chrome
// fans `onHeadersReceived` out to every listener in registration order, and the
// handoff notification/forward path is the one that must stay first.
installHandoffNotifications();
installDiscoveryObserver();

installCdpProxyListeners();

// ONE `chrome.runtime.onMessage` listener. The SW used to register three
// independent listeners racing on the same channel; the router walks the
// backends in the original registration order and owns the `return true`
// reply-channel contract in a single place.
const SW_MESSAGE_HANDLERS: readonly SwMessageHandler[] = [
  handleCapturePopupMessage,
  handleRelayMessage,
  handleMountMessage,
  handleSecretsMessage,
];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) =>
  routeSwMessage(SW_MESSAGE_HANDLERS, message, sender, sendResponse)
);

chrome.runtime.onConnectExternal.addListener((port: ChromeRuntimePort) => {
  // The hosted leader tab uses four externally-connectable Port names. Every
  // non-bridge one is gated by the SAME three-factor pin as the bridge, so an
  // allowlisted origin that is not the leader tab can't reach any of them.
  if (port.name === 'fetch-proxy.fetch') {
    connectExternalFetchProxy(port);
    return;
  }
  if (port.name === 'secrets.crud') {
    handleSecretsCrudPort(port, portPinDeps);
    return;
  }
  if (port.name === 'mount.sign-and-forward') {
    handleMountSignAndForwardPort(port, portPinDeps);
    return;
  }
  handleBridgePortConnect(port, bridgeSwDeps).catch((err) => {
    console.error('[slicc-sw] CDP bridge connect failed', err);
  });
});

/**
 * External (leader-tab) secret-aware fetch proxy. The pin check is folded into
 * the pipeline promise so the Port's `onMessage` listener still attaches
 * SYNCHRONOUSLY inside `handleFetchProxyConnectionAsync` — a pin failure
 * rejects the promise, which the handler turns into `response-error`.
 */
function connectExternalFetchProxy(port: ChromeRuntimePort): void {
  const pipelinePromise = beginPortPin(port, portPinDeps, 'fetch-proxy').then((pin) => {
    if (!pin.ok) throw new Error(pin.error);
    return buildReloadedPipelinePromise();
  });
  pipelinePromise.catch((err) => {
    console.error('[sw] external fetch-proxy init failed', err);
  });
  handleFetchProxyConnectionAsync(port as PortLike, pipelinePromise);
}

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
  handleFetchProxyConnectionAsync(port as PortLike, pipelinePromise);
});
