#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];

const STALE =
  'The lockfile is stale — `npm ci` will fail with EUSAGE. Run `npm install` and commit package-lock.json.';

const EXACT = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/;

export function exactVersion(spec) {
  if (typeof spec !== 'string') return null;
  if (EXACT.test(spec)) return spec;
  const alias = /^npm:@?[^@]+@(.+)$/.exec(spec);
  if (alias && EXACT.test(alias[1])) return alias[1];
  return null;
}

export function resolvedVersion(lock, dir, dep) {
  const packages = lock?.packages ?? {};
  const local = dir ? `${dir}/node_modules/${dep}` : null;
  if (local && packages[local]?.version != null) return packages[local].version;
  return packages[`node_modules/${dep}`]?.version ?? null;
}

export function checkLockfileSync({ packageFiles, lock }) {
  const problems = [];
  let checked = 0;

  for (const { dir, manifest } of packageFiles) {
    const lockNode = lock?.packages?.[dir];
    const where = dir ? `${dir}/package.json` : 'package.json';
    if (lockNode == null) {
      problems.push(
        `${where}: no "${dir}" entry in package-lock.json — the lockfile does not know this workspace. Run \`npm install\`.`
      );
      continue;
    }
    for (const section of DEP_SECTIONS) {
      for (const [dep, spec] of Object.entries(manifest?.[section] ?? {})) {
        const version = exactVersion(spec);
        if (version == null) continue;
        checked += 1;
        const problem = checkPin({ lock, lockNode, dir, where, section, dep, spec, version });
        if (problem) problems.push(problem);
      }
    }
  }

  return { problems, checked };
}

function checkPin({ lock, lockNode, dir, where, section, dep, spec, version }) {
  const declaredInLock = lockNode[section]?.[dep];
  if (declaredInLock != null && declaredInLock !== spec) {
    return (
      `${where}: declares ${dep}@${spec} but package-lock.json records ${dep}@${declaredInLock} for this package. ` +
      STALE
    );
  }
  const installed = resolvedVersion(lock, dir, dep);
  if (installed == null) {
    return `${where}: ${dep}@${spec} has no package-lock.json entry (node_modules/${dep}). Run \`npm install\` and commit package-lock.json.`;
  }
  if (installed !== version) {
    return (
      `${where}: declares ${dep}@${spec} but package-lock.json installs ${dep}@${installed}. ` +
      STALE
    );
  }
  return null;
}

export function readPackageFiles(repoRoot, rootManifest) {
  const files = [{ dir: '', manifest: rootManifest }];
  for (const dir of rootManifest?.workspaces ?? []) {
    if (dir.includes('*')) {
      throw new Error(
        `check-lockfile-sync: glob workspace "${dir}" is not supported — list workspace directories explicitly in package.json.`
      );
    }
    const path = resolve(repoRoot, dir, 'package.json');
    if (!existsSync(path)) continue;
    files.push({ dir, manifest: JSON.parse(readFileSync(path, 'utf-8')) });
  }
  return files;
}

function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const rootManifest = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf-8'));
  const lock = JSON.parse(readFileSync(resolve(repoRoot, 'package-lock.json'), 'utf-8'));

  const { problems, checked } = checkLockfileSync({
    packageFiles: readPackageFiles(repoRoot, rootManifest),
    lock,
  });

  if (problems.length > 0) {
    console.error('check-lockfile-sync: FAILED');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  console.log(`check-lockfile-sync: ${checked} exact pin(s) match package-lock.json`);
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) main();
