/**
 * IIFE entry point for the <slicc-diff> custom element bundle.
 *
 * Built by esbuild into a standalone script that can be injected into
 * sprinkle iframes. All @pierre/diffs packages are bundled together
 * with Shiki syntax highlighting.
 */

// Register <diffs-container> web component (provides core CSS via adoptedStyleSheets).
// This import is NOT valid under @pierre/diffs' exports map, but esbuild (which builds
// this IIFE) resolves it directly from node_modules without enforcing exports.
// Must come before slicc-diff.js so the element is defined when FileDiff renders.
// @ts-expect-error — not in package exports map, resolved by esbuild only
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
