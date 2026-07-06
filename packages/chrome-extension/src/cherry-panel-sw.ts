/// <reference path="./chrome.d.ts" />
import type { PanelToSwMessage, SwToPanelMessage } from './cherry-panel-protocol.js';

/** Connected side-panel ports (added to the broadcast set on `hello`). */
const panelPorts = new Set<ChromeRuntimePort>();

/** Current tri-state, broadcast to panels; defaults to booting. */
let state: SwToPanelMessage = { kind: 'join-url', state: 'booting' };

/** True once the current leader has delivered a real joinUrl. A `null` BEFORE
 *  this is "no joinUrl yet" (booting); a `null` AFTER it is "tray gave up". */
let hasSeenReady = false;

/** Last time we reloaded the leader tab to recover a dead tray. Rate-limits the
 *  recovery so a persistently-unreachable tray can't loop reloads. */
let lastLeaderReloadAt = 0;

/** Min gap between leader-recovery reloads. */
const LEADER_RELOAD_COOLDOWN_MS = 15_000;

/**
 * MV3 service workers are evicted after ~30s idle, wiping module state. Persist
 * the tri-state to `chrome.storage.session` (survives eviction, cleared on
 * browser restart) so a wake doesn't reset a live `ready`/`disconnected` back to
 * `booting` — which would blank a working follower or strand the panel on the
 * spinner forever.
 */
const STORAGE_KEY = 'cherryPanelState';
interface PersistedState {
  state: SwToPanelMessage;
  hasSeenReady: boolean;
  lastLeaderReloadAt: number;
}
/** True only AFTER restoration completed — a synchronous hello replay may use the
 *  restored `state` without awaiting (see `handleCherryPanelConnect`). */
let loaded = false;
/** Cached in-flight restore so concurrent callers share one storage read and all
 *  observe the restored state (a plain boolean would let the 2nd caller proceed
 *  on un-restored state while the 1st is still awaiting). */
let loadPromise: Promise<void> | null = null;

/** Recovery hook, injected by the service worker at boot. */
let recoveryDeps: { reloadLeaderTabIfExists: () => Promise<boolean> } | null = null;
export function setCherryPanelRecoveryDeps(deps: {
  reloadLeaderTabIfExists: () => Promise<boolean>;
}): void {
  recoveryDeps = deps;
}

/** Restore persisted state on first use after an SW wake. Idempotent (cached). */
function ensureLoaded(): Promise<void> {
  loadPromise ??= (async () => {
    try {
      const saved = (await chrome.storage?.session?.get(STORAGE_KEY))?.[STORAGE_KEY] as
        | PersistedState
        | undefined;
      if (saved?.state) {
        state = saved.state;
        hasSeenReady = Boolean(saved.hasSeenReady);
        lastLeaderReloadAt =
          typeof saved.lastLeaderReloadAt === 'number' ? saved.lastLeaderReloadAt : 0;
      }
    } catch {
      // storage.session unavailable (older Chrome / tests) — fall back to memory.
    }
    loaded = true;
  })();
  return loadPromise;
}

function persist(): void {
  try {
    void chrome.storage?.session?.set({
      [STORAGE_KEY]: { state, hasSeenReady, lastLeaderReloadAt } satisfies PersistedState,
    });
  } catch {
    // best-effort
  }
}

/** Test-only reset. */
export function resetCherryPanelState(): void {
  panelPorts.clear();
  state = { kind: 'join-url', state: 'booting' };
  hasSeenReady = false;
  lastLeaderReloadAt = 0;
  loaded = false;
  loadPromise = null;
  recoveryDeps = null;
}

export function getPanelState(): SwToPanelMessage {
  return state;
}

function broadcast(): void {
  for (const port of [...panelPorts]) {
    try {
      port.postMessage(state);
    } catch {
      panelPorts.delete(port);
    }
  }
}

/**
 * Reload the leader tab to recover a dead tray — but at most once per cooldown,
 * so an unreachable tray can't loop reloads. Callers only invoke this when the
 * leader tab is known to still exist (a tray-gave-up, distinguished from a
 * tab-removed by `hasSeenReady`); a removed tab is recreated by `ensureLeaderTab`
 * instead, and reloading the brand-new tab would needlessly interrupt its boot.
 */
function maybeRecoverLeader(now: number, reload: (() => Promise<boolean>) | undefined): void {
  if (!reload) return;
  if (now - lastLeaderReloadAt < LEADER_RELOAD_COOLDOWN_MS) return;
  lastLeaderReloadAt = now;
  persist();
  void reload();
}

export interface CherryPanelConnectDeps {
  ensureLeaderTab: () => Promise<void>;
  /** Reload the leader tab IF it exists (returns true if reloaded). Optional so
   *  existing tests need not pass it. */
  reloadLeaderTabIfExists?: () => Promise<boolean>;
  /** Focus (or create) the pinned leader tab. Requested by the panel when the
   *  follower needs to sign in — provider login runs on the leader tab, not in
   *  the side-panel iframe. Optional so existing tests need not pass it. */
  focusLeaderTab?: () => Promise<void>;
}

/**
 * Register a `cherry-panel` port: restore persisted state (post-eviction),
 * ensure the leader tab exists, and replay current state to this port on its
 * `hello`. If we were `disconnected` a fresh connection is a user-driven retry,
 * so we move back to `booting` and attempt one (cooldown-bounded) leader reload.
 */
export async function handleCherryPanelConnect(
  port: ChromeRuntimePort,
  deps: CherryPanelConnectDeps
): Promise<void> {
  // Attach listeners SYNCHRONOUSLY, before any `await` — Chrome drops a Port
  // message that arrives before its listener is up, and the panel sends `hello`
  // immediately after connecting. Awaiting `ensureLoaded()` first would drop that
  // hello and strand the panel on the spinner forever (see chrome-extension
  // CLAUDE.md "onMessage Listener Must Attach Synchronously").
  port.onDisconnect.addListener(() => {
    panelPorts.delete(port);
  });
  port.onMessage.addListener((raw) => {
    const msg = raw as PanelToSwMessage;
    if (msg?.kind === 'focus-leader') {
      // The follower asked to sign in — focus/create the leader tab where the
      // real login UI runs. Fire-and-forget; the panel's card already told the
      // user, so a focus failure isn't fatal.
      void deps.focusLeaderTab?.().catch(() => {});
      return;
    }
    if (msg?.kind !== 'hello') return;
    // The port joins the broadcast set on `hello` and gets a race-free replay of
    // the current (restored) state to itself. Fast-path the replay when the
    // restore already finished so a just-connected panel sees state synchronously;
    // otherwise wait for the restore so we don't replay stale default `booting`.
    if (loaded) {
      panelPorts.add(port);
      port.postMessage(state);
    } else {
      void ensureLoaded().then(() => {
        panelPorts.add(port);
        port.postMessage(state);
      });
    }
  });

  await ensureLoaded();
  const wasDisconnected = state.state === 'disconnected';
  // Tray-gave-up (tab still exists) vs tab-removed: only the former should be
  // recovered by reloading; `hasSeenReady` stays true for tray-gave-up and is
  // reset to false by `broadcastLeaderGone` (tab-removed).
  const wasTrayGaveUp = wasDisconnected && hasSeenReady;
  if (wasDisconnected) {
    state = { kind: 'join-url', state: 'booting' };
    persist();
    broadcast();
  }
  await deps.ensureLeaderTab(); // recreates the leader if it was CLOSED → fresh joinUrl
  if (wasTrayGaveUp) {
    // Reopen after a dead tray is a user-driven retry: reload the still-existing
    // leader so it re-establishes its tray. Cooldown-bounded against the reload
    // the tray-gave-up path already fired.
    maybeRecoverLeader(
      Date.now(),
      deps.reloadLeaderTabIfExists ?? recoveryDeps?.reloadLeaderTabIfExists
    );
  }
}

/** Leader delivered a joinUrl (string), or `null` (no joinUrl yet / tray gave up). */
export function setCherryPanelJoinUrl(joinUrl: string | null): void {
  if (joinUrl) {
    state = { kind: 'join-url', state: 'ready', joinUrl };
    hasSeenReady = true;
  } else if (!hasSeenReady) {
    // `null` before we ever had a joinUrl = "no joinUrl yet" → keep the spinner.
    state = { kind: 'join-url', state: 'booting' };
  } else {
    // `null` after a prior ready = the tray reconnect gave up while the tab still
    // exists → disconnected + recoverable. Reload the leader NOW (panel-open or
    // not) so a background leader — the surface that delivers handoff licks —
    // doesn't stay silently broken until the user happens to open the panel.
    state = { kind: 'join-url', state: 'disconnected' };
    maybeRecoverLeader(Date.now(), recoveryDeps?.reloadLeaderTabIfExists);
  }
  persist();
  broadcast();
}

/** Leader tab was removed → tell panels; the recreated leader is a fresh
 *  lifecycle, so reset `hasSeenReady`. */
export function broadcastLeaderGone(): void {
  state = { kind: 'join-url', state: 'disconnected' };
  hasSeenReady = false;
  persist();
  broadcast();
}
