// Build Sliccstart's app icon into the assembled .app bundle.
//
// Two artefacts, deliberately both:
//
//   1. `AppIcon.icns` — one flat image, no appearance variants. This is all
//      Sliccstart shipped until now, which is why the app kept its Default
//      artwork in Dark and Tinted mode while every neighbouring app adapted.
//      Kept as the fallback for machines without Xcode (`actool` lives in the
//      Xcode toolchain, unlike `sips`/`iconutil` which ship with macOS), so a
//      toolchain-less assemble still produces a launchable, icon-bearing app.
//
//   2. `Assets.car` compiled from `packages/assets/logos/macos-icon.icon` —
//      the Icon Composer bundle. This is the only supported way to get
//      appearance-keyed macOS app icons: `actool` expands the layered `.icon`
//      into Aqua / DarkAqua / Tintable icon stacks that macOS 26 picks between.
//      A classic `AppIcon.appiconset` CANNOT do this — `actool` accepts the
//      `appearances` key on iOS idioms only and reports macOS ones as
//      "unassigned children", silently dropping them.
//
// When the catalog is built, `CFBundleIconName` must point at it; `Info.plist`
// keeps `CFBundleIconFile` alongside so the `.icns` still resolves on macOS
// versions that predate asset-catalog app icons.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

/** Sizes baked into `AppIcon.iconset` before `iconutil` folds them into .icns. */
export const ICNS_SIZES = [
  [1024, 'icon_512x512@2x.png'],
  [512, 'icon_512x512.png'],
  [512, 'icon_256x256@2x.png'],
  [256, 'icon_256x256.png'],
  [256, 'icon_128x128@2x.png'],
  [128, 'icon_128x128.png'],
  [64, 'icon_32x32@2x.png'],
  [32, 'icon_32x32.png'],
  [32, 'icon_16x16@2x.png'],
  [16, 'icon_16x16.png'],
];

/**
 * Locate `actool`. It ships inside Xcode, not the Command Line Tools, so this
 * returns null on a machine with only the CLT installed rather than throwing —
 * the caller degrades to the .icns-only icon.
 *
 * @param {(cmd: string, args: string[]) => string} [run] Injected for tests.
 * @returns {string | null} Absolute path to actool, or null when unavailable.
 */
export function findActool(run = defaultRun) {
  try {
    const found = run('xcrun', ['--find', 'actool']).trim();
    return found.length > 0 ? found : null;
  } catch {
    return null;
  }
}

/**
 * Build `AppIcon.icns` from a single 1024x1024 source PNG.
 *
 * @param {object} opts
 * @param {string} opts.iconSrc      1024x1024 source PNG.
 * @param {string} opts.resourcesDir The bundle's `Contents/Resources`.
 * @param {(cmd: string, args: string[]) => string} [opts.run] Injected for tests.
 * @returns {string} Absolute path of the written `.icns`.
 */
export function buildIcns({ iconSrc, resourcesDir, run = defaultRun }) {
  if (!existsSync(iconSrc)) {
    throw new Error(`ERROR: Icon source not found: ${iconSrc}`);
  }
  const iconset = resolve(resourcesDir, 'AppIcon.iconset');
  mkdirSync(iconset, { recursive: true });
  for (const [size, name] of ICNS_SIZES) {
    run('sips', ['-z', String(size), String(size), iconSrc, '--out', resolve(iconset, name)]);
  }
  const icns = resolve(resourcesDir, 'AppIcon.icns');
  run('iconutil', ['-c', 'icns', iconset, '-o', icns]);
  rmSync(iconset, { recursive: true, force: true });
  return icns;
}

/**
 * Compile the Icon Composer bundle into `Assets.car` next to the `.icns`.
 *
 * Returns a result rather than throwing on a missing toolchain: an assemble on
 * a machine without Xcode should still produce a working app, just without the
 * appearance variants. A missing `.icon` source IS fatal — that means the repo
 * is inconsistent, not the machine.
 *
 * @param {object} opts
 * @param {string} opts.iconBundle    Path to the `.icon` directory.
 * @param {string} opts.resourcesDir  The bundle's `Contents/Resources`.
 * @param {string} opts.deploymentTarget e.g. `'26.0'`.
 * @param {(cmd: string, args: string[]) => string} [opts.run] Injected for tests.
 * @returns {{ built: boolean, iconName?: string, skipped?: string }}
 */
export function buildIconAssetCatalog({
  iconBundle,
  resourcesDir,
  deploymentTarget,
  run = defaultRun,
}) {
  if (!existsSync(iconBundle)) {
    throw new Error(`ERROR: Icon Composer bundle not found: ${iconBundle}`);
  }
  const actool = findActool(run);
  if (!actool) {
    return { built: false, skipped: 'actool not found (Xcode not installed)' };
  }
  // `actool` names the icon after the .icon bundle's basename, and that name is
  // what CFBundleIconName has to match — deriving it from the filename keeps
  // the two from drifting apart if the bundle is ever renamed.
  const iconName = iconBundle.replace(/.*\//, '').replace(/\.icon$/, '');
  const partialPlist = resolve(resourcesDir, 'actool-partial.plist');
  run(actool, [
    iconBundle,
    '--compile',
    resourcesDir,
    '--platform',
    'macosx',
    '--minimum-deployment-target',
    deploymentTarget,
    '--app-icon',
    iconName,
    '--output-partial-info-plist',
    partialPlist,
  ]);
  rmSync(partialPlist, { force: true });
  if (!existsSync(resolve(resourcesDir, 'Assets.car'))) {
    return { built: false, skipped: 'actool produced no Assets.car' };
  }
  // actool also emits `<iconName>.icns`. Drop it: Info.plist's
  // CFBundleIconFile points at `AppIcon`, and leaving a second, differently
  // named .icns in Resources just invites the wrong one being picked up.
  rmSync(resolve(resourcesDir, `${iconName}.icns`), { force: true });
  return { built: true, iconName };
}

/** @type {(cmd: string, args: string[]) => string} */
function defaultRun(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
