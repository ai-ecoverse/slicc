/**
 * IIFE entry point for the <slicc-diff> custom element bundle.
 *
 * Built by esbuild into a standalone script that can be injected into
 * sprinkle iframes. All @pierre/diffs packages are bundled together
 * with Shiki syntax highlighting.
 */

import './slicc-diff.js';
import { parseDiffFromFile, parsePatchFiles } from '@pierre/diffs';

declare global {
  interface Window {
    __SLICC_DIFFS__?: {
      parseDiffFromFile: typeof parseDiffFromFile;
      parsePatchFiles: typeof parsePatchFiles;
    };
  }
}

// Expose diff utilities for sprinkle scripts that need programmatic access
window.__SLICC_DIFFS__ = { parseDiffFromFile, parsePatchFiles };
