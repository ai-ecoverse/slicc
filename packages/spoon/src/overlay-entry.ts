// IIFE entry bundle for the Electron/CDP overlay. Importing this module mounts
// the `<slicc-launcher>` custom element (via the launcher's `define()` call) and
// installs the `window.__SLICC_ELECTRON_OVERLAY__` API that `node-server` and
// `swift-server` invoke through `Page.addScriptToEvaluateOnNewDocument` /
// `executeJavaScript`. The API surface is intentionally stable.
import {
  type InjectSliccLauncherOptions,
  injectSliccLauncher,
  removeSliccLauncher,
} from './inject.js';

declare global {
  interface Window {
    __SLICC_ELECTRON_OVERLAY__?: {
      inject: (options?: InjectSliccLauncherOptions) => void;
      remove: () => void;
    };
  }
}

window.__SLICC_ELECTRON_OVERLAY__ = {
  inject(options: InjectSliccLauncherOptions = {}): void {
    try {
      injectSliccLauncher(document, options);
    } catch (e) {
      console.error('[slicc-launcher] Injection failed:', e);
    }
  },
  remove(): void {
    try {
      removeSliccLauncher(document);
    } catch (e) {
      console.error('[slicc-launcher] Removal failed:', e);
    }
  },
};
