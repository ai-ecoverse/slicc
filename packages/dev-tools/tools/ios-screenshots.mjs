#!/usr/bin/env node
// Capture every screen in packages/ios-app/screenshot-screens.json from a
// built SliccFollower.app on an iOS Simulator, writing PNGs + a
// manifest.json in the Storybook-screenshots shape for the R2 upload and
// sticky-comment steps of .github/workflows/ios-screenshots.yml.
//
// Usage:
//   node packages/dev-tools/tools/ios-screenshots.mjs \
//     --app=packages/ios-app/.build/xcodebuild/Build/Products/Debug-iphonesimulator/SliccFollower.app \
//     --out=.ios-screenshots/out [--udid=<udid>] [--registry=<path>] \
//     [--device=iphone|ipad] [--screen=<name>]
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
  pickNewestIPad,
  pickNewestIPhone,
  screensForCapture,
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
    device: { type: 'string', default: 'iphone' },
    screen: { type: 'string' },
  },
});
if (!args.app || !args.out) {
  console.error(
    'usage: ios-screenshots.mjs --app=<SliccFollower.app> --out=<dir> [--udid=…] [--registry=…] [--device=iphone|ipad] [--screen=…]'
  );
  process.exit(2);
}
if (!['iphone', 'ipad'].includes(args.device)) {
  console.error('::error::--device must be iphone or ipad');
  process.exit(2);
}

const simctl = (...a) => execFileSync('xcrun', ['simctl', ...a], { encoding: 'utf8' });
const sleep = (s) => new Promise((resolve) => setTimeout(resolve, s * 1000));

const registeredScreens = validateScreens(JSON.parse(readFileSync(args.registry, 'utf8')));
let screens;
try {
  screens = screensForCapture(registeredScreens, {
    device: args.device,
    screenName: args.screen,
  });
} catch (error) {
  console.error(`::error::${error.message} in ${args.registry}`);
  process.exit(2);
}

const udid =
  args.udid ??
  (args.device === 'ipad' ? pickNewestIPad : pickNewestIPhone)(
    JSON.parse(simctl('list', 'devices', 'available', '--json'))
  );
if (!udid) {
  console.error(
    `::error::No available ${args.device} simulator (xcodebuild -downloadPlatform iOS)`
  );
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

// Pin the status bar so identical app states hash identically across runs:
// the live clock (and battery/signal chrome) is part of the PNG, and a
// churning hash defeats the R2 dedup and makes every screen read "changed".
console.log('==> pinning simulator status bar');
try {
  simctl(
    'status_bar',
    udid,
    'override',
    '--time',
    '9:41',
    '--batteryState',
    'charged',
    '--batteryLevel',
    '100',
    '--wifiBars',
    '3',
    '--cellularBars',
    '4',
    '--operatorName',
    ''
  );
} catch {
  console.warn('::warning::simctl status_bar override unavailable; screenshot hashes may churn');
}

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
try {
  simctl('status_bar', udid, 'clear');
} catch {
  // Best-effort; the override is harmless to leave on a CI simulator.
}

const manifest = buildManifest(screens, hashes, { device: deviceName });
writeFileSync(join(args.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`==> wrote ${screens.length} screenshots + manifest to ${args.out}`);
