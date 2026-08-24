#!/usr/bin/env node
// SPM ↔ XcodeGen pin guard. Fails when a GitHub package is declared in both a
// xcodegen project.yml and a Package.swift with incompatible versions, or when
// renovate.json does not label those dual pins `swift-pin` so the companion
// reconcile workflow would never fire.
//
// Reads only the manifests (no install, no Swift toolchain). Wired as
// `npm run lint:swift-pins` into lint / lint:ci. Reconciliation itself is
// `.github/workflows/renovate-swift-pin-reconcile.yml`.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPinFiles } from './files.mjs';
import {
  checkRenovateSwiftPinSync,
  describeMismatch,
  dualPinKeys,
  findMismatches,
} from './lib.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const renovatePath = resolve(repoRoot, 'renovate.json');

const { projectPins, swiftPins, resolvedPins } = readPinFiles(repoRoot);
const mismatches = findMismatches({ projectPins, swiftPins, resolvedPins });

const dualKeys = dualPinKeys({ projectPins, swiftPins });
const seen = new Set();
const dualPins = [];
for (const pin of projectPins) {
  if (!dualKeys.has(pin.key) || seen.has(pin.key)) continue;
  seen.add(pin.key);
  dualPins.push(pin);
}

const renovate = existsSync(renovatePath) ? JSON.parse(readFileSync(renovatePath, 'utf8')) : null;
const problems = [
  ...mismatches.map((m) => describeMismatch(m)),
  ...checkRenovateSwiftPinSync({ dualPins, renovate }),
];

if (problems.length > 0) {
  console.error('check-swift-pins: FAILED');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    'Fix: sync the higher version across project.yml, Package.swift, and Package.resolved (exact pins), or run node packages/dev-tools/swift-pin-reconcile/reconcile.mjs --write'
  );
  process.exit(1);
}

console.log(`check-swift-pins: ${dualPins.length} dual-pinned GitHub package(s) in sync`);
