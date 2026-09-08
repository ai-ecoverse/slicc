#!/usr/bin/env node
// Lockfile-sync guard. Fails (exit 1) when a `package.json` declares a version
// that `package-lock.json` does not carry — the state in which `npm ci` dies
// with EUSAGE ("lock file's lucide@1.38.0 does not satisfy lucide@1.39.0") and
// every CI job goes red at install time.
//
// Renovate is the reason this exists: its Mend-hosted lockfile artifact update
// intermittently produces a `package.json`-only commit (PRs #2848, #2882,
// #2903, #2922, #2957, #2979 — all born red, all repaired by hand with a plain
// `npm install`). `skipInstalls: false` (PR #2926) did not stop it. This guard
// is the deterministic detector, and
// `.github/workflows/renovate-lockfile-reconcile.yml` is the repair that runs
// off it.
//
// Reads only the manifests + the lockfile (no install), so it is cheap enough
// for `npm run lint` and for a workflow pre-check.
//
// Only EXACT declared versions are checked. `rangeStrategy: "pin"` means every
// dependency/devDependency is exact anyway (see docs/development.md), and a
// range genuinely can be satisfied by a different locked version.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];

const STALE =
  'The lockfile is stale — `npm ci` will fail with EUSAGE. Run `npm install` and commit package-lock.json.';

const EXACT = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/;

/**
 * The exact version a spec pins, or `null` when it is a range, URL, or
 * `workspace` link. Registry aliases (`npm:typescript@6.0.3`, how the repo
 * carries the classic TypeScript compiler) pin exactly as much as a bare
 * version does, and Renovate bumps them the same way, so resolve those too.
 */
export function exactVersion(spec) {
  if (typeof spec !== 'string') return null;
  if (EXACT.test(spec)) return spec;
  const alias = /^npm:@?[^@]+@(.+)$/.exec(spec);
  if (alias && EXACT.test(alias[1])) return alias[1];
  return null;
}

/**
 * Version npm would install for `dep` as seen from the package at `dir`
 * (`''` for the repo root), or `null` when the lockfile has no copy.
 *
 * Prefers the package-local `<dir>/node_modules/<dep>` copy, then the hoisted
 * root one, mirroring npm's own resolution: with two workspaces on different
 * versions only one of them can be hoisted.
 *
 * Deliberately does NOT fall back to an arbitrary nested copy the way
 * `patch-reconcile/lib.mjs` → `lockedVersion()` does. That helper answers "what
 * version of this package is installed anywhere", for a patch that may be
 * applied to a transitive dependency. This one answers "what will THIS package
 * resolve to", and any other location is not that package's copy — reporting it
 * as missing is the honest answer, and still fails.
 */
export function resolvedVersion(lock, dir, dep) {
  const packages = lock?.packages ?? {};
  const local = dir ? `${dir}/node_modules/${dep}` : null;
  if (local && packages[local]?.version != null) return packages[local].version;
  return packages[`node_modules/${dep}`]?.version ?? null;
}

/**
 * Compare every exact pin in every package file against the lockfile.
 *
 * `packageFiles` is `[{ dir, manifest }]` — `dir` is the lockfile-relative
 * directory (`''` for the root, `packages/webapp` for a workspace). Returns
 * `{ problems, checked }`; `problems` is non-empty when the caller should fail.
 *
 * Two independent reads have to agree, because Renovate can leave either one
 * behind: the lockfile's own copy of the workspace manifest
 * (`packages.<dir>.dependencies`, what `npm ci` compares) and the installed
 * package entry (`node_modules/<dep>.version`, what actually gets unpacked).
 */
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

/** One pin against the lockfile's two views of it. Returns a problem or null. */
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

/** Root manifest + every workspace manifest, in lockfile-relative form. */
export function readPackageFiles(repoRoot, rootManifest) {
  const files = [{ dir: '', manifest: rootManifest }];
  for (const dir of rootManifest?.workspaces ?? []) {
    // The workspaces field in this repo is an explicit list, not globs; a glob
    // would need expansion, so flag it rather than silently skipping packages.
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
