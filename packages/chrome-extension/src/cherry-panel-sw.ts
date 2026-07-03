/// <reference path="./chrome.d.ts" />
import type { PanelToSwMessage, SwToPanelMessage } from './cherry-panel-protocol.js';

/** Connected side-panel ports → their windowId (undefined until `hello`). */
const panelPorts = new Map<ChromeRuntimePort, number | undefined>();

/** Current tri-state, broadcast to panels; defaults to booting. */
let state: SwToPanelMessage = { kind: 'join-url', state: 'booting' };

/** Why we're disconnected: a closed leader tab (recreate) vs. a tray that gave
 *  up while the tab still exists (reload). Drives the recovery choice. */
let lastDisconnectReason: 'tab-removed' | 'tray-gave-up' | null = null;
/** Guards leader reload to at most once per `disconnected` episode. */
let recoveredThisEpisode = false;
/** True once the current leader has delivered a real joinUrl. A `null` BEFORE
 *  this is "no joinUrl yet" (booting), not a teardown. */
let hasSeenReady = false;

/** Test-only reset. */
export function resetCherryPanelState(): void {
  panelPorts.clear();
  state = { kind: 'join-url', state: 'booting' };
  lastDisconnectReason = null;
  recoveredThisEpisode = false;
  hasSeenReady = false;
}

export function getPanelState(): SwToPanelMessage {
  return state;
}

function broadcast(): void {
  for (const port of [...panelPorts.keys()]) {
    try {
      port.postMessage(state);
    } catch {
      panelPorts.delete(port);
    }
  }
}

export interface CherryPanelConnectDeps {
  ensureLeaderTab: () => Promise<void>;
  /**
   * Reload the leader tab IF it already exists (returns true if reloaded). Used
   * to recover from a tray reconnect-gave-up (`leader.join-url: null`) while the
   * tab still exists: `ensureLeaderTab()` no-ops then, so nothing re-delivers a
   * joinUrl and the panel would sit at `booting` forever. Optional so existing
   * tests need not pass it.
   */
  reloadLeaderTabIfExists?: () => Promise<boolean>;
}

/**
 * Register a `cherry-panel` port: ensure the leader tab exists (so it becomes a
 * tray leader and delivers `leader.join-url`), and push the current tri-state to
 * this port immediately. The panel sends `{ kind:'hello', windowId }`, recorded
 * per port (informational under the native toggle; used by the fallback toggle
 * path). A fresh connection means we are (re)ensuring the leader, so if we were
 * `disconnected` we move back to `booting` — otherwise a panel that reopens after
 * the leader was closed would show a stale "disconnected" while the leader comes
 * back up.
 */
export async function handleCherryPanelConnect(
  port: ChromeRuntimePort,
  deps: CherryPanelConnectDeps
): Promise<void> {
  // NOTE: the fresh port is intentionally NOT added to `panelPorts` yet — it
  // joins the broadcast set only on `hello` (below). Chrome drops a Port message
  // sent before the receiver attaches its onMessage listener (documented race —
  // see bridge-sw.ts / the fetch-proxy port), and the panel sends `hello` right
  // after attaching its listener. So nothing is ever posted to this port before
  // its `hello`; it receives current state via its own hello replay.
  port.onDisconnect.addListener(() => {
    panelPorts.delete(port);
  });
  port.onMessage.addListener((raw) => {
    const msg = raw as PanelToSwMessage;
    if (msg?.kind !== 'hello') return;
    panelPorts.set(port, typeof msg.windowId === 'number' ? msg.windowId : undefined);
    port.postMessage(state); // race-free replay to THIS port, after its listener is up
  });
  // ensureLeaderTab + recovery run on connect (they don't post to this port).
  // The disconnected→booting transition broadcasts to already-`hello`'d ports;
  // this fresh port is not in the set yet, so it can't receive a pre-hello post —
  // it picks up `booting` via its own hello replay above.
  const wasDisconnected = state.state === 'disconnected';
  if (wasDisconnected) {
    state = { kind: 'join-url', state: 'booting' };
    broadcast();
  }
  await deps.ensureLeaderTab(); // recreates the leader if it was CLOSED → fresh joinUrl
  if (wasDisconnected && lastDisconnectReason === 'tray-gave-up' && !recoveredThisEpisode) {
    // Only the tray-gave-up case needs a reload: the tab still exists, so
    // ensureLeaderTab() no-op'd and nothing re-delivers a joinUrl. For the
    // tab-removed case ensureLeaderTab() just created a fresh tab — reloading
    // that brand-new tab would needlessly interrupt its boot. Bounded to once
    // per disconnected episode.
    recoveredThisEpisode = true;
    await deps.reloadLeaderTabIfExists?.();
  }
}

/** Leader delivered a joinUrl (string), or `null` (no joinUrl yet / tray gave up). */
export function setCherryPanelJoinUrl(joinUrl: string | null): void {
  if (joinUrl) {
    state = { kind: 'join-url', state: 'ready', joinUrl };
    hasSeenReady = true;
    lastDisconnectReason = null;
  } else if (!hasSeenReady) {
    // `null` before we ever had a joinUrl = "no joinUrl yet" → keep the spinner
    // (booting), NOT a teardown. (e.g. the leader is still coming up.)
    state = { kind: 'join-url', state: 'booting' };
  } else {
    // `null` after a prior ready = the tray reconnect gave up while the tab
    // still exists → disconnected + recoverable by reload.
    state = { kind: 'join-url', state: 'disconnected' };
    lastDisconnectReason = 'tray-gave-up';
  }
  recoveredThisEpisode = false;
  broadcast();
}

/** Leader tab was removed → tell panels (recreate on next connect, no reload). */
export function broadcastLeaderGone(): void {
  state = { kind: 'join-url', state: 'disconnected' };
  lastDisconnectReason = 'tab-removed';
  recoveredThisEpisode = false;
  hasSeenReady = false; // the recreated leader is a fresh episode
  broadcast();
}
