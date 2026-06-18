// Electron-overlay entry bundle. Wave 2 of the thin-extension migration rewires
// this to mount the new `<slicc-launcher>` web component from
// `@slicc/webcomponents`; the legacy `<slicc-electron-overlay>` element in
// `electron-overlay.ts` is preserved for back-compat (and existing tests) but
// no longer driven from Electron. The exposed `window.__SLICC_ELECTRON_OVERLAY__`
// API surface is unchanged so `node-server/src/electron-main.ts` keeps working.
import {
  type InjectSliccLauncherOptions,
  injectSliccLauncher,
  removeSliccLauncher,
} from './slicc-launcher-inject.js';

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
