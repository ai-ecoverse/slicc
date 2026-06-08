/**
 * `setup-electron-overlay.ts` — boot stage that applies the
 * electron-overlay specifics on top of an already-constructed
 * {@link Layout}.
 *
 * Extracted verbatim from the `if (isElectronOverlay)` block in
 * `mainStandaloneWorker` (~main.ts:1902–1950). Behavior is unchanged
 * — this is a pure relocation so the boot orchestrator gets thinner
 * and the overlay wiring is testable in isolation.
 *
 * No-op when `isElectronOverlay` is false.
 */

import {
  ELECTRON_OVERLAY_CLOSE_MESSAGE_TYPE,
  getElectronOverlayInitialTab,
  isElectronOverlaySetTabMessage,
} from '../runtime-mode.js';
import type { ElectronOverlaySetupDeps } from './types.js';

/**
 * Apply electron-overlay tweaks to the mounted {@link Layout}: hide the
 * tab-bar (Electron's chrome owns it), set the initial tab from the URL
 * hash, mount a close button in the inner thread header (left of the
 * scoop switcher) that posts a close message to the parent overlay
 * shell, listen for parent-frame `set-tab` messages, and bind ⌘;
 * (Cmd-+-Semicolon) to toggle the overlay window. Returns immediately
 * for non-overlay floats.
 */
export function setupElectronOverlay(deps: ElectronOverlaySetupDeps): void {
  const { layout, isElectronOverlay, window: win, document: doc } = deps;
  if (!isElectronOverlay) return;

  const initialTab = getElectronOverlayInitialTab(win.location.href);
  layout.setActiveTab(initialTab);

  // Only mount the close button when actually embedded in a parent frame
  // (the overlay shell). When `/electron` is opened top-level, posting a
  // close message to `win.parent` would target the page itself and close
  // nothing — render no button instead of a dead control.
  if (win.parent !== win) {
    layout.setShowElectronOverlayClose(() => {
      win.parent.postMessage({ type: ELECTRON_OVERLAY_CLOSE_MESSAGE_TYPE }, '*');
    });
  } else {
    layout.setShowElectronOverlayClose(null);
  }

  const runtimeStyle = doc.createElement('style');
  runtimeStyle.id = 'slicc-electron-overlay-runtime-style';
  runtimeStyle.textContent = `
      #app > .tab-bar { display: none !important; }
      #app > .tab-content {
        height: calc(100vh - var(--s2-header-height));
      }
      #app > .tab-content > .tab-content__panel {
        height: 100%;
      }
    `;
  doc.head.appendChild(runtimeStyle);

  win.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== win.parent) return;
    if (!isElectronOverlaySetTabMessage(event.data)) return;
    layout.setActiveTab(
      getElectronOverlayInitialTab(`http://localhost/?tab=${event.data.tab ?? ''}`)
    );
  });

  win.addEventListener(
    'keydown',
    (event: KeyboardEvent) => {
      if (
        event.code === 'Semicolon' &&
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        !event.repeat
      ) {
        event.preventDefault();
        event.stopPropagation();
        win.parent.postMessage({ type: 'slicc-electron-overlay:toggle' }, '*');
      }
    },
    true
  );
}
