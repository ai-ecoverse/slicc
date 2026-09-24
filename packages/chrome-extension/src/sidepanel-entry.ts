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

export type PanelStatus = 'starting' | 'slow' | 'live' | 'disconnected';

const BOOT_TIMEOUT_MS = 20_000;

const IFRAME_LOAD_TIMEOUT_MS = 15_000;

const PANEL_STATUS_TEXT: Record<PanelStatus, string> = {
  starting: 'Starting SLICC…',
  slow: 'SLICC is still starting in its tab. Chrome slows down background tabs, so bringing it to the front usually lets it finish.',
  live: '',
  disconnected: 'Disconnected from SLICC.',
};

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

  focusLeader(): void;

  retry(): void;
}

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

function disconnectQuietly(port: ChromeRuntimePort | null): void {
  try {
    port?.disconnect();
  } catch {}
}

export function createSidePanelController(deps: SidePanelDeps): SidePanelController {
  let handle: SliccHandle | null = null;
  let currentJoinUrl: string | null = null;
  let disposed = false;
  let port: ChromeRuntimePort | null = null;
  let reconnectDelay = 250;
  const bootTimer = oneShotTimer();
  const iframeLoadTimer = oneShotTimer();

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

  const onIframeLoad = () => {
    if (deps.iframe.getAttribute('src') === 'about:blank') return;
    iframeLoadTimer.clear();
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

    reconnectDelay = 250;
    bootTimer.clear();
    bootSlow = false;
    if (msg.joinUrl === currentJoinUrl && handle) {
      deps.setStatus('live');
      return;
    }
    handle?.destroy();
    handle = null;
    blankIframe();
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
    focusLeader: () => requestLeaderFocus(false),
    retry() {
      if (disposed) return;

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
    statusEl.dataset.state = s;
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
