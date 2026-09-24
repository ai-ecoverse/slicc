/// <reference path="./chrome.d.ts" />
import { type CherryFeatures, mountSlicc, type SliccHandle } from '@ai-ecoverse/cherry';
import { nudgeIframeRepaint, SLICC_HOSTED_ORIGIN } from '@slicc/shared-ts';
import {
  CHERRY_PANEL_PORT_NAME,
  SIDE_PANEL_FEATURES,
  type SwToPanelMessage,
} from './cherry-panel-protocol.js';

// Production hosted origin for the follower iframe; DEV → local wrangler.
declare const __SLICC_EXT_DEV__: boolean;
const sliccOriginDefault = __SLICC_EXT_DEV__ ? 'http://localhost:8787' : SLICC_HOSTED_ORIGIN;

// Panel-chrome status = which overlay (if any) covers the follower iframe:
//  - 'starting'     → "Starting SLICC…" overlay (pre-mount: no follower yet)
//  - 'slow'         → still no follower after BOOT_TIMEOUT_MS: the leader tab is
//                     still booting, so offer to bring it to the front
//  - 'live'         → overlay hidden; the follower iframe is shown and owns its
//                     OWN sub-status (connecting → connected → "reload to retry"
//                     on terminal failure — rendered by wc-follower inside the
//                     iframe, so the panel must NOT cover it)
//  - 'disconnected' → "Disconnected — reopen to retry" overlay (iframe blanked)
export type PanelStatus = 'starting' | 'slow' | 'live' | 'disconnected';

// A leader that boots but never becomes a tray leader (worker unreachable, or it
// resolves as a follower) would leave the SW at 'booting' with no join-url, so
// the panel can't rely on the SW to escalate. Bound the spinner here — but with
// 'slow', not 'disconnected': the usual cause is a leader that is merely slow.
// The pinned leader is a background tab, and on macOS Chrome runs a background
// tab's renderer at the lowest scheduler priority (CPU- and I/O-throttled), so
// on a busy machine a cold boot can take minutes and finishes within seconds of
// the tab being brought to the front. "Reopen to retry" never helped here: the
// SW is still 'booting', so a reconnect just replays it.
const BOOT_TIMEOUT_MS = 20_000;
// After mounting, the follower iframe must actually load; a CSP/network failure
// that never loads the document (so wc-follower's own UI never renders) would
// leave a blank pane. Escalate to a recoverable 'disconnected' if it doesn't.
const IFRAME_LOAD_TIMEOUT_MS = 15_000;

const PANEL_STATUS_TEXT: Record<PanelStatus, string> = {
  starting: 'Starting SLICC…',
  slow: 'SLICC is still starting in its tab. Chrome slows down background tabs, so bringing it to the front usually lets it finish.',
  live: '',
  disconnected: 'Disconnected from SLICC.',
};

// The overlay button per state: 'slow' brings the booting leader forward;
// 'disconnected' retries (see `retry()`). Hidden for the other states.
const PANEL_ACTION_LABEL: Partial<Record<PanelStatus, string>> = {
  slow: 'Show SLICC tab',
  disconnected: 'Retry',
};

export interface SidePanelDeps {
  connect: () => ChromeRuntimePort;
  mountSlicc: typeof mountSlicc;
  iframe: HTMLIFrameElement;
  setStatus: (s: PanelStatus) => void;
  sliccOrigin: string;
}

export interface SidePanelController {
  dispose(): void;
  /** Bring the leader tab to the front (the 'slow' / 'disconnected' overlay button). */
  focusLeader(): void;
  /** Reconnect the Port (the 'disconnected' overlay button). A fresh connect +
   *  hello is what the SW treats as a user retry (`handleCherryPanelConnect`:
   *  disconnected → booting, ensureLeaderTab, reload a leader whose tray gave up)
   *  and it replays the current state, so a panel-local disconnect (iframe
   *  watchdog) remounts on the replayed ready. */
  retry(): void;
}

/** A restartable one-shot timer: `start` replaces any pending run. */
function oneShotTimer() {
  let id: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (id) clearTimeout(id);
    id = null;
  };
  return {
    clear,
    start(ms: number, fn: () => void) {
      clear();
      id = setTimeout(() => {
        id = null;
        fn();
      }, ms);
    },
  };
}

/** `disconnect()` on a dead Port throws; either way the Port is gone. */
function disconnectQuietly(port: ChromeRuntimePort | null): void {
  try {
    port?.disconnect();
  } catch {
    /* already gone */
  }
}

export function createSidePanelController(deps: SidePanelDeps): SidePanelController {
  let handle: SliccHandle | null = null;
  let currentJoinUrl: string | null = null;
  let disposed = false;
  let port: ChromeRuntimePort | null = null;
  let reconnectDelay = 250;
  const bootTimer = oneShotTimer();
  const iframeLoadTimer = oneShotTimer();
  // Set once the boot watchdog fired for this boot; a `booting` replay (SW wake,
  // Port reconnect) keeps 'slow' instead of restarting the 20s spinner.
  let bootSlow = false;

  const blankIframe = () => {
    deps.iframe.setAttribute('src', 'about:blank');
  };
  const teardown = () => {
    bootTimer.clear();
    bootSlow = false;
    iframeLoadTimer.clear();
    handle?.destroy();
    handle = null;
    currentJoinUrl = null;
    blankIframe();
  };
  const goDisconnected = () => {
    teardown();
    deps.setStatus('disconnected');
  };

  // The follower doc loaded (ignore the about:blank load from blankIframe()).
  // Chromium compositor bug: an iframe inside the side panel (a special Chrome
  // surface) may load and execute correctly but never rasterize until DevTools
  // attaches or the page reloads.
  const onIframeLoad = () => {
    if (deps.iframe.getAttribute('src') === 'about:blank') return;
    iframeLoadTimer.clear();
    nudgeIframeRepaint(deps.iframe);
  };
  deps.iframe.addEventListener('load', onIframeLoad);
  deps.iframe.addEventListener('error', () => {
    if (!disposed && handle) goDisconnected();
  });

  // Only the SW can touch chrome.tabs, so every leader-tab focus goes over the
  // Port. `openSettings` distinguishes the sign-in hand-off (land the user on
  // the login UI) from a plain focus.
  const requestLeaderFocus = (openSettings: boolean) => {
    try {
      port?.postMessage({ kind: 'focus-leader', openSettings });
    } catch {
      // Port died (SW evicted / context invalidated) — the follower's card still
      // tells the user to open the SLICC tab manually.
    }
  };

  const onMessage = (raw: unknown) => {
    const msg = raw as SwToPanelMessage;
    if (msg?.kind !== 'join-url') return;

    if (msg.state === 'booting') {
      // A live follower must not be covered by the 'Starting' overlay: an
      // SW-eviction 'booting' replay while the follower is connected is a false
      // alarm, not a fresh boot.
      if (handle) {
        deps.setStatus('live');
        return;
      }
      if (bootSlow) {
        deps.setStatus('slow');
        return;
      }
      deps.setStatus('starting');
      bootTimer.start(BOOT_TIMEOUT_MS, () => {
        if (disposed) return;
        bootSlow = true;
        deps.setStatus('slow');
      });
      return;
    }

    if (msg.state === 'disconnected') {
      goDisconnected();
      return;
    }

    // state === 'ready' — any successful ready resets the reconnect backoff and
    // cancels the boot watchdog.
    reconnectDelay = 250;
    bootTimer.clear();
    bootSlow = false;
    if (msg.joinUrl === currentJoinUrl && handle) {
      // Idempotent (e.g. a `booting` blip replayed the same ready): the follower
      // is already mounted → just re-show it. No remount.
      deps.setStatus('live');
      return;
    }
    handle?.destroy();
    handle = null;
    blankIframe(); // clear the stale follower before remount (destroy() keeps caller iframes)
    currentJoinUrl = msg.joinUrl;
    iframeLoadTimer.start(IFRAME_LOAD_TIMEOUT_MS, () => {
      if (!disposed && handle) goDisconnected();
    });
    handle = deps.mountSlicc({
      iframe: deps.iframe,
      joinToken: msg.joinUrl,
      uiOnly: true,
      sliccOrigin: deps.sliccOrigin,
      capabilities: { navigate: false, screenshot: 'none', openUrl: false },
      features: SIDE_PANEL_FEATURES satisfies CherryFeatures,
      hooks: {
        // The follower asks to sign in — provider login can't complete in the
        // panel iframe, so focus/open the SLICC leader tab where the real login
        // UI runs. Route it through the SW (which owns the leader tab).
        // `slicc.focus-leader-tab` is the follower avatar menu's "Bring leader
        // to front" — a plain focus, with nothing to sign in to.
        onSliccEvent: (name) => {
          if (name === 'slicc.open-leader-tab') requestLeaderFocus(true);
          if (name === 'slicc.focus-leader-tab') requestLeaderFocus(false);
        },
      },
    });
    // Reveal the follower and let IT own the connecting/connected/terminal UI.
    // (wc-follower renders its own 'connecting' state and, on terminal onGaveUp,
    // a 'reload to retry' message; a covering overlay would hide that.)
    deps.setStatus('live');
  };

  const wire = () => {
    try {
      port = deps.connect();
    } catch {
      // Extension context invalidated (reload/update) — stop; Chrome tears the
      // panel document down.
      port = null;
      return;
    }
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      if (disposed) return;
      setTimeout(() => {
        if (!disposed) wire();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
    });
    try {
      port.postMessage({ kind: 'hello' });
    } catch {
      // Port died immediately (context invalidated); onDisconnect (if it fires)
      // schedules the retry.
    }
  };

  wire();

  return {
    focusLeader: () => requestLeaderFocus(false),
    retry() {
      if (disposed) return;
      // Our own disconnect() does not fire our onDisconnect, so re-wire here.
      disconnectQuietly(port);
      port = null;
      reconnectDelay = 250;
      wire();
    },
    dispose() {
      disposed = true;
      teardown();
      deps.iframe.removeEventListener('load', onIframeLoad);
      disconnectQuietly(port);
    },
  };
}

// --- boot (skipped under test: no chrome.runtime / import path differs) ---
if (typeof chrome !== 'undefined' && chrome?.runtime?.id) {
  const iframe = document.getElementById('cherry-follower') as HTMLIFrameElement;
  const statusEl = document.getElementById('cherry-status');
  const statusText = document.getElementById('cherry-status-text');
  const actionButton = document.getElementById('cherry-status-action') as HTMLButtonElement | null;
  let current: PanelStatus = 'starting';
  const setStatus = (s: PanelStatus) => {
    current = s;
    if (!statusEl) return;
    if (statusText) statusText.textContent = PANEL_STATUS_TEXT[s];
    if (actionButton) {
      const label = PANEL_ACTION_LABEL[s];
      actionButton.hidden = !label;
      actionButton.textContent = label ?? '';
    }
    statusEl.dataset.state = s; // CSS shows the overlay for every state but 'live'
  };
  const controller = createSidePanelController({
    connect: () => chrome.runtime.connect({ name: CHERRY_PANEL_PORT_NAME }),
    mountSlicc,
    iframe,
    setStatus,
    sliccOrigin: sliccOriginDefault,
  });
  actionButton?.addEventListener('click', () => {
    if (current === 'disconnected') controller.retry();
    else controller.focusLeader();
  });
}
