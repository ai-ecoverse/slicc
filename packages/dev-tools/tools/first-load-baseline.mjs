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
 * repo root and the base build only needs them to resolve.
 *
 * DEPENDENCY DRIFT is the exception, and it used to be a hole. Borrowing
 * HEAD's `node_modules` wholesale means a PR that bumps a dependency builds
 * BOTH sides against the NEW version, so the gate reports +0.0 kB for
 * exactly the change under test. This was written off as an acceptable
 * trade on the grounds that dependency PRs are "where a human should be
 * reading the size report" — but Renovate PRs automerge, so no human reads
 * anything, and the only backstop was the absolute ceiling. It failed in
 * production: `@imagemagick/magick-wasm` 0.0.42 -> 0.0.43 (PR #2744) added
 * +103 kB to the worker eager graph and the delta gate reported +0.0 kB.
 * Only 87 kB of ceiling headroom caught it, by luck.
 *
 * So drifted packages are now REALIGNED: every hoisted `node_modules/<name>`
 * whose version differs between the base lockfile and HEAD's is replaced in
 * the baseline worktree with the BASE version, fetched via `npm pack`. The
 * delta then measures the dependency change instead of hiding it. When the
 * drift cannot be realigned — an un-hoisted nested path, a registry failure,
 * or a lockfile refresh too large to be one change — the baseline is
 * reported as unmeasurable rather than quietly wrong, which a CI
 * `pull_request` run treats as a failure (see `check-first-load-size.mjs`).
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
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
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

/**
 * A hoisted dependency the baseline worktree needs put back.
 *
 * `name` is the REGISTRY name to fetch, which is not always the install
 * directory: npm records an alias as `node_modules/undici8` with
 * `name: "undici"`. `to` is null when HEAD removed the package.
 *
 * @typedef {{ path: string, name: string, from: string, to: string | null }} Drift
 */

/**
 * Read a `package-lock.json`'s `packages` map, or null when unreadable.
 *
 * @param {string} tree
 * @returns {Record<string, {version?: string, name?: string}> | null}
 */
function readLockPackages(tree) {
  try {
    return JSON.parse(readFileSync(join(tree, 'package-lock.json'), 'utf8')).packages ?? null;
  } catch {
    return null;
  }
}

/**
 * Dependencies the baseline worktree would otherwise get wrong, split by how
 * badly a failure to fix them matters.
 *
 * `linkNodeModules` mirrors HEAD's `node_modules`, so the base build sees
 * HEAD's dependency tree. Two cases need correcting, and they are NOT
 * symmetric:
 *
 * - `changed` — the version differs. The baseline would measure the bump at
 *   its NEW size on both sides and report +0.0 kB, so this MUST be fixed or
 *   the number is a lie. Fetch failure is fatal.
 * - `missing` — the PR removed the package, so HEAD's tree has no copy for
 *   the base build to resolve. Best effort: if the base source imports it the
 *   build fails on its own (and the caller reports no baseline), and if it
 *   does not, nothing was needed. Fetch failure is therefore NOT fatal.
 *
 * Packages ADDED by the PR are correctly ignored — the base never had them,
 * and their absence from the base build is exactly what the delta should
 * show. (An earlier version of this lumped additions and removals together
 * as "present on only one side"; only the addition half of that is right.)
 *
 * `unrealignable` collects drift with nowhere to put it — un-hoisted nested
 * copies like `node_modules/a/node_modules/b`, which `linkNodeModules`
 * borrows as part of their parent — so the caller can refuse to report a
 * delta it cannot trust instead of silently measuring the wrong tree.
 *
 * @param {string} repoRoot
 * @param {string} tree base checkout
 * @returns {{ changed: Drift[], missing: Drift[], unrealignable: string[] } | null}
 *   null when either lockfile is unreadable
 */
export function dependencyDrift(repoRoot, tree) {
  const head = readLockPackages(repoRoot);
  const base = readLockPackages(tree);
  if (!head || !base) return null;

  const workspaces = new Set(discoverWorkspacePackages(tree).keys());
  const changed = [];
  const missing = [];
  const unrealignable = [];
  for (const [path, entry] of Object.entries(base)) {
    // `""` is the root project; `packages/*` entries are workspace members,
    // which the worktree already supplies from its own source.
    if (!path.startsWith('node_modules/')) continue;
    const from = entry?.version;
    if (!from) continue;
    const to = head[path]?.version ?? null;
    if (to === from) continue;
    const installName = path.slice('node_modules/'.length);
    if (installName.includes('/node_modules/')) {
      unrealignable.push(`${path} (${from} -> ${to ?? 'removed'}, un-hoisted)`);
      continue;
    }
    // A workspace package linked into node_modules carries the root version;
    // the worktree's own source is already the right baseline for it.
    if (workspaces.has(installName)) continue;
    // An aliased install directory is not the registry name: npm records
    // `node_modules/undici8` with `name: "undici"`. Fetching `undici8` would
    // request a DIFFERENT package that may well exist on the registry, so
    // trust the lock entry's own name over the directory it landed in.
    const drift = { path, name: entry.name ?? installName, from, to };
    (to === null ? missing : changed).push(drift);
  }
  return { changed, missing, unrealignable };
}

/**
 * Turn every symlinked ANCESTOR of `relPath` under `nodeModules` into a real
 * directory of symlinks to the original target's children.
 *
 * `linkNodeModules` mirrors a scope with no workspace member as a single
 * symlink for the whole `@scope` directory. That is fine for reading, but it
 * means `node_modules/@scope/pkg` inside the worktree is really a path into
 * the CALLER's `node_modules` — replacing `pkg` there would mutate the
 * developer's (or the CI job's) actual install. Splitting the scope into a
 * real directory of per-child symlinks keeps every other member borrowed
 * while making the one we need to replace local to the worktree.
 *
 * @param {string} nodeModules the worktree's `node_modules`
 * @param {string} relPath e.g. `@imagemagick/magick-wasm`
 *
 * Exported for tests — the correctness that matters here (never writing
 * through a borrowed symlink) is not observable from `measureAtCommit`.
 */
export function materializeLinkedParents(nodeModules, relPath) {
  const segments = relPath.split('/');
  let current = nodeModules;
  // Ancestors only — the final segment is the entry being replaced.
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    // A package HEAD removed may have taken its whole scope with it, so the
    // ancestor can be absent rather than borrowed.
    if (!stat) {
      mkdirSync(current, { recursive: true });
      continue;
    }
    if (!stat.isSymbolicLink()) continue;
    const target = realpathSync(current);
    rmSync(current, { force: true });
    mkdirSync(current, { recursive: true });
    for (const child of readdirSync(target)) {
      symlinkSync(join(target, child), join(current, child), 'dir');
    }
  }
}

/**
 * More drifted packages than any single change plausibly introduces. Past
 * this the PR is a lockfile refresh, not "a change plus its dependency", and
 * realigning package by package is both slow and beside the point — the
 * honest answer is that the delta is not attributable.
 */
const MAX_REALIGNABLE_DRIFT = 25;

/**
 * Put one package's BASE version into the baseline worktree.
 *
 * @param {string} tree
 * @param {string} staging scratch dir for tarballs
 * @param {Drift} drift
 * @param {(m: string) => void} log
 * @returns {boolean} true when the package is in place
 */
function installBaseVersion(tree, staging, { path, name, from }, log) {
  const spec = `${name}@${from}`;
  const packed = run(
    'npm',
    ['pack', spec, '--pack-destination', staging, '--silent', '--no-audit', '--no-fund'],
    { cwd: tree }
  );
  const tarball = (packed ?? '').split('\n').pop()?.trim();
  if (!tarball) {
    log(`could not fetch ${spec} for the baseline (npm pack failed)`);
    return false;
  }
  const unpacked = join(staging, `unpacked-${path.replace(/[@/]/g, '_')}`);
  mkdirSync(unpacked, { recursive: true });
  if (run('tar', ['-xzf', join(staging, tarball), '-C', unpacked], { cwd: tree }) === null) {
    log(`could not unpack ${spec} for the baseline`);
    return false;
  }
  const dest = join(tree, path);
  // A scope with no workspace member is mirrored as ONE symlink for the
  // whole scope dir, so `tree/node_modules/@scope/pkg` resolves straight
  // through into HEAD's real `node_modules`. Writing there would corrupt the
  // caller's install, so split the scope open first.
  materializeLinkedParents(join(tree, 'node_modules'), path.slice('node_modules/'.length));
  // Now `dest` is the worktree's own symlink (or absent) — remove the LINK,
  // not its target, and drop the base version in its place.
  rmSync(dest, { force: true, recursive: true });
  renameSync(join(unpacked, 'package'), dest);
  return true;
}

/**
 * Give the baseline worktree the dependency tree the BASE commit expects.
 *
 * The worktree starts as a mirror of HEAD's `node_modules` (see
 * `linkNodeModules`), so two corrections are needed, with deliberately
 * different failure handling:
 *
 * - `changed` (a version bump) is REQUIRED. Leaving it is precisely the
 *   silently-wrong +0.0 kB this exists to fix, so a single failed fetch
 *   aborts — a partially realigned baseline is no more trustworthy than an
 *   unrealigned one.
 * - `missing` (removed by the PR) is BEST EFFORT. A failed fetch is not
 *   fatal because the build settles it: if the base source imports the
 *   package the build fails and the caller reports no baseline, and if it
 *   does not, nothing was needed. Aborting here would newly fail PRs that
 *   merely drop an already-unused dependency.
 *
 * Transitive dependencies are NOT realigned — they stay borrowed from HEAD.
 * That is a deliberate approximation: what the gate needs is the bundled
 * bytes of the package that changed, and the alternative (a full `npm ci`
 * per gate run) costs minutes on every dependency PR.
 *
 * @param {string} tree
 * @param {{changed: Drift[], missing: Drift[]}} drift
 * @param {(m: string) => void} log
 * @returns {boolean} false when a REQUIRED realignment could not be made
 */
export function realignDriftedDependencies(tree, drift, log = () => {}) {
  const changed = drift.changed ?? [];
  const missing = drift.missing ?? [];
  const total = changed.length + missing.length;
  if (total === 0) return true;
  if (total > MAX_REALIGNABLE_DRIFT) {
    log(
      `${total} dependencies differ from the base lockfile (limit ${MAX_REALIGNABLE_DRIFT}) — ` +
        `too many to attribute a size delta to one change`
    );
    return false;
  }
  const staging = mkdtempSync(join(tmpdir(), 'slicc-first-load-pack-'));
  try {
    for (const entry of changed) {
      if (!installBaseVersion(tree, staging, entry, log)) return false;
      log(`realigned ${entry.name} to the base version ${entry.from} (HEAD has ${entry.to})`);
    }
    for (const entry of missing) {
      if (installBaseVersion(tree, staging, entry, log)) {
        log(`restored ${entry.name}@${entry.from}, which this change removes`);
      } else {
        log(
          `could not restore ${entry.name}@${entry.from} (removed by this change); continuing — ` +
            `the base build fails on its own if it actually needed it`
        );
      }
    }
    return true;
  } finally {
    rmSync(staging, { recursive: true, force: true });
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
 * `measure` returned, or null when the checkout or build failed, or when
 * dependency drift could not be realigned (see `dependencyDrift`) — a
 * baseline built against the wrong dependency versions is worse than no
 * baseline, because it reports a confident +0.0 kB.
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
    // The mirror above borrows HEAD's dependencies, which would measure a
    // dependency bump at its NEW version on both sides — a +0.0 kB delta for
    // exactly the change under test. Put the base versions back, or say the
    // baseline is unmeasurable (see the header).
    const drift = dependencyDrift(repoRoot, tree);
    if (!drift) {
      log(`could not read the lockfiles to check for dependency drift at ${sha}`);
      return null;
    }
    if (drift.unrealignable.length > 0) {
      log(
        `dependencies drifted at paths the baseline cannot realign, so its size is not ` +
          `comparable: ${drift.unrealignable.join(', ')}`
      );
      return null;
    }
    if (!realignDriftedDependencies(tree, drift, log)) return null;
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
