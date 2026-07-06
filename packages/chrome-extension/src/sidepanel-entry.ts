/// <reference path="./chrome.d.ts" />
import { type CherryFeatures, mountSlicc, type SliccHandle } from '@ai-ecoverse/cherry';
import {
  CHERRY_PANEL_PORT_NAME,
  SIDE_PANEL_FEATURES,
  type SwToPanelMessage,
} from './cherry-panel-protocol.js';

// Production hosted origin for the follower iframe; DEV → local wrangler.
declare const __SLICC_EXT_DEV__: boolean;
const sliccOriginDefault = __SLICC_EXT_DEV__ ? 'http://localhost:8787' : 'https://www.sliccy.ai';

// Panel-chrome status = which overlay (if any) covers the follower iframe:
//  - 'starting'     → "Starting SLICC…" overlay (pre-mount: no follower yet)
//  - 'live'         → overlay hidden; the follower iframe is shown and owns its
//                     OWN sub-status (connecting → connected → "reload to retry"
//                     on terminal failure — rendered by wc-follower inside the
//                     iframe, so the panel must NOT cover it)
//  - 'disconnected' → "Disconnected — reopen to retry" overlay (iframe blanked)
export type PanelStatus = 'starting' | 'live' | 'disconnected';

// A leader that boots but never becomes a tray leader (worker unreachable, or it
// resolves as a follower) would leave the SW at 'booting' with no join-url, so
// the panel can't rely on the SW to escalate. Bound the spinner here.
const BOOT_TIMEOUT_MS = 20_000;
// After mounting, the follower iframe must actually load; a CSP/network failure
// that never loads the document (so wc-follower's own UI never renders) would
// leave a blank pane. Escalate to a recoverable 'disconnected' if it doesn't.
const IFRAME_LOAD_TIMEOUT_MS = 15_000;

export interface SidePanelDeps {
  connect: () => ChromeRuntimePort;
  mountSlicc: typeof mountSlicc;
  iframe: HTMLIFrameElement;
  setStatus: (s: PanelStatus) => void;
  sliccOrigin: string;
}

export function createSidePanelController(deps: SidePanelDeps): { dispose(): void } {
  let handle: SliccHandle | null = null;
  let currentJoinUrl: string | null = null;
  let disposed = false;
  let port: ChromeRuntimePort | null = null;
  let reconnectDelay = 250;
  let bootTimer: ReturnType<typeof setTimeout> | null = null;
  let iframeLoadTimer: ReturnType<typeof setTimeout> | null = null;

  const clearBootTimer = () => {
    if (bootTimer) {
      clearTimeout(bootTimer);
      bootTimer = null;
    }
  };
  const clearIframeLoadTimer = () => {
    if (iframeLoadTimer) {
      clearTimeout(iframeLoadTimer);
      iframeLoadTimer = null;
    }
  };

  const blankIframe = () => {
    deps.iframe.setAttribute('src', 'about:blank');
  };
  const teardown = () => {
    clearBootTimer();
    clearIframeLoadTimer();
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
  const onIframeLoad = () => {
    if (deps.iframe.getAttribute('src') === 'about:blank') return;
    clearIframeLoadTimer();
  };
  deps.iframe.addEventListener('load', onIframeLoad);
  deps.iframe.addEventListener('error', () => {
    if (!disposed && handle) goDisconnected();
  });

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
      deps.setStatus('starting');
      clearBootTimer();
      bootTimer = setTimeout(() => {
        bootTimer = null;
        if (!disposed) goDisconnected();
      }, BOOT_TIMEOUT_MS);
      return;
    }

    if (msg.state === 'disconnected') {
      goDisconnected();
      return;
    }

    // state === 'ready' — any successful ready resets the reconnect backoff and
    // cancels the boot watchdog.
    reconnectDelay = 250;
    clearBootTimer();
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
    clearIframeLoadTimer();
    iframeLoadTimer = setTimeout(() => {
      iframeLoadTimer = null;
      if (!disposed && handle) goDisconnected();
    }, IFRAME_LOAD_TIMEOUT_MS);
    handle = deps.mountSlicc({
      iframe: deps.iframe,
      joinToken: msg.joinUrl,
      uiOnly: true,
      sliccOrigin: deps.sliccOrigin,
      capabilities: { navigate: false, screenshot: 'none', openUrl: false },
      features: SIDE_PANEL_FEATURES satisfies CherryFeatures,
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
    dispose() {
      disposed = true;
      teardown();
      deps.iframe.removeEventListener('load', onIframeLoad);
      try {
        port?.disconnect();
      } catch {
        /* already gone */
      }
    },
  };
}

// --- boot (skipped under test: no chrome.runtime / import path differs) ---
if (typeof chrome !== 'undefined' && chrome?.runtime?.id) {
  const iframe = document.getElementById('cherry-follower') as HTMLIFrameElement;
  const statusEl = document.getElementById('cherry-status');
  const setStatus = (s: PanelStatus) => {
    if (!statusEl) return;
    statusEl.textContent =
      s === 'live' ? '' : s === 'starting' ? 'Starting SLICC…' : 'Disconnected — reopen to retry';
    statusEl.dataset.state = s; // CSS shows the overlay only for starting/disconnected
  };
  createSidePanelController({
    connect: () => chrome.runtime.connect({ name: CHERRY_PANEL_PORT_NAME }),
    mountSlicc,
    iframe,
    setStatus,
    sliccOrigin: sliccOriginDefault,
  });
}
