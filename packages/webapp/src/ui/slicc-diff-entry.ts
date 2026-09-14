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

window.__SLICC_DIFFS__ = { parseDiffFromFile, parsePatchFiles };
