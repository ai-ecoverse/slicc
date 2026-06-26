// Copy the single Electron overlay bootstrap into the assembled .app bundle.
// Packaged Sliccstart launches `slicc-server --electron`, whose
// `ElectronOverlayInjector` loads its overlay bootstrap via
// `ElectronLauncher.loadOverlayBundleSource`, probing
// `<projectRoot>/dist/ui/electron-overlay-entry.js`. For a packaged build
// `projectRoot` resolves to `Contents/Resources/slicc`, so the real bootstrap
// must live at `Contents/Resources/slicc/dist/ui/electron-overlay-entry.js`
// or the injector silently degrades to its inline-fallback overlay stub.
//
// We copy ONLY this one bootstrap file — never the multi-MB `dist/ui` tree —
// to stay consistent with the thin-bridge architecture (the UI loads from the
// hosted origin).

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const OVERLAY_ENTRY_FILENAME = 'electron-overlay-entry.js';

/**
 * Copy `electron-overlay-entry.js` from the webapp build output into the
 * assembled app's `Contents/Resources/slicc/dist/ui/` directory.
 *
 * Fails loudly (throws) when the source bootstrap is missing — the webapp
 * build must have produced it first. Silently skipping would reintroduce the
 * packaged-overlay regression this guards against.
 *
 * @param {object} opts
 * @param {string} opts.distUiDir   Directory holding the built `dist/ui` output.
 * @param {string} opts.resourcesDir The app bundle's `Contents/Resources` dir.
 * @returns {string} Absolute path of the copied destination file.
 */
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
