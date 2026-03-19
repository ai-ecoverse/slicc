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
    injectElectronOverlayShell(document, options);
  },
  remove(): void {
    removeElectronOverlayShell(document);
  },
};
