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

export interface SidePanelDeps {
  connect: () => ChromeRuntimePort;
  mountSlicc: typeof mountSlicc;
  iframe: HTMLIFrameElement;
  setStatus: (s: PanelStatus) => void;
  sliccOrigin: string;
  windowId: number;
}

export function createSidePanelController(deps: SidePanelDeps): { dispose(): void } {
  let handle: SliccHandle | null = null;
  let currentJoinUrl: string | null = null;
  let disposed = false;
  let port: ChromeRuntimePort | null = null;
  let reconnectDelay = 250;

  const blankIframe = () => {
    deps.iframe.setAttribute('src', 'about:blank');
  };
  const teardown = () => {
    handle?.destroy();
    handle = null;
    currentJoinUrl = null;
    blankIframe();
  };

  const onMessage = (raw: unknown) => {
    const msg = raw as SwToPanelMessage;
    if (msg?.kind !== 'join-url') return;
    if (msg.state === 'booting') {
      deps.setStatus('starting');
      return;
    }
    if (msg.state === 'disconnected') {
      teardown();
      deps.setStatus('disconnected');
      return;
    }
    // state === 'ready'
    if (msg.joinUrl === currentJoinUrl && handle) {
      // Idempotent (e.g. a `booting` blip from SW eviction replayed the same
      // ready): the follower is already mounted → just re-show it. No remount.
      deps.setStatus('live');
      return;
    }
    handle?.destroy();
    handle = null;
    blankIframe(); // clear the stale follower before remount (destroy() keeps caller iframes)
    currentJoinUrl = msg.joinUrl;
    handle = deps.mountSlicc({
      iframe: deps.iframe,
      joinToken: msg.joinUrl,
      uiOnly: true,
      sliccOrigin: deps.sliccOrigin,
      capabilities: { navigate: false, screenshot: 'none', openUrl: false },
      features: SIDE_PANEL_FEATURES satisfies CherryFeatures,
    });
    // Reveal the follower and let IT own the connecting/connected/terminal UI.
    // (Do NOT keep a covering "starting" overlay here — wc-follower renders its
    // own "connecting" state and, on terminal `onGaveUp`, a "reload to retry"
    // message; a covering overlay would hide that.)
    deps.setStatus('live');
    reconnectDelay = 250;
  };

  const wire = () => {
    port = deps.connect();
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      if (disposed) return;
      setTimeout(() => {
        if (!disposed) wire();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
    });
    port.postMessage({ kind: 'hello', windowId: deps.windowId });
  };

  wire();

  return {
    dispose() {
      disposed = true;
      teardown();
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
  chrome.windows
    .getCurrent()
    .then((w) => {
      createSidePanelController({
        connect: () => chrome.runtime.connect({ name: CHERRY_PANEL_PORT_NAME }),
        mountSlicc,
        iframe,
        setStatus,
        sliccOrigin: sliccOriginDefault,
        windowId: w.id ?? 0,
      });
    })
    .catch((err) => {
      // Don't leave an unhandled rejection; show a recoverable error state.
      console.error('[slicc-sidepanel] boot failed', err);
      setStatus('disconnected');
    });
}
