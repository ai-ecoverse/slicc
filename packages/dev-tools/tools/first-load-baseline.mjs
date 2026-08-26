/**
 * Merge-base baseline for the first-load gate.
 *
 * The first-load gate is relative: a change is judged by how much it adds
 * to the eager import closure versus the commit it branches from, not
 * against an absolute number someone wrote down once. That requires a
 * second measurement, so this module builds the merge-base in a throwaway
 * detached git worktree and measures its `dist/ui`.
 *
 * Why a worktree rather than checking the base out in place: the caller's
 * working tree is never touched, so this is safe to run locally on a dirty
 * tree and safe to run concurrently with other agents/worktrees (the repo
 * has many). `node_modules` is symlinked in rather than installed — npm
 * workspaces hoist to the repo root, and the base build only needs the
 * dependency tree to resolve. A base whose lockfile differs from HEAD is
 * therefore measured against HEAD's installed dependencies; that is a
 * deliberate trade (a full `npm ci` per gate run is not worth it) and it
 * only matters for PRs that change dependencies, which are exactly the PRs
 * where a human should be reading the size report anyway.
 *
 * Cost: the webapp build is ~2 s locally and byte-for-byte deterministic
 * for a given tree, so the baseline adds one short build and contributes
 * zero measurement noise.
 *
 * IO lives here; the pure grading logic is in `first-load-size-lib.mjs`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Run a command, returning trimmed stdout, or null when it fails. */
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (res.status !== 0) return null;
  return (res.stdout ?? '').trim();
}

/**
 * Resolve the merge base between HEAD and `ref`.
 *
 * Returns null when the ref is unknown or the clone is too shallow to
 * contain a common ancestor — both of which are recoverable (the caller
 * degrades to ceiling-only) rather than fatal.
 *
 * @param {string} repoRoot
 * @param {string} ref e.g. `origin/main`
 * @returns {string | null} commit SHA
 */
export function resolveMergeBase(repoRoot, ref) {
  const opts = { cwd: repoRoot };
  if (run('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], opts) === null) {
    return null;
  }
  return run('git', ['merge-base', 'HEAD', ref], opts);
}

/**
 * Build `sha` in a throwaway worktree and hand its `dist/ui` to `measure`.
 *
 * Always removes the worktree, including on failure. Returns whatever
 * `measure` returned, or null when the checkout or build failed.
 *
 * @param {{repoRoot: string, sha: string, measure: (uiDir: string) => object, log?: (m: string) => void}} args
 * @returns {object | null}
 */
export function measureAtCommit({ repoRoot, sha, measure, log = () => {} }) {
  const tmp = mkdtempSync(join(tmpdir(), 'slicc-first-load-'));
  const tree = join(tmp, 'tree');
  try {
    if (run('git', ['worktree', 'add', '--detach', tree, sha], { cwd: repoRoot }) === null) {
      log(`could not create a worktree at ${sha}`);
      return null;
    }
    // Workspaces hoist to the root, so one symlink covers the whole build.
    symlinkSync(resolve(repoRoot, 'node_modules'), join(tree, 'node_modules'), 'dir');
    const built = spawnSync('npm', ['run', 'build', '-w', '@slicc/webapp'], {
      cwd: tree,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=6144' },
    });
    if (built.status !== 0) {
      log(`baseline build failed at ${sha}:\n${(built.stderr ?? '').slice(-2000)}`);
      return null;
    }
    const uiDir = join(tree, 'dist/ui');
    if (!existsSync(uiDir)) {
      log(`baseline build at ${sha} produced no dist/ui`);
      return null;
    }
    return measure(uiDir);
  } finally {
    run('git', ['worktree', 'remove', '--force', tree], { cwd: repoRoot });
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Measure the merge-base of HEAD and `ref`.
 *
 * @param {{repoRoot: string, ref: string, measure: (uiDir: string) => object, log?: (m: string) => void}} args
 * @returns {{sha: string, bytes: object} | null}
 */
export function measureMergeBase({ repoRoot, ref, measure, log = () => {} }) {
  const sha = resolveMergeBase(repoRoot, ref);
  if (!sha) {
    log(`could not resolve a merge base with "${ref}" (unknown ref, or a shallow clone)`);
    return null;
  }
  const bytes = measureAtCommit({ repoRoot, sha, measure, log });
  return bytes ? { sha, bytes } : null;
}
