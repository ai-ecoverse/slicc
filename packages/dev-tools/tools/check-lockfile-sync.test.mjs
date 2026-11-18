import { describe, expect, it } from 'vitest';
import {
  checkLockfileSync,
  exactOverridePins,
  exactVersion,
  isOverrideVersionSelectorKey,
  overrideSatisfied,
  resolvedVersion,
} from './check-lockfile-sync.mjs';

/** Minimal npm lockfile v3 shape: workspace nodes + installed package nodes. */
function lockOf({ root = {}, workspaces = {}, installed = {} } = {}) {
  const packages = { '': root };
  for (const [dir, node] of Object.entries(workspaces)) packages[dir] = node;
  for (const [key, version] of Object.entries(installed)) packages[key] = { version };
  return { packages };
}

describe('exactVersion', () => {
  it('accepts bare exact versions, including prereleases', () => {
    expect(exactVersion('1.2.3')).toBe('1.2.3');
    expect(exactVersion('2.0.0-rc.1')).toBe('2.0.0-rc.1');
  });

  it('resolves the pinned version out of a registry alias', () => {
    expect(exactVersion('npm:typescript@6.0.3')).toBe('6.0.3');
    expect(exactVersion('npm:@scope/pkg@1.0.0')).toBe('1.0.0');
  });

  it('ignores ranges, workspace links and non-strings', () => {
    for (const spec of ['^1.2.3', '~1.2.3', '*', 'workspace:*', 'file:../x', undefined, 3]) {
      expect(exactVersion(spec)).toBeNull();
    }
  });
});

describe('resolvedVersion', () => {
  it('prefers the package-local copy over the hoisted one', () => {
    const lock = lockOf({
      installed: { 'node_modules/dep': '1.0.0', 'packages/a/node_modules/dep': '2.0.0' },
    });
    expect(resolvedVersion(lock, 'packages/a', 'dep')).toBe('2.0.0');
    expect(resolvedVersion(lock, 'packages/b', 'dep')).toBe('1.0.0');
    expect(resolvedVersion(lock, '', 'dep')).toBe('1.0.0');
  });

  it('returns null when the dependency is absent', () => {
    expect(resolvedVersion(lockOf(), '', 'dep')).toBeNull();
  });
});

describe('checkLockfileSync', () => {
  it('passes when every exact pin matches', () => {
    const { problems, checked } = checkLockfileSync({
      packageFiles: [
        { dir: '', manifest: { devDependencies: { tsx: '4.23.13' } } },
        { dir: 'packages/webapp', manifest: { dependencies: { lucide: '1.38.0' } } },
      ],
      lock: lockOf({
        root: { devDependencies: { tsx: '4.23.13' } },
        workspaces: { 'packages/webapp': { dependencies: { lucide: '1.38.0' } } },
        installed: { 'node_modules/tsx': '4.23.13', 'node_modules/lucide': '1.38.0' },
      }),
    });
    expect(problems).toEqual([]);
    expect(checked).toBe(2);
  });

  // The Renovate failure this guard exists for: a package.json-only bump
  // (PR #2979 bumped lucide in two workspaces and shipped no lockfile).
  it('flags a package.json-only Renovate bump', () => {
    const { problems } = checkLockfileSync({
      packageFiles: [{ dir: 'packages/webapp', manifest: { dependencies: { lucide: '1.39.0' } } }],
      lock: lockOf({
        workspaces: { 'packages/webapp': { dependencies: { lucide: '1.38.0' } } },
        installed: { 'node_modules/lucide': '1.38.0' },
      }),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('declares lucide@1.39.0');
    expect(problems[0]).toContain('records lucide@1.38.0');
  });

  it('flags a lockfile whose manifest copy is current but whose install is stale', () => {
    const { problems } = checkLockfileSync({
      packageFiles: [{ dir: '', manifest: { dependencies: { dep: '2.0.0' } } }],
      lock: lockOf({
        root: { dependencies: { dep: '2.0.0' } },
        installed: { 'node_modules/dep': '1.0.0' },
      }),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('installs dep@1.0.0');
  });

  it('flags a dependency missing from the lockfile entirely', () => {
    const { problems } = checkLockfileSync({
      packageFiles: [{ dir: '', manifest: { dependencies: { dep: '1.0.0' } } }],
      lock: lockOf({ root: { dependencies: { dep: '1.0.0' } } }),
    });
    expect(problems[0]).toContain('has no package-lock.json entry');
  });

  it('flags a workspace the lockfile does not know', () => {
    const { problems } = checkLockfileSync({
      packageFiles: [{ dir: 'packages/new', manifest: { dependencies: { dep: '1.0.0' } } }],
      lock: lockOf(),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('does not know this workspace');
  });

  it('ignores ranged and workspace-linked specs', () => {
    const { problems, checked } = checkLockfileSync({
      packageFiles: [
        {
          dir: 'packages/webapp',
          manifest: { dependencies: { '@slicc/shared-ts': '*', marked: '^18.0.0' } },
        },
      ],
      lock: lockOf({ workspaces: { 'packages/webapp': {} } }),
    });
    expect(problems).toEqual([]);
    expect(checked).toBe(0);
  });

  it('compares an aliased pin against the aliased target version', () => {
    const lock = lockOf({
      root: { devDependencies: { 'typescript-js': 'npm:typescript@6.0.3' } },
      installed: { 'node_modules/typescript-js': '6.0.3' },
    });
    expect(
      checkLockfileSync({
        packageFiles: [
          { dir: '', manifest: { devDependencies: { 'typescript-js': 'npm:typescript@6.0.3' } } },
        ],
        lock,
      }).problems
    ).toEqual([]);
    expect(
      checkLockfileSync({
        packageFiles: [
          { dir: '', manifest: { devDependencies: { 'typescript-js': 'npm:typescript@6.1.0' } } },
        ],
        lock,
      }).problems
    ).toHaveLength(1);
  });

  // Renovate override-alias drop (#4293 / #4178 / #4119): package.json bumps
  // `e2b.undici8` to `npm:undici@X` and deletes `node_modules/undici8` from the
  // lock. Exact dependency pins still match, so the old pin-only guard said
  // "in sync" while `npm ci` failed with Missing: undici8@X from lock file.
  it('flags a missing override alias lock entry', () => {
    const { problems, checked } = checkLockfileSync({
      packageFiles: [{ dir: '', manifest: {} }],
      lock: lockOf({ root: {} }),
      overrides: { e2b: { undici8: 'npm:undici@8.12.4' } },
    });
    expect(checked).toBe(1);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('overrides');
    expect(problems[0]).toContain('undici8');
    expect(problems[0]).toContain('no matching package-lock.json entry');
  });

  it('passes when an override alias is present at the pinned version', () => {
    const { problems } = checkLockfileSync({
      packageFiles: [{ dir: '', manifest: {} }],
      lock: lockOf({ root: {}, installed: { 'node_modules/undici8': '8.12.4' } }),
      overrides: { e2b: { undici8: 'npm:undici@8.12.4' } },
    });
    expect(problems).toEqual([]);
  });

  it('flags an override pin whose lock entry is the wrong version', () => {
    const { problems } = checkLockfileSync({
      packageFiles: [{ dir: '', manifest: {} }],
      lock: lockOf({ root: {}, installed: { 'node_modules/undici': '7.30.1' } }),
      overrides: { 'guarded-fetch': { undici: '7.30.2' } },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('undici@7.30.2');
  });

  it('accepts a nested lock entry for an override pin', () => {
    const { problems } = checkLockfileSync({
      packageFiles: [{ dir: '', manifest: {} }],
      lock: lockOf({
        root: {},
        installed: { 'node_modules/@actions/http-client/node_modules/undici': '6.29.1' },
      }),
      overrides: { '@actions/http-client': { undici: '6.29.1' } },
    });
    expect(problems).toEqual([]);
  });
});

describe('isOverrideVersionSelectorKey', () => {
  it('detects unscoped and scoped version-selector remap keys', () => {
    expect(isOverrideVersionSelectorKey('undici@8.10.2')).toBe(true);
    expect(isOverrideVersionSelectorKey('undici@^8.11.2')).toBe(true);
    expect(isOverrideVersionSelectorKey('@scope/pkg@1.0.0')).toBe(true);
  });

  it('leaves plain and scoped package names alone', () => {
    expect(isOverrideVersionSelectorKey('undici')).toBe(false);
    expect(isOverrideVersionSelectorKey('undici8')).toBe(false);
    expect(isOverrideVersionSelectorKey('@actions/http-client')).toBe(false);
  });
});

describe('exactOverridePins', () => {
  it('flattens nested exact pins and alias specs, skipping $refs and remaps', () => {
    expect(
      exactOverridePins({
        e2b: { undici8: 'npm:undici@8.12.4' },
        'guarded-fetch': { undici: '7.30.2' },
        miniflare: { undici: '7.30.2' },
        'kokoro-js': { '@huggingface/transformers': { sharp: '$sharp' } },
        'undici@8.10.2': '8.12.2',
        'undici@^8.11.2': '8.12.2',
      })
    ).toEqual([
      { dep: 'undici8', version: '8.12.4', spec: 'npm:undici@8.12.4' },
      { dep: 'undici', version: '7.30.2', spec: '7.30.2' },
    ]);
  });
});

describe('overrideSatisfied', () => {
  it('matches hoisted or nested copies at the requested version', () => {
    const lock = lockOf({
      installed: {
        'node_modules/undici': '7.30.2',
        'node_modules/@actions/http-client/node_modules/undici': '6.29.1',
      },
    });
    expect(overrideSatisfied(lock, 'undici', '7.30.2')).toBe(true);
    expect(overrideSatisfied(lock, 'undici', '6.29.1')).toBe(true);
    expect(overrideSatisfied(lock, 'undici', '7.30.1')).toBe(false);
    expect(overrideSatisfied(lock, 'undici8', '8.12.4')).toBe(false);
  });
});
