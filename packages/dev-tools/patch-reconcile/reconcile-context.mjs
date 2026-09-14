#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPackageFiles } from '../tools/check-lockfile-sync.mjs';
import { orphanedPatches } from './lib.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const patchesDir = resolve(repoRoot, 'patches');
const manifestPath = resolve(patchesDir, 'patches.json');
const lockPath = resolve(repoRoot, 'package-lock.json');

const patchFiles = existsSync(patchesDir)
  ? readdirSync(patchesDir).filter((f) => f.endsWith('.patch'))
  : [];
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf-8')) : {};
const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));

const packageFiles = readPackageFiles(
  repoRoot,
  JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf-8'))
);
const orphans = orphanedPatches({ patchFiles, manifest, lock, packageFiles });

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(orphans, null, 2));
  process.exit(0);
}

if (orphans.length === 0) {
  console.log(
    'No orphaned patches — every patch matches its installed version. Nothing to reconcile.'
  );
  process.exit(0);
}

const lines = [`${orphans.length} patch(es) need reconciliation:\n`];
for (const o of orphans) {
  lines.push(`### ${o.pkg}: ${o.patchedVersion} → ${o.installedVersion}`);
  lines.push(`- Patch file: \`${o.patchFile}\` (still pinned to ${o.patchedVersion})`);
  if (o.upstream) lines.push(`- Upstream: ${o.upstream}`);
  if (o.issue) lines.push(`- Tracking issue: ${o.issue}`);
  if (o.reason) lines.push(`- What it does: ${o.reason}`);
  if (o.removeWhen) lines.push(`- Remove when: ${o.removeWhen}`);
  if (o.verify) lines.push(`- Verify with: \`${o.verify}\``);
  lines.push('');
}
console.log(lines.join('\n'));
