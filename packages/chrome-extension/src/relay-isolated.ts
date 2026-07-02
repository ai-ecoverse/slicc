import {
  CHERRY_EVT,
  CHERRY_RELAY_PORT_NAME,
  type SwToRelayMessage,
} from './cherry-relay-protocol.js';

// The ISOLATED content-script world is REUSED across repeated executeScript
// injections on the same live document (off→on toggle without a reload). Re-running
// initRelay would stack Ports + window listeners → stale joinUrl replays + double
// close. Guard with a per-world cleanup sentinel: tear the previous relay down first.
// `__sliccCherryPendingClose` survives a reconnect on the world global so a close
// that hit a dead Port is replayed once a fresh Port connects.
interface RelayGlobal {
  __sliccCherryRelayCleanup?: () => void;
  __sliccCherryPendingClose?: boolean;
}

const RECONNECT_DELAY_MS = 500;

export function initRelay(
  connect: typeof chrome.runtime.connect = chrome.runtime.connect,
  win: Window = window,
  scope: RelayGlobal = globalThis as RelayGlobal,
  setTimeoutFn: typeof setTimeout = setTimeout
): void {
  scope.__sliccCherryRelayCleanup?.(); // idempotent: drop any prior relay in this world

  const port = connect({ name: CHERRY_RELAY_PORT_NAME });
  let lastJoinUrl: string | null = null;
  let intentionalTeardown = false; // set by cleanup so its own disconnect won't reconnect

  const onPortMessage = (msg: SwToRelayMessage) => {
    if (msg?.kind === 'join-url') {
      lastJoinUrl = msg.joinUrl;
      if (msg.joinUrl) {
        win.dispatchEvent(
          new CustomEvent(CHERRY_EVT.joinUrl, { detail: { joinUrl: msg.joinUrl } })
        );
      }
    } else if (msg?.kind === 'teardown') {
      // SW-initiated teardown (2nd icon-click): unmount MAIN, then converge —
      // disconnect our own Port so it isn't left registered for an untracked tab.
      win.dispatchEvent(new CustomEvent(CHERRY_EVT.teardown));
      scope.__sliccCherryRelayCleanup?.();
    }
  };
  // MAIN mounted after we already had a joinUrl → replay it (ordering guard).
  const onMounted = () => {
    if (lastJoinUrl) {
      win.dispatchEvent(new CustomEvent(CHERRY_EVT.joinUrl, { detail: { joinUrl: lastJoinUrl } }));
    }
  };
  // MAIN close button → tell the SW to untrack this tab, then converge (disconnect).
  const onClose = () => {
    try {
      port.postMessage({ kind: 'close' });
      scope.__sliccCherryRelayCleanup?.();
    } catch {
      // Port dead (SW evicted). Remember the close on the world global and
      // reconnect NOW so it is replayed to the woken SW even if the user closed
      // during the reconnect window — otherwise the tab stays in slicc_cherry_tabs.
      scope.__sliccCherryPendingClose = true;
      reconnect(/* immediate */ true);
    }
  };
  const reconnect = (immediate: boolean) => {
    setTimeoutFn(
      () => {
        if (!intentionalTeardown) initRelay(connect, win, scope, setTimeoutFn);
      },
      immediate ? 0 : RECONNECT_DELAY_MS
    );
  };
  // MV3: the SW can be evicted, dropping this Port. Reconnect (which wakes the SW
  // and re-registers this tab's Port) unless we tore down on purpose.
  const onDisconnect = () => {
    if (intentionalTeardown) return;
    reconnect(/* immediate */ false);
  };

  port.onMessage.addListener(onPortMessage as (message: unknown) => void);
  port.onDisconnect.addListener(onDisconnect);
  win.addEventListener(CHERRY_EVT.mounted, onMounted as EventListener);
  win.addEventListener(CHERRY_EVT.close, onClose as EventListener);

  scope.__sliccCherryRelayCleanup = () => {
    intentionalTeardown = true; // suppress the reconnect for a deliberate teardown
    try {
      port.disconnect();
    } catch {
      /* already disconnected */
    }
    win.removeEventListener(CHERRY_EVT.mounted, onMounted as EventListener);
    win.removeEventListener(CHERRY_EVT.close, onClose as EventListener);
    delete scope.__sliccCherryRelayCleanup;
  };

  // A close that hit a dead Port before this (re)connect: replay it now, then converge.
  if (scope.__sliccCherryPendingClose) {
    scope.__sliccCherryPendingClose = false;
    try {
      port.postMessage({ kind: 'close' });
      scope.__sliccCherryRelayCleanup?.();
    } catch {
      scope.__sliccCherryPendingClose = true; // still dead → let onDisconnect retry
    }
  }
}

// Guard against running in test environments where chrome.runtime is not available
if (typeof chrome !== 'undefined' && chrome?.runtime) {
  initRelay();
}
