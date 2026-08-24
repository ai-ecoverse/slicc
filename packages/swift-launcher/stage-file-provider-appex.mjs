// Stage the File Provider appex inside Sliccstart.app: copy the xcodebuild
// product, then drop in the two resources fileproviderd needs at launch.
//
// The appex links `@rpath/WebRTC.framework/WebRTC` with rpaths
// `@executable_path/../Frameworks` and `@executable_path/../../../../Frameworks`
// (host `Contents/Frameworks`). slicc-server needs the same framework at
// `Contents/Resources` (`@loader_path`). A sandboxed File Provider cannot
// load from the host Resources folder, so a missing appex-local copy makes
// fileproviderd fail with extensionKit error 2 — Finder then shows
// "encountered an error. Items may be out of date."
//
// Finder Locations also uses the *appex* icon, not the host's. Without
// AppIcon.icns the sidebar falls back to a generic document glyph.

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const FILE_PROVIDER_APPEX_NAME = 'SliccFileProvider.appex';

/**
 * Copy the built File Provider appex into `Contents/PlugIns/` and embed
 * WebRTC.framework + AppIcon.icns so the extension can launch and Finder
 * has a branded sidebar icon.
 *
 * @param {object} opts
 * @param {string} opts.appexSource     Built `.appex` bundle from xcodebuild.
 * @param {string} opts.plugInsDir      Host `Contents/PlugIns` directory.
 * @param {string} opts.webrtcFramework Source `WebRTC.framework` bundle.
 * @param {string} opts.appIconIcns     Source `AppIcon.icns`.
 * @returns {string} Absolute path of the staged appex.
 */
export function stageFileProviderAppex({
  appexSource,
  plugInsDir,
  webrtcFramework,
  appIconIcns,
}) {
  if (!existsSync(appexSource)) {
    throw new Error(`ERROR: SliccFileProvider.appex not found at ${appexSource}`);
  }
  if (!existsSync(webrtcFramework)) {
    throw new Error(
      `ERROR: WebRTC.framework not found at ${webrtcFramework}. ` +
        'The File Provider appex links it at @rpath; copy the same framework ' +
        'slicc-server uses so fileproviderd can launch the extension.'
    );
  }
  if (!existsSync(appIconIcns)) {
    throw new Error(
      `ERROR: AppIcon.icns not found at ${appIconIcns}. ` +
        'Finder Locations uses the appex icon; assemble-app must generate it first.'
    );
  }

  mkdirSync(plugInsDir, { recursive: true });
  const dest = resolve(plugInsDir, FILE_PROVIDER_APPEX_NAME);
  cpSync(appexSource, dest, { recursive: true });

  const frameworks = resolve(dest, 'Contents/Frameworks');
  mkdirSync(frameworks, { recursive: true });
  cpSync(webrtcFramework, resolve(frameworks, 'WebRTC.framework'), {
    recursive: true,
    verbatimSymlinks: true,
  });

  const resources = resolve(dest, 'Contents/Resources');
  mkdirSync(resources, { recursive: true });
  cpSync(appIconIcns, resolve(resources, 'AppIcon.icns'));

  return dest;
}
