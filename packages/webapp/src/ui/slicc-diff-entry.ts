/**
 * Entry point for the <slicc-diff> custom element bundle sprinkle iframes load.
 *
 * A Rollup entry in the app's own build (`build.rollupOptions.input`), reached
 * through the stable-name loader shim `dist/ui/slicc-diff.js`. That is what
 * keeps @pierre/diffs and the curated Shiki grammar set SHARED with the app
 * instead of a second eager copy — as an esbuild IIFE this file was 5.8 MB.
 */

// Register <diffs-container> web component (provides core CSS via adoptedStyleSheets).
// This import is NOT valid under @pierre/diffs' exports map; `MODULE_ALIASES` in
// vite.config.ts points it straight at the file in node_modules.
// Must come before slicc-diff.js so the element is defined when FileDiff renders.
// @ts-expect-error — not in package exports map, resolved by a Vite alias
import '@pierre/diffs/dist/components/web-components.js';
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
