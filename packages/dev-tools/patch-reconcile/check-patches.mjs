#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPackageFiles } from '../tools/check-lockfile-sync.mjs';
import { checkPatches, checkRenovateSync } from './lib.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const patchesDir = resolve(repoRoot, 'patches');
const manifestPath = resolve(patchesDir, 'patches.json');
const lockPath = resolve(repoRoot, 'package-lock.json');
const renovatePath = resolve(repoRoot, 'renovate.json');

if (!existsSync(patchesDir)) {
  console.log('check-patches: no patches/ directory — nothing to check.');
  process.exit(0);
}

const patchFiles = readdirSync(patchesDir).filter((f) => f.endsWith('.patch'));

if (!existsSync(manifestPath)) {
  if (patchFiles.length === 0) {
    console.log('check-patches: no patches — nothing to check.');
    process.exit(0);
  }
  console.error(
    `check-patches: ${patchFiles.length} patch file(s) present but patches/patches.json is missing. Create it (see patches/README.md).`
  );
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
const renovate = existsSync(renovatePath) ? JSON.parse(readFileSync(renovatePath, 'utf-8')) : null;

const packageFiles = readPackageFiles(
  repoRoot,
  JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf-8'))
);
const { problems, notes, checked } = checkPatches({ patchFiles, manifest, lock, packageFiles });

problems.push(...checkRenovateSync({ manifest, renovate }));

for (const note of notes) console.log(`note: ${note}`);
for (const ok of checked) console.log(`ok: ${ok} patch matches installed version`);

if (problems.length > 0) {
  console.error('\ncheck-patches: FAILED');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`check-patches: ${checked.length} patch(es) OK`);
