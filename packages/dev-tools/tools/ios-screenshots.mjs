#!/usr/bin/env node
// Capture every screen in packages/ios-app/screenshot-screens.json from a
// built SliccFollower.app on an iOS Simulator, writing PNGs + a
// manifest.json in the Storybook-screenshots shape for the R2 upload and
// sticky-comment steps of .github/workflows/ios-screenshots.yml.
//
// Usage:
//   node packages/dev-tools/tools/ios-screenshots.mjs \
//     --app=packages/ios-app/.build/xcodebuild/Build/Products/Debug-iphonesimulator/SliccFollower.app \
//     --out=.ios-screenshots/out [--udid=<udid>] [--registry=<path>]
//
// Screens are DEBUG-only UITestHooks states, so --app must be a Debug build.
// Every registered screen is captured on every run — there is no per-screen
// diff mapping (the app is one connected surface; the full set costs under
// two simulator-minutes).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  buildManifest,
  pickNewestIPhone,
  screenshotFile,
  validateScreens,
} from './ios-screenshots-lib.mjs';

const BUNDLE_ID = 'com.sliccy.follower';
const DEFAULT_REGISTRY = 'packages/ios-app/screenshot-screens.json';
const DEFAULT_SETTLE_SECONDS = 6;

const { values: args } = parseArgs({
  options: {
    app: { type: 'string' },
    out: { type: 'string' },
    udid: { type: 'string' },
    registry: { type: 'string', default: DEFAULT_REGISTRY },
  },
});
if (!args.app || !args.out) {
  console.error(
    'usage: ios-screenshots.mjs --app=<SliccFollower.app> --out=<dir> [--udid=…] [--registry=…]'
  );
  process.exit(2);
}

const simctl = (...a) => execFileSync('xcrun', ['simctl', ...a], { encoding: 'utf8' });
const sleep = (s) => new Promise((resolve) => setTimeout(resolve, s * 1000));

const screens = validateScreens(JSON.parse(readFileSync(args.registry, 'utf8')));

const udid =
  args.udid ?? pickNewestIPhone(JSON.parse(simctl('list', 'devices', 'available', '--json')));
if (!udid) {
  console.error('::error::No available iPhone simulator (xcodebuild -downloadPlatform iOS)');
  process.exit(1);
}
const deviceName =
  JSON.parse(simctl('list', 'devices', 'available', '--json')).devices !== undefined
    ? (Object.values(JSON.parse(simctl('list', 'devices', 'available', '--json')).devices)
        .flat()
        .find((d) => d.udid === udid)?.name ?? udid)
    : udid;

console.log(`==> booting simulator ${deviceName} (${udid})`);
try {
  simctl('boot', udid);
} catch {
  // Already booted — bootstatus below is the authoritative wait either way.
}
execFileSync('xcrun', ['simctl', 'bootstatus', udid, '-b'], { stdio: 'inherit' });

console.log(`==> installing ${args.app}`);
try {
  simctl('uninstall', udid, BUNDLE_ID);
} catch {
  // Not installed — fine.
}
simctl('install', udid, args.app);

mkdirSync(args.out, { recursive: true });
const hashes = {};
for (const screen of screens) {
  const settle = screen.settleSeconds ?? DEFAULT_SETTLE_SECONDS;
  console.log(`==> ${screen.name} (settle ${settle}s)`);
  try {
    simctl('terminate', udid, BUNDLE_ID);
  } catch {
    // Not running — fine.
  }
  simctl('launch', udid, BUNDLE_ID, ...screen.args);
  await sleep(settle);
  const file = join(args.out, screenshotFile(screen.name));
  simctl('io', udid, 'screenshot', file);
  hashes[screen.name] = createHash('sha256').update(readFileSync(file)).digest('hex');
}
try {
  simctl('terminate', udid, BUNDLE_ID);
} catch {
  // Already gone.
}

const manifest = buildManifest(screens, hashes, { device: deviceName });
writeFileSync(join(args.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`==> wrote ${screens.length} screenshots + manifest to ${args.out}`);
