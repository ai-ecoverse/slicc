/// <reference path="./chrome.d.ts" />
import { type CherryFeatures, mountSlicc, type SliccHandle } from '@ai-ecoverse/cherry';
import { nudgeIframeRepaint, SLICC_HOSTED_ORIGIN } from '@slicc/shared-ts';
import {
  CHERRY_PANEL_PORT_NAME,
  SIDE_PANEL_FEATURES,
  type SwToPanelMessage,
} from './cherry-panel-protocol.js';

declare const __SLICC_EXT_DEV__: boolean;
const sliccOriginDefault = __SLICC_EXT_DEV__ ? 'http://localhost:8787' : SLICC_HOSTED_ORIGIN;

export type PanelStatus = 'starting' | 'live' | 'disconnected';

const BOOT_TIMEOUT_MS = 20_000;

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

  const onIframeLoad = () => {
    if (deps.iframe.getAttribute('src') === 'about:blank') return;
    clearIframeLoadTimer();
    nudgeIframeRepaint(deps.iframe);
  };
  deps.iframe.addEventListener('load', onIframeLoad);
  deps.iframe.addEventListener('error', () => {
    if (!disposed && handle) goDisconnected();
  });

  const requestLeaderFocus = (openSettings: boolean) => {
    try {
      port?.postMessage({ kind: 'focus-leader', openSettings });
    } catch {}
  };

  const onMessage = (raw: unknown) => {
    const msg = raw as SwToPanelMessage;
    if (msg?.kind !== 'join-url') return;

    if (msg.state === 'booting') {
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

    reconnectDelay = 250;
    clearBootTimer();
    if (msg.joinUrl === currentJoinUrl && handle) {
      deps.setStatus('live');
      return;
    }
    handle?.destroy();
    handle = null;
    blankIframe();
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
      hooks: {
        onSliccEvent: (name) => {
          if (name === 'slicc.open-leader-tab') requestLeaderFocus(true);
          if (name === 'slicc.focus-leader-tab') requestLeaderFocus(false);
        },
      },
    });

    deps.setStatus('live');
  };

  const wire = () => {
    try {
      port = deps.connect();
    } catch {
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
    } catch {}
  };

  wire();

  return {
    dispose() {
      disposed = true;
      teardown();
      deps.iframe.removeEventListener('load', onIframeLoad);
      try {
        port?.disconnect();
      } catch {}
    },
  };
}

if (typeof chrome !== 'undefined' && chrome?.runtime?.id) {
  const iframe = document.getElementById('cherry-follower') as HTMLIFrameElement;
  const statusEl = document.getElementById('cherry-status');
  const setStatus = (s: PanelStatus) => {
    if (!statusEl) return;
    statusEl.textContent =
      s === 'live' ? '' : s === 'starting' ? 'Starting SLICC…' : 'Disconnected — reopen to retry';
    statusEl.dataset.state = s;
  };
  createSidePanelController({
    connect: () => chrome.runtime.connect({ name: CHERRY_PANEL_PORT_NAME }),
    mountSlicc,
    iframe,
    setStatus,
    sliccOrigin: sliccOriginDefault,
  });
}
