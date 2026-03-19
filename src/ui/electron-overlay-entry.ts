import {
  injectElectronOverlayShell,
  removeElectronOverlayShell,
  type InjectElectronOverlayOptions,
} from './electron-overlay.js';

declare global {
  interface Window {
    __SLICC_ELECTRON_OVERLAY__?: {
      inject: (options?: InjectElectronOverlayOptions) => void;
      remove: () => void;
    };
  }
}

window.__SLICC_ELECTRON_OVERLAY__ = {
  inject(options: InjectElectronOverlayOptions = {}): void {
    try {
      injectElectronOverlayShell(document, options);
    } catch (e) {
      console.error('[slicc-overlay] Injection failed:', e);
    }
  },
  remove(): void {
    try {
      removeElectronOverlayShell(document);
    } catch (e) {
      console.error('[slicc-overlay] Removal failed:', e);
    }
  },
};