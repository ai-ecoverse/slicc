import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  discoverWorkspacePackages,
  linkNodeModules,
  prerequisiteWorkspaceBuilds,
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
