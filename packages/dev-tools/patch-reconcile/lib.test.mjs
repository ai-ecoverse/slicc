import { describe, expect, it } from 'vitest';
import { checkPatches, orphanedPatches, parsePatchFilename } from './lib.mjs';

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
