import { describe, expect, it } from 'vitest';
import {
  checkPatches,
  checkRenovateSync,
  declaredVersion,
  lockedVersion,
  orphanedPatches,
  parsePatchFilename,
} from './lib.mjs';

describe('parsePatchFilename', () => {
  it('parses an unscoped package', () => {
    expect(parsePatchFilename('just-bash+3.0.1.patch')).toEqual({
      pkg: 'just-bash',
      version: '3.0.1',
    });
  });

  it('parses a scoped package (scope slash encoded as +)', () => {
    expect(parsePatchFilename('@zenfs+core+2.5.6.patch')).toEqual({
      pkg: '@zenfs/core',
      version: '2.5.6',
    });
  });

  it('parses a sequenced patch (version is the first semver segment)', () => {
    expect(parsePatchFilename('just-bash+3.0.1+001+note.patch')).toEqual({
      pkg: 'just-bash',
      version: '3.0.1',
    });
  });

  it('returns null when no version segment exists', () => {
    expect(parsePatchFilename('weird-name.patch')).toBeNull();
  });
});

const manifest = {
  '//': 'comment',
  'just-bash': {
    patchedVersion: '3.0.1',
    upstream: 'https://x/pr/265',
    removeWhen: 'released',
    verify: 'npm run v',
  },
  '@zenfs/core': { patchedVersion: '2.5.6' },
};
const lock = {
  packages: {
    'node_modules/just-bash': { version: '3.0.1' },
    'node_modules/@zenfs/core': { version: '2.5.6' },
  },
};

describe('checkPatches', () => {
  it('passes when every patch matches its installed + manifest version', () => {
    const r = checkPatches({
      patchFiles: ['just-bash+3.0.1.patch', '@zenfs+core+2.5.6.patch'],
      manifest,
      lock,
    });
    expect(r.problems).toEqual([]);
    expect(r.checked).toEqual(['just-bash@3.0.1', '@zenfs/core@2.5.6']);
  });

  it('flags an ORPHANED patch when the lockfile moved past the patch version', () => {
    const bumped = {
      packages: { ...lock.packages, 'node_modules/just-bash': { version: '3.0.2' } },
    };
    const r = checkPatches({ patchFiles: ['just-bash+3.0.1.patch'], manifest, lock: bumped });
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain('ORPHANED');
    expect(r.problems[0]).toContain('3.0.2');
  });

  it('flags an undocumented patch with no manifest entry', () => {
    const r = checkPatches({
      patchFiles: ['mystery+1.0.0.patch'],
      manifest,
      lock: { packages: { 'node_modules/mystery': { version: '1.0.0' } } },
    });
    expect(r.problems.some((p) => p.includes('no entry in patches/patches.json'))).toBe(true);
  });

  it('flags a manifest patchedVersion that disagrees with the filename', () => {
    const r = checkPatches({
      patchFiles: ['just-bash+3.0.1.patch'],
      manifest: { 'just-bash': { patchedVersion: '3.0.0' } },
      lock,
    });
    expect(r.problems.some((p) => p.includes('disagrees with the patch filename'))).toBe(true);
  });

  it('flags a package missing from the lockfile', () => {
    const r = checkPatches({
      patchFiles: ['just-bash+3.0.1.patch'],
      manifest,
      lock: { packages: {} },
    });
    expect(r.problems.some((p) => p.includes('not in package-lock.json'))).toBe(true);
  });

  it('notes (does not fail) a manifest entry with no patch file present', () => {
    const r = checkPatches({ patchFiles: ['@zenfs+core+2.5.6.patch'], manifest, lock });
    expect(r.problems).toEqual([]);
    expect(r.notes.some((n) => n.includes('just-bash'))).toBe(true);
  });
});

describe('orphanedPatches', () => {
  it('returns only the drifted patches with their manifest metadata', () => {
    const bumped = {
      packages: {
        'node_modules/just-bash': { version: '3.0.2' },
        'node_modules/@zenfs/core': { version: '2.5.6' },
      },
    };
    const out = orphanedPatches({
      patchFiles: ['just-bash+3.0.1.patch', '@zenfs+core+2.5.6.patch'],
      manifest,
      lock: bumped,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      pkg: 'just-bash',
      patchedVersion: '3.0.1',
      installedVersion: '3.0.2',
      upstream: 'https://x/pr/265',
      verify: 'npm run v',
    });
  });
});

describe('lockedVersion', () => {
  it('reads the top-level/hoisted entry', () => {
    expect(lockedVersion(lock, 'just-bash')).toBe('3.0.1');
    expect(lockedVersion(lock, '@zenfs/core')).toBe('2.5.6');
  });

  it('falls back to a nested copy of a transitive / non-hoisted package', () => {
    const nested = {
      packages: { 'node_modules/parent/node_modules/dep': { version: '4.5.6' } },
    };
    expect(lockedVersion(nested, 'dep')).toBe('4.5.6');
  });

  it('does not match a different package with the same suffix tail', () => {
    const lk = { packages: { 'node_modules/@zenfs/core-extra': { version: '9.9.9' } } };
    expect(lockedVersion(lk, '@zenfs/core')).toBeNull();
  });

  it('returns null when absent', () => {
    expect(lockedVersion({ packages: {} }, 'missing')).toBeNull();
  });
});

describe('checkRenovateSync', () => {
  const renovate = {
    packageRules: [
      { matchUpdateTypes: ['minor'], groupName: 'non-major dependencies' },
      {
        groupName: 'patched dependencies',
        matchPackageNames: ['just-bash', '@zenfs/core'],
        automerge: false,
      },
    ],
  };

  it('passes when the rule matches the manifest exactly', () => {
    expect(checkRenovateSync({ manifest, renovate })).toEqual([]);
  });

  it('flags a manifest package missing from the rule', () => {
    const r = {
      packageRules: [{ groupName: 'patched dependencies', matchPackageNames: ['just-bash'] }],
    };
    const problems = checkRenovateSync({ manifest, renovate: r });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('missing @zenfs/core');
  });

  it('flags a rule package with no manifest entry', () => {
    const r = {
      packageRules: [
        {
          groupName: 'patched dependencies',
          matchPackageNames: ['just-bash', '@zenfs/core', 'extra-pkg'],
        },
      ],
    };
    const problems = checkRenovateSync({ manifest, renovate: r });
    expect(problems.some((p) => p.includes('extra-pkg'))).toBe(true);
  });

  it('flags a missing rule when the manifest documents packages', () => {
    const problems = checkRenovateSync({ manifest, renovate: { packageRules: [] } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no packageRule with groupName');
  });

  it('is quiet when there are no patches and no rule', () => {
    expect(checkRenovateSync({ manifest: { '//': 'c' }, renovate: { packageRules: [] } })).toEqual(
      []
    );
  });
});

// A Renovate PR that bumped a patched dep but shipped no lockfile: package.json
// says 3.0.2, the lockfile still says 3.0.1 — which matches the patch. Reading
// the lockfile alone concluded "nothing to reconcile" on #2957.
const stalePackageFiles = [
  { dir: 'packages/webapp', manifest: { dependencies: { 'just-bash': '3.0.2' } } },
];

describe('declaredVersion', () => {
  it('finds an exact pin in any package file section', () => {
    expect(declaredVersion(stalePackageFiles, 'just-bash')).toBe('3.0.2');
    expect(
      declaredVersion([{ dir: '', manifest: { devDependencies: { tsx: '4.0.0' } } }], 'tsx')
    ).toBe('4.0.0');
  });

  it('ignores ranges and unknown packages', () => {
    expect(
      declaredVersion([{ dir: '', manifest: { dependencies: { a: '^1.0.0' } } }], 'a')
    ).toBeNull();
    expect(declaredVersion(stalePackageFiles, 'missing')).toBeNull();
    expect(declaredVersion(undefined, 'just-bash')).toBeNull();
  });
});

describe('stale lockfile (package.json disagrees with package-lock.json)', () => {
  it('checkPatches reports both the stale lockfile and the orphan it was hiding', () => {
    const r = checkPatches({
      patchFiles: ['just-bash+3.0.1.patch'],
      manifest,
      lock,
      packageFiles: stalePackageFiles,
    });
    expect(r.problems.some((p) => p.includes('The lockfile is stale'))).toBe(true);
    expect(r.problems.some((p) => p.includes('ORPHANED'))).toBe(true);
  });

  it('orphanedPatches resolves the bump from package.json', () => {
    const orphans = orphanedPatches({
      patchFiles: ['just-bash+3.0.1.patch'],
      manifest,
      lock,
      packageFiles: stalePackageFiles,
    });
    expect(orphans).toHaveLength(1);
    expect(orphans[0].installedVersion).toBe('3.0.2');
  });

  it('is quiet when package.json and the lockfile agree', () => {
    const agreeing = [
      { dir: 'packages/webapp', manifest: { dependencies: { 'just-bash': '3.0.1' } } },
    ];
    const r = checkPatches({
      patchFiles: ['just-bash+3.0.1.patch'],
      manifest,
      lock,
      packageFiles: agreeing,
    });
    expect(r.problems).toEqual([]);
  });
});
