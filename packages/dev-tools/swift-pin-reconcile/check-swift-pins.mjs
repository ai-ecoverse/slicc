#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPinFiles } from './files.mjs';
import {
  checkRenovateSwiftPinSync,
  collectDualPins,
  describeMismatch,
  findMismatches,
} from './lib.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const renovatePath = resolve(repoRoot, 'renovate.json');

const { projectPins, swiftPins, resolvedPins } = readPinFiles(repoRoot);
const mismatches = findMismatches({ projectPins, swiftPins, resolvedPins });
const dualPins = collectDualPins({ projectPins, swiftPins });

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
