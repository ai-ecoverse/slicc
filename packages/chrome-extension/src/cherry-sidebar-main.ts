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
    // SECURITY: this MAIN-world entry shares the page realm with the (possibly
    // hostile) host page, which can forge this `window` CustomEvent to redirect
    // the follower's tray/WebRTC signaling to an attacker-controlled leader and
    // harvest everything the user types/pastes into the sidebar. Defend by only
    // accepting a joinUrl whose origin matches the trusted tray-worker origin the
    // service worker plumbed in via `chrome.scripting.executeScript` (an
    // unforgeable channel the page cannot invoke). The SW derives it from the
    // joinUrl it received over the trusted `slicc.cdp-bridge` Port, and installs
    // it as a non-writable/non-configurable `window` property BEFORE pushing the
    // joinUrl, so a page pre-empt is either overridden (SW wins) or fails closed
    // (no trusted origin → reject → no connection, never a hijack). The trusted
    // tray origin is NOT the app origin (`sliccOrigin`): the tray worker is a
    // separate, deployment-configurable origin.
    const trustedOrigin = (win as Window & { __sliccCherryTrustedOrigin?: unknown })
      .__sliccCherryTrustedOrigin;
    if (typeof trustedOrigin !== 'string') {
      // Fail closed: the SW hasn't plumbed a trusted origin yet, so we can't
      // trust any joinUrl (this also rejects a joinUrl event forged before the
      // SW ever delivered a real one).
      console.warn('[slicc-cherry] ignoring joinUrl — no SW-plumbed trusted origin yet');
      return;
    }
    let joinOrigin: string;
    try {
      joinOrigin = new URL(joinUrl).origin;
    } catch {
      console.warn('[slicc-cherry] ignoring malformed joinUrl from cherry-joinurl event');
      return;
    }
    if (joinOrigin !== trustedOrigin) {
      console.warn('[slicc-cherry] ignoring joinUrl with untrusted origin', {
        joinOrigin,
        expected: trustedOrigin,
      });
      return;
    }
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
