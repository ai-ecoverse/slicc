#!/usr/bin/env node

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
} catch {}
execFileSync('xcrun', ['simctl', 'bootstatus', udid, '-b'], { stdio: 'inherit' });

console.log(`==> installing ${args.app}`);
try {
  simctl('uninstall', udid, BUNDLE_ID);
} catch {}
simctl('install', udid, args.app);

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
let previousAppearance = '';
try {
  previousAppearance = simctl('ui', udid, 'appearance').trim().toLowerCase();
} catch {}
for (const screen of screens) {
  const settle = screen.settleSeconds ?? DEFAULT_SETTLE_SECONDS;
  console.log(`==> ${screen.name} (settle ${settle}s)`);
  try {
    simctl('terminate', udid, BUNDLE_ID);
  } catch {}

  const appearance = screen.appearance === 'light' ? 'light' : 'dark';
  try {
    simctl('ui', udid, 'appearance', appearance);
  } catch {
    console.warn(`::warning::simctl ui appearance ${appearance} failed for ${screen.name}`);
  }
  simctl('launch', udid, BUNDLE_ID, ...screen.args);
  await sleep(settle);
  const file = join(args.out, screenshotFile(screen.name));
  simctl('io', udid, 'screenshot', file);
  hashes[screen.name] = createHash('sha256').update(readFileSync(file)).digest('hex');
}
try {
  simctl('terminate', udid, BUNDLE_ID);
} catch {}
try {
  simctl('status_bar', udid, 'clear');
} catch {}
if (previousAppearance === 'light' || previousAppearance === 'dark') {
  try {
    simctl('ui', udid, 'appearance', previousAppearance);
  } catch {}
}

const manifest = buildManifest(screens, hashes, { device: deviceName });
writeFileSync(join(args.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`==> wrote ${screens.length} screenshots + manifest to ${args.out}`);
