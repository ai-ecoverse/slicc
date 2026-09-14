












import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const OVERLAY_ENTRY_FILENAME = 'electron-overlay-entry.js';














export function copyElectronOverlayEntry({ distUiDir, resourcesDir }) {
  const src = resolve(distUiDir, OVERLAY_ENTRY_FILENAME);
  if (!existsSync(src)) {
    throw new Error(
      `ERROR: Electron overlay bootstrap not found: ${src}\n` +
        'Build the overlay first (npm run build -w @ai-ecoverse/spoon) so packaged ' +
        '--electron mode loads the real overlay instead of the inline fallback.'
    );
  }
  const destDir = resolve(resourcesDir, 'slicc/dist/ui');
  mkdirSync(destDir, { recursive: true });
  const dest = resolve(destDir, OVERLAY_ENTRY_FILENAME);
  copyFileSync(src, dest);
  return dest;
}
