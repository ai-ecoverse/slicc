/**
 * Entry point for the <slicc-editor> custom element bundle sprinkle iframes load.
 *
 * A Rollup entry in the app's own build (`build.rollupOptions.input`), reached
 * through the stable-name loader shim `dist/ui/slicc-editor.js`. One CM6 copy
 * for the app and for sprinkles, so singleton instanceof checks still hold and
 * the packages are not bundled twice.
 */

import './slicc-editor.js';
import { StreamLanguage } from '@codemirror/language';

declare global {
  interface Window {
    __SLICC_CM6__?: {
      StreamLanguage: typeof StreamLanguage;
    };
  }
}

// Expose CM6 utilities for sprinkle scripts that need custom language modes
window.__SLICC_CM6__ = { StreamLanguage };
