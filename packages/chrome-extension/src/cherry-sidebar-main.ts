import { type CherryFeatures, mountSlicc, type SliccHandle } from '@ai-ecoverse/cherry';
import '@ai-ecoverse/spoon'; // registers <slicc-launcher> (benign top-level registration)
import { CHERRY_EVT, type CherryJoinUrlDetail } from './cherry-relay-protocol.js';

// Production hosted origin for the follower iframe. DEV points at the local
// wrangler UI. (Mirror how content-script.ts derives dev vs prod.)
declare const __SLICC_EXT_DEV__: boolean;
const PROD_SLICC_ORIGIN = 'https://www.sliccy.ai';
const DEV_SLICC_ORIGIN = 'http://localhost:8787';
const sliccOrigin = __SLICC_EXT_DEV__ ? DEV_SLICC_ORIGIN : PROD_SLICC_ORIGIN;

const HOST_ID = 'slicc-cherry-sidebar-host';

// Chat-focused per-page sidebar. Kernel-backed panels (terminal/files/memory)
// are inert in a follower; the browser panel is redundant (real chrome.debugger
// CDP drives the tab). `CherryFeatures` fields default to true, so hidden panels
// must be set false explicitly. (Design default — see plan Task 8 note; adjust
// here if the full follower rail is wanted.)
const CHERRY_SIDEBAR_FEATURES: CherryFeatures = {
  terminal: false,
  files: false,
  memory: false,
  browser: false,
  newSprinkle: false,
  monitor: false,
  modelPicker: true,
  history: true,
  nav: true,
};

interface Controller {
  mount(): void;
  unmount(): void;
}

function createController(win: Window = window, doc: Document = document): Controller {
  let launcher: HTMLElement | null = null;
  let handle: SliccHandle | null = null;
  let currentJoinUrl: string | null = null;

  const onJoinUrl = (e: Event) => {
    const joinUrl = (e as CustomEvent<CherryJoinUrlDetail>).detail?.joinUrl;
    if (!joinUrl || !launcher) return;
    if (joinUrl === currentJoinUrl && handle) return; // unchanged
    currentJoinUrl = joinUrl;
    handle?.destroy();
    const iframe = (launcher as unknown as { managedIframe: HTMLIFrameElement }).managedIframe;
    handle = mountSlicc({
      iframe,
      joinToken: joinUrl,
      uiOnly: true,
      sliccOrigin,
      // UI-only: the agent drives the tab via real chrome.debugger CDP, so the
      // cherry needs no page powers and never invokes html2canvas.
      capabilities: { navigate: false, screenshot: 'none', openUrl: false },
      // Chat-focused sidebar: the kernel-backed panels (Terminal/Files/Memory)
      // are inert in a follower and would render as placeholder noise; the
      // Browser panel is redundant since the agent uses real chrome.debugger CDP.
      // Keep chat + nav/history/model picker.
      features: CHERRY_SIDEBAR_FEATURES,
    });
  };

  const onClose = () => {
    teardown(/* notifySw */ true);
  };
  const onTeardown = () => {
    teardown(/* notifySw */ false);
  };

  function teardown(notifySw: boolean) {
    handle?.destroy();
    handle = null;
    currentJoinUrl = null;
    if (launcher) {
      launcher.removeEventListener('slicc-launcher-close', onClose);
      launcher.remove();
      launcher = null;
    }
    win.removeEventListener(CHERRY_EVT.joinUrl, onJoinUrl);
    win.removeEventListener(CHERRY_EVT.teardown, onTeardown);
    if (notifySw) {
      win.dispatchEvent(new CustomEvent(CHERRY_EVT.close)); // → relay → SW untrack
    }
  }

  return {
    mount() {
      if (launcher) return; // idempotent
      launcher = doc.createElement('slicc-launcher');
      launcher.id = HOST_ID;
      launcher.setAttribute('managed', '');
      launcher.setAttribute('open', ''); // open-on-mount sidebar
      launcher.addEventListener('slicc-launcher-close', onClose);
      doc.documentElement.appendChild(launcher); // outside body so page reflow can't drop it
      win.addEventListener(CHERRY_EVT.joinUrl, onJoinUrl);
      win.addEventListener(CHERRY_EVT.teardown, onTeardown);
      // Tell the relay we're ready so it replays a joinUrl that arrived first.
      win.dispatchEvent(new CustomEvent(CHERRY_EVT.mounted));
    },
    unmount() {
      teardown(false);
    },
  };
}

// Registration only — NO auto-mount (avoids the content-script.ts auto-bootstrap trap).
const existing = (globalThis as { __sliccCherrySidebar?: Controller }).__sliccCherrySidebar;
(globalThis as { __sliccCherrySidebar?: Controller }).__sliccCherrySidebar =
  existing ?? createController();
