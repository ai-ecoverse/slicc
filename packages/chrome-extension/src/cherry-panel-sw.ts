/// <reference path="./chrome.d.ts" />
import type { PanelToSwMessage, SwToPanelMessage } from './cherry-panel-protocol.js';

const panelPorts = new Set<ChromeRuntimePort>();

let state: SwToPanelMessage = { kind: 'join-url', state: 'booting' };

let hasSeenReady = false;

let lastLeaderReloadAt = 0;

const LEADER_RELOAD_COOLDOWN_MS = 15_000;

const STORAGE_KEY = 'cherryPanelState';
interface PersistedState {
  state: SwToPanelMessage;
  hasSeenReady: boolean;
  lastLeaderReloadAt: number;
}

let loaded = false;

let loadPromise: Promise<void> | null = null;

let recoveryDeps: { reloadLeaderTabIfExists: () => Promise<boolean> } | null = null;
export function setCherryPanelRecoveryDeps(deps: {
  reloadLeaderTabIfExists: () => Promise<boolean>;
}): void {
  recoveryDeps = deps;
}

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
    } catch {}
    loaded = true;
  })();
  return loadPromise;
}

function persist(): void {
  try {
    void chrome.storage?.session?.set({
      [STORAGE_KEY]: { state, hasSeenReady, lastLeaderReloadAt } satisfies PersistedState,
    });
  } catch {}
}

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

function maybeRecoverLeader(now: number, reload: (() => Promise<boolean>) | undefined): void {
  if (!reload) return;
  if (now - lastLeaderReloadAt < LEADER_RELOAD_COOLDOWN_MS) return;
  lastLeaderReloadAt = now;
  persist();
  void reload();
}

export interface CherryPanelConnectDeps {
  ensureLeaderTab: () => Promise<void>;

  reloadLeaderTabIfExists?: () => Promise<boolean>;

  focusLeaderTab?: () => Promise<void>;

  openSettingsOnLeader?: () => void;
}

export async function handleCherryPanelConnect(
  port: ChromeRuntimePort,
  deps: CherryPanelConnectDeps
): Promise<void> {
  port.onDisconnect.addListener(() => {
    panelPorts.delete(port);
  });
  port.onMessage.addListener((raw) => {
    const msg = raw as PanelToSwMessage;
    if (msg?.kind === 'focus-leader') {
      void deps.focusLeaderTab?.().catch(() => {});
      if (msg.openSettings !== false) deps.openSettingsOnLeader?.();
      return;
    }
    if (msg?.kind !== 'hello') return;

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

  const wasTrayGaveUp = wasDisconnected && hasSeenReady;
  if (wasDisconnected) {
    state = { kind: 'join-url', state: 'booting' };
    persist();
    broadcast();
  }
  await deps.ensureLeaderTab();
  if (wasTrayGaveUp) {
    maybeRecoverLeader(
      Date.now(),
      deps.reloadLeaderTabIfExists ?? recoveryDeps?.reloadLeaderTabIfExists
    );
  }
}

export function setCherryPanelJoinUrl(joinUrl: string | null): void {
  if (joinUrl) {
    state = { kind: 'join-url', state: 'ready', joinUrl };
    hasSeenReady = true;
  } else if (!hasSeenReady) {
    state = { kind: 'join-url', state: 'booting' };
  } else {
    state = { kind: 'join-url', state: 'disconnected' };
    maybeRecoverLeader(Date.now(), recoveryDeps?.reloadLeaderTabIfExists);
  }
  persist();
  broadcast();
}

export function broadcastLeaderGone(): void {
  state = { kind: 'join-url', state: 'disconnected' };
  hasSeenReady = false;
  persist();
  broadcast();
}
