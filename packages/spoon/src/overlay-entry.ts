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
