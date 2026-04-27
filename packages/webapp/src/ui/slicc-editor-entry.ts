/**
 * IIFE entry point for the <slicc-editor> custom element bundle.
 *
 * Built by esbuild into a standalone script that can be injected into
 * sprinkle iframes. All CM6 packages are bundled together so singleton
 * instanceof checks work correctly.
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
