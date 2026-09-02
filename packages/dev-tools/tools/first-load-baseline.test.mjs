import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  dependencyDrift,
  discoverWorkspacePackages,
  linkNodeModules,
  materializeLinkedParents,
  prerequisiteWorkspaceBuilds,
  realignDriftedDependencies,
  resolveMergeBase,
} from './first-load-baseline.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('resolveMergeBase', () => {
  it('resolves HEAD against itself to HEAD', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    expect(resolveMergeBase(repoRoot, 'HEAD')).toBe(head);
  });

  it('returns null for an unknown ref instead of throwing', () => {
    // The degradation path: an unresolvable baseline must let the caller
    // fall back to ceiling-only checking, never crash the size gate.
    expect(resolveMergeBase(repoRoot, 'origin/definitely-not-a-branch-xyz')).toBeNull();
  });

  it('returns null for a ref that is not a commit', () => {
    expect(resolveMergeBase(repoRoot, '')).toBeNull();
  });
});

describe('prerequisiteWorkspaceBuilds', () => {
  it('reads the workspace build order out of the root postinstall', () => {
    // Single source of truth: postinstall is what produces these packages'
    // gitignored dist/ in a normal checkout, so the baseline must mirror it.
    expect(prerequisiteWorkspaceBuilds(repoRoot)).toEqual([
      '@slicc/shared-ts',
      '@slicc/cloud-core',
      '@ai-ecoverse/spoon',
      '@slicc/webcomponents',
      '@ai-ecoverse/cherry',
    ]);
  });

  it('does not capture the shell punctuation separating the commands', () => {
    for (const name of prerequisiteWorkspaceBuilds(repoRoot)) {
      expect(name).toMatch(/^@?[\w./-]+$/);
    }
  });

  it('returns an empty list when there is no package.json to read', () => {
    expect(prerequisiteWorkspaceBuilds('/definitely/not/a/repo')).toEqual([]);
  });
});

describe('discoverWorkspacePackages', () => {
  it('maps workspace package names to their directories', () => {
    const found = discoverWorkspacePackages(repoRoot);
    expect(found.get('@slicc/webcomponents')).toBe(resolve(repoRoot, 'packages/webcomponents'));
    expect(found.get('@ai-ecoverse/cherry')).toBe(resolve(repoRoot, 'packages/cherry'));
  });

  it('returns an empty map for a directory that is not a repo', () => {
    expect(discoverWorkspacePackages('/definitely/not/a/repo').size).toBe(0);
  });
});

describe('linkNodeModules', () => {
  let root;
  let repo;
  let tree;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'first-load-link-'));
    repo = join(root, 'repo');
    tree = join(root, 'tree');
    // A stand-in for the caller's installed dependency tree.
    mkdirSync(join(repo, 'node_modules/lodash'), { recursive: true });
    mkdirSync(join(repo, 'node_modules/@babel/core'), { recursive: true });
    mkdirSync(join(repo, 'node_modules/@slicc/webcomponents'), { recursive: true });
    mkdirSync(join(repo, 'node_modules/@slicc/shared-ts'), { recursive: true });
    // ...and the baseline worktree, with its own copy of the workspace source.
    mkdirSync(join(tree, 'packages/webcomponents'), { recursive: true });
    mkdirSync(join(tree, 'packages/shared-ts'), { recursive: true });
    writeFileSync(
      join(tree, 'package.json'),
      JSON.stringify({ workspaces: ['packages/webcomponents', 'packages/shared-ts'] })
    );
    writeFileSync(
      join(tree, 'packages/webcomponents/package.json'),
      JSON.stringify({ name: '@slicc/webcomponents' })
    );
    writeFileSync(
      join(tree, 'packages/shared-ts/package.json'),
      JSON.stringify({ name: '@slicc/shared-ts' })
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('points workspace packages at the worktree, not the caller checkout', () => {
    // The regression this guards: npm links workspaces as RELATIVE symlinks,
    // so borrowing the caller's node_modules wholesale made the baseline
    // build compile HEAD's workspace source — reporting a 0 kB delta for the
    // very change under test.
    linkNodeModules(repo, tree);
    expect(realpathSync(join(tree, 'node_modules/@slicc/webcomponents'))).toBe(
      realpathSync(join(tree, 'packages/webcomponents'))
    );
    expect(realpathSync(join(tree, 'node_modules/@slicc/shared-ts'))).toBe(
      realpathSync(join(tree, 'packages/shared-ts'))
    );
  });

  it('still borrows third-party dependencies from the caller', () => {
    linkNodeModules(repo, tree);
    expect(realpathSync(join(tree, 'node_modules/lodash'))).toBe(
      realpathSync(join(repo, 'node_modules/lodash'))
    );
  });

  it('keeps non-workspace members of a workspace scope pointing at the caller', () => {
    mkdirSync(join(repo, 'node_modules/@slicc/third-party-lookalike'), { recursive: true });
    linkNodeModules(repo, tree);
    expect(realpathSync(join(tree, 'node_modules/@slicc/third-party-lookalike'))).toBe(
      realpathSync(join(repo, 'node_modules/@slicc/third-party-lookalike'))
    );
  });

  it('links unrelated scopes across whole', () => {
    linkNodeModules(repo, tree);
    expect(realpathSync(join(tree, 'node_modules/@babel/core'))).toBe(
      realpathSync(join(repo, 'node_modules/@babel/core'))
    );
  });
});

describe('dependencyDrift', () => {
  let root;
  let repo;
  let tree;

  /** Write a minimal npm lockfile whose `packages` map is `entries`. */
  const lock = (dir, entries) =>
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ packages: entries }));

  const empty = { changed: [], missing: [], unrealignable: [] };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'first-load-drift-'));
    repo = join(root, 'repo');
    tree = join(root, 'tree');
    mkdirSync(repo, { recursive: true });
    mkdirSync(join(tree, 'packages/shared-ts'), { recursive: true });
    writeFileSync(
      join(tree, 'package.json'),
      JSON.stringify({ workspaces: ['packages/shared-ts'] })
    );
    writeFileSync(
      join(tree, 'packages/shared-ts/package.json'),
      JSON.stringify({ name: '@slicc/shared-ts' })
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reports nothing when the lockfiles agree', () => {
    const same = { '': {}, 'node_modules/lodash': { version: '4.17.21' } };
    lock(repo, same);
    lock(tree, same);
    expect(dependencyDrift(repo, tree)).toEqual(empty);
  });

  /**
   * The hole this whole mechanism exists to close: without it the baseline
   * builds the BUMPED version on both sides and the gate reports +0.0 kB for
   * exactly the change under test (magick-wasm 0.0.42 -> 0.0.43, PR #2744).
   */
  it('reports a hoisted package whose version was bumped', () => {
    lock(repo, { 'node_modules/@imagemagick/magick-wasm': { version: '0.0.43' } });
    lock(tree, { 'node_modules/@imagemagick/magick-wasm': { version: '0.0.42' } });
    const drift = dependencyDrift(repo, tree);
    expect(drift.missing).toEqual([]);
    expect(drift.unrealignable).toEqual([]);
    expect(drift.changed).toEqual([
      {
        path: 'node_modules/@imagemagick/magick-wasm',
        name: '@imagemagick/magick-wasm',
        from: '0.0.42',
        to: '0.0.43',
      },
    ]);
  });

  /**
   * npm records an alias under its INSTALL directory, not its registry name:
   * this repo has `node_modules/undici8` with `name: "undici"`. Deriving the
   * spec from the directory would ask the registry for `undici8` — a
   * different package that may well exist — so the lock entry's own name
   * wins.
   */
  it('fetches an aliased package under its registry name, not its directory', () => {
    lock(repo, { 'node_modules/undici8': { name: 'undici', version: '8.10.0' } });
    lock(tree, { 'node_modules/undici8': { name: 'undici', version: '8.9.0' } });
    expect(dependencyDrift(repo, tree).changed).toEqual([
      { path: 'node_modules/undici8', name: 'undici', from: '8.9.0', to: '8.10.0' },
    ]);
  });

  it('ignores packages the change adds', () => {
    // The base never had it, so its absence from the base build is exactly
    // what the delta should show.
    lock(repo, { 'node_modules/added': { version: '1.0.0' } });
    lock(tree, {});
    expect(dependencyDrift(repo, tree)).toEqual(empty);
  });

  /**
   * The asymmetric half: `linkNodeModules` mirrors HEAD, so a package the PR
   * removes is simply absent from the baseline worktree. If the base source
   * imports it, the base build fails and the whole gate reports no baseline.
   */
  it('reports a package the change removes as missing, not as an addition', () => {
    lock(repo, {});
    lock(tree, { 'node_modules/removed': { version: '1.0.0' } });
    const drift = dependencyDrift(repo, tree);
    expect(drift.changed).toEqual([]);
    expect(drift.missing).toEqual([
      { path: 'node_modules/removed', name: 'removed', from: '1.0.0', to: null },
    ]);
  });

  it('ignores the root project and workspace member entries', () => {
    lock(repo, { '': { version: '2.0.0' }, 'packages/shared-ts': { version: '2.0.0' } });
    lock(tree, { '': { version: '1.0.0' }, 'packages/shared-ts': { version: '1.0.0' } });
    expect(dependencyDrift(repo, tree)).toEqual(empty);
  });

  it('ignores a workspace package linked into node_modules', () => {
    // Its baseline is the worktree's own source, which linkNodeModules
    // already points at — the root version stamped here is irrelevant.
    lock(repo, { 'node_modules/@slicc/shared-ts': { version: '2.0.0' } });
    lock(tree, { 'node_modules/@slicc/shared-ts': { version: '1.0.0' } });
    expect(dependencyDrift(repo, tree).changed).toEqual([]);
  });

  /**
   * An un-hoisted copy is borrowed as part of its PARENT's symlink, so there
   * is no independent entry to swap. Reporting it as unrealignable is what
   * makes `measureAtCommit` refuse the baseline rather than measure the
   * wrong tree and call it +0.0 kB.
   */
  it('flags an un-hoisted nested copy as unrealignable', () => {
    lock(repo, { 'node_modules/a/node_modules/b': { version: '2.0.0' } });
    lock(tree, { 'node_modules/a/node_modules/b': { version: '1.0.0' } });
    const drift = dependencyDrift(repo, tree);
    expect(drift.changed).toEqual([]);
    expect(drift.unrealignable).toEqual([
      'node_modules/a/node_modules/b (1.0.0 -> 2.0.0, un-hoisted)',
    ]);
  });

  it('returns null when a lockfile cannot be read', () => {
    lock(repo, {});
    expect(dependencyDrift(repo, tree)).toBeNull();
  });

  /**
   * Guard against the alias hazard regressing on the real lockfile: every
   * entry whose install directory differs from its package name must be
   * reported under the package name.
   */
  it('uses the registry name for every alias in the real lockfile', () => {
    const packages = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')).packages;
    const aliases = Object.entries(packages).filter(
      ([path, entry]) =>
        path.startsWith('node_modules/') &&
        entry.name &&
        entry.name !== path.slice('node_modules/'.length)
    );
    expect(aliases.length).toBeGreaterThan(0);
    mkdirSync(join(tree, 'node_modules'), { recursive: true });
    lock(repo, Object.fromEntries(aliases));
    lock(
      tree,
      Object.fromEntries(
        aliases.map(([path, entry]) => [path, { ...entry, version: '0.0.0-base' }])
      )
    );
    const drift = dependencyDrift(repo, tree);
    expect(drift.changed.length).toBe(aliases.length);
    for (const entry of drift.changed) {
      expect(entry.name).not.toBe(entry.path.slice('node_modules/'.length));
      expect(entry.name).toBe(packages[entry.path].name);
    }
  });
});

describe('realignDriftedDependencies', () => {
  it('succeeds trivially when nothing drifted', () => {
    expect(realignDriftedDependencies('/nonexistent', { changed: [], missing: [] })).toBe(true);
  });

  /**
   * Past this point the PR is a lockfile refresh, not "a change plus its
   * dependency" — no per-package realignment would make the delta
   * attributable to one change, so refuse instead of spending minutes on it.
   */
  it('refuses a drift too large to be a single change', () => {
    const notes = [];
    const changed = Array.from({ length: 26 }, (_, i) => ({
      path: `node_modules/p${i}`,
      name: `p${i}`,
      from: '1.0.0',
      to: '2.0.0',
    }));
    expect(
      realignDriftedDependencies('/nonexistent', { changed, missing: [] }, (m) => notes.push(m))
    ).toBe(false);
    expect(notes.join(' ')).toMatch(/26 dependencies differ/);
  });

  it('counts removals toward the drift limit', () => {
    const missing = Array.from({ length: 26 }, (_, i) => ({
      path: `node_modules/p${i}`,
      name: `p${i}`,
      from: '1.0.0',
      to: null,
    }));
    expect(realignDriftedDependencies('/nonexistent', { changed: [], missing })).toBe(false);
  });

  /**
   * A version bump that cannot be fetched must abort: measuring the base at
   * HEAD's version is the silently-wrong number this exists to fix.
   */
  it('aborts when a bumped package cannot be fetched', () => {
    const notes = [];
    const changed = [
      {
        path: 'node_modules/@slicc/definitely-not-published-xyz',
        name: '@slicc/definitely-not-published-xyz',
        from: '1.0.0',
        to: '2.0.0',
      },
    ];
    expect(
      realignDriftedDependencies(repoRoot, { changed, missing: [] }, (m) => notes.push(m))
    ).toBe(false);
    expect(notes.join(' ')).toMatch(/could not fetch/);
  }, 60_000);

  /**
   * A removal that cannot be fetched must NOT abort: aborting would newly
   * fail every PR that drops an already-unused dependency. The base build
   * settles it — it fails on its own if the package was actually needed.
   */
  it('continues when a removed package cannot be fetched', () => {
    const notes = [];
    const missing = [
      {
        path: 'node_modules/@slicc/definitely-not-published-xyz',
        name: '@slicc/definitely-not-published-xyz',
        from: '1.0.0',
        to: null,
      },
    ];
    expect(
      realignDriftedDependencies(repoRoot, { changed: [], missing }, (m) => notes.push(m))
    ).toBe(true);
    expect(notes.join(' ')).toMatch(/could not restore/);
  }, 60_000);
});

describe('materializeLinkedParents', () => {
  let root;
  let repo;
  let tree;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'first-load-materialize-'));
    repo = join(root, 'repo');
    tree = join(root, 'tree');
    mkdirSync(join(repo, 'node_modules/@scope/target'), { recursive: true });
    mkdirSync(join(repo, 'node_modules/@scope/sibling'), { recursive: true });
    writeFileSync(join(repo, 'node_modules/@scope/target/marker.txt'), 'caller');
    writeFileSync(join(repo, 'node_modules/@scope/sibling/marker.txt'), 'caller');
    mkdirSync(join(tree, 'node_modules'), { recursive: true });
    // How linkNodeModules mirrors a scope with no workspace member: ONE
    // symlink for the whole @scope directory.
    symlinkSync(join(repo, 'node_modules/@scope'), join(tree, 'node_modules/@scope'), 'dir');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /**
   * The near-miss this guards: `tree/node_modules/@scope/target` resolves
   * straight through the scope symlink into the CALLER's node_modules, so
   * replacing it in place would have overwritten the developer's (or the CI
   * job's) real install with an older version.
   */
  it('splits a symlinked scope so a member can be replaced locally', () => {
    materializeLinkedParents(join(tree, 'node_modules'), '@scope/target');
    expect(lstatSync(join(tree, 'node_modules/@scope')).isSymbolicLink()).toBe(false);

    rmSync(join(tree, 'node_modules/@scope/target'), { force: true, recursive: true });
    mkdirSync(join(tree, 'node_modules/@scope/target'));
    writeFileSync(join(tree, 'node_modules/@scope/target/marker.txt'), 'baseline');

    expect(readFileSync(join(repo, 'node_modules/@scope/target/marker.txt'), 'utf8')).toBe(
      'caller'
    );
    expect(readFileSync(join(tree, 'node_modules/@scope/target/marker.txt'), 'utf8')).toBe(
      'baseline'
    );
  });

  it('keeps every other member of the scope borrowed from the caller', () => {
    materializeLinkedParents(join(tree, 'node_modules'), '@scope/target');
    expect(readdirSync(join(tree, 'node_modules/@scope')).sort()).toEqual(['sibling', 'target']);
    expect(realpathSync(join(tree, 'node_modules/@scope/sibling'))).toBe(
      realpathSync(join(repo, 'node_modules/@scope/sibling'))
    );
  });

  it('is a no-op for an unscoped package with no symlinked ancestor', () => {
    mkdirSync(join(tree, 'node_modules/plain'), { recursive: true });
    materializeLinkedParents(join(tree, 'node_modules'), 'plain');
    expect(lstatSync(join(tree, 'node_modules/plain')).isDirectory()).toBe(true);
  });
});
