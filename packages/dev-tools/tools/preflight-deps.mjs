#!/usr/bin/env node
/**
 * Pre-flight check that this workspace's own node_modules has been
 * installed before running typecheck/test scripts.
 *
 * Why this exists:
 * Node's module resolution walks UP the directory tree, so when this
 * repo is cloned as a sibling of another slicc checkout (or worktree),
 * `tsc` will silently resolve dependencies from a parent directory's
 * `node_modules` even when the local one is missing or out of date.
 * That can produce TS errors that vanish after `npm ci` — confusing
 * everyone who hits it. This script fails fast with a clear message.
 *
 * The check is intentionally cheap (two `fs.access` calls) and side
 * effect free; it is wired up via `pretypecheck` and `pretest` npm
 * scripts so contributors hit it the moment they run a verification
 * command in a fresh worktree.
 */
import { accessSync, constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), '..', '..', '..');

const sentinels = [
  // Created by both `npm ci` and `npm install`.
  resolve(repoRoot, 'node_modules', '.package-lock.json'),
  // A workspace devDependency we always need locally; its absence means
  // an interrupted install or a stale parent-hoisted install.
  resolve(repoRoot, 'node_modules', 'typescript', 'package.json'),
];

const missing = sentinels.filter((p) => {
  try {
    accessSync(p, constants.F_OK);
    return false;
  } catch {
    return true;
  }
});

if (missing.length > 0) {
  const list = missing.map((p) => `  - ${p}`).join('\n');
  process.stderr.write(
    [
      '',
      'preflight-deps: this workspace has no local node_modules.',
      '',
      'Missing sentinel(s):',
      list,
      '',
      'Run `npm ci` (or `npm install`) at the repo root before running',
      'typecheck/test. Otherwise tsc may silently resolve packages from a',
      'parent directory and surface fake errors that vanish after install.',
      '',
    ].join('\n')
  );
  process.exit(1);
}
