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
 * has many). Third-party dependencies are linked in from the caller's
 * `node_modules` rather than installed, since npm workspaces hoist to the
 * repo root and the base build only needs them to resolve. A base whose
 * lockfile differs from HEAD is therefore measured against HEAD's installed
 * dependencies; that is a deliberate trade (a full `npm ci` per gate run is
 * not worth it) and it only matters for PRs that change dependencies, which
 * are exactly the PRs where a human should be reading the size report.
 *
 * WORKSPACE packages are a different matter and must NOT be borrowed from
 * HEAD. npm links them into `node_modules/@scope/name` as RELATIVE symlinks
 * (`../../packages/webcomponents`), which resolve from the link's physical
 * location — so naively linking the whole `node_modules` in would make the
 * baseline build compile HEAD's `packages/webcomponents`, not the base's.
 * The webapp imports `@slicc/webcomponents` by package name, and the
 * `bundle-size` job runs on webcomponents changes, so that would silently
 * report a zero delta for exactly the change under test. `linkNodeModules`
 * therefore mirrors the dependency tree entry by entry and re-points every
 * workspace package at the worktree's own copy.
 *
 * Cost: the webapp build is ~2 s locally and byte-for-byte deterministic
 * for a given tree, so the baseline adds one short build and contributes
 * zero measurement noise.
 *
 * IO lives here; the pure grading logic is in `first-load-size-lib.mjs`.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Map every workspace package name to its directory inside `tree`.
 *
 * Read from the root `package.json` `workspaces` list rather than globbed,
 * so a package that is present on disk but not a workspace member is not
 * mistaken for one.
 *
 * @param {string} tree
 * @returns {Map<string, string>} package name -> absolute dir in `tree`
 */
export function discoverWorkspacePackages(tree) {
  const packages = new Map();
  let roots;
  try {
    roots = JSON.parse(readFileSync(join(tree, 'package.json'), 'utf8')).workspaces ?? [];
  } catch {
    return packages;
  }
  for (const rel of roots) {
    const dir = join(tree, rel);
    try {
      const name = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name;
      if (name) packages.set(name, dir);
    } catch {
      // A workspace listed but not checked out at this commit — skip it.
    }
  }
  return packages;
}

/**
 * Build `tree/node_modules` as a mirror of `repoRoot`'s, with every
 * workspace package re-pointed at the worktree's own copy.
 *
 * Third-party entries are symlinked straight across (cheap — no copying).
 * Scopes that contain a workspace package are recreated as real directories
 * so their members can be redirected individually; every other scope is
 * linked whole.
 *
 * @param {string} repoRoot
 * @param {string} tree
 */
export function linkNodeModules(repoRoot, tree) {
  const realNm = resolve(repoRoot, 'node_modules');
  const treeNm = join(tree, 'node_modules');
  const workspaces = discoverWorkspacePackages(tree);
  const scopes = new Set(
    [...workspaces.keys()].filter((n) => n.startsWith('@')).map((n) => n.split('/')[0])
  );

  mkdirSync(treeNm, { recursive: true });
  for (const entry of readdirSync(realNm)) {
    if (scopes.has(entry)) continue; // rebuilt below, member by member
    const target = workspaces.get(entry) ?? join(realNm, entry);
    symlinkSync(target, join(treeNm, entry), 'dir');
  }
  for (const scope of scopes) {
    const realScope = join(realNm, scope);
    if (!existsSync(realScope)) continue;
    mkdirSync(join(treeNm, scope), { recursive: true });
    for (const child of readdirSync(realScope)) {
      const target = workspaces.get(`${scope}/${child}`) ?? join(realScope, child);
      symlinkSync(target, join(treeNm, scope, child), 'dir');
    }
  }
  // Un-hoisted per-package trees (version conflicts) live beside the package.
  for (const dir of workspaces.values()) {
    const rel = dir.slice(tree.length + 1);
    const realPkgNm = resolve(repoRoot, rel, 'node_modules');
    if (existsSync(realPkgNm)) symlinkSync(realPkgNm, join(dir, 'node_modules'), 'dir');
  }
}

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
 * Workspace packages that must be built before the webapp build can resolve
 * them, in order.
 *
 * Derived from the root `postinstall` rather than hardcoded, so the list
 * cannot drift: that script is what produces these packages' `dist/` in a
 * normal checkout, and `dist/` is gitignored, so a fresh worktree has none.
 * (`@slicc/shared-ts` resolves to `./dist/index.js`; without this the
 * baseline build fails on `Could not resolve "@slicc/shared-ts"`.)
 *
 * Building them from the worktree's own source is also what makes the delta
 * honest — borrowing HEAD's build output would compile HEAD's workspace
 * source into the baseline and mask the very change under test.
 *
 * @param {string} tree
 * @returns {string[]} workspace names, in postinstall order
 */
export function prerequisiteWorkspaceBuilds(tree) {
  let postinstall;
  try {
    postinstall = JSON.parse(readFileSync(join(tree, 'package.json'), 'utf8')).scripts?.postinstall;
  } catch {
    return [];
  }
  if (typeof postinstall !== 'string') return [];
  const names = [];
  // Package-name characters only, so shell punctuation (`;`, `&&`) is not captured.
  const re = /npm run build -w (@?[\w./-]+)/g;
  let m;
  while ((m = re.exec(postinstall)) !== null) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
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
    linkNodeModules(repoRoot, tree);
    const env = { ...process.env, NODE_OPTIONS: '--max-old-space-size=6144' };
    const npmRun = (args) => spawnSync('npm', args, { cwd: tree, encoding: 'utf8', env });
    for (const workspace of prerequisiteWorkspaceBuilds(tree)) {
      const pre = npmRun(['run', 'build', '-w', workspace]);
      if (pre.status !== 0) {
        log(
          `baseline prerequisite ${workspace} failed at ${sha}:\n${(pre.stderr ?? '').slice(-1500)}`
        );
        return null;
      }
    }
    const built = npmRun(['run', 'build', '-w', '@slicc/webapp']);
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
