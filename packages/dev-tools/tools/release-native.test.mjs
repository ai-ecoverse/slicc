import { describe, expect, it } from 'vitest';
import {
  decideGating,
  IOS_PATH_PREFIXES,
  isFirstRelease,
  MACOS_PATH_PREFIXES,
  matchesAnyPrefix,
  parseArgs,
  parseChangedFiles,
} from './release-native.mjs';

describe('isFirstRelease', () => {
  it('treats empty / whitespace / placeholder tags as first release', () => {
    expect(isFirstRelease('')).toBe(true);
    expect(isFirstRelease('   ')).toBe(true);
    expect(isFirstRelease(undefined)).toBe(true);
    expect(isFirstRelease(null)).toBe(true);
    expect(isFirstRelease('null')).toBe(true);
    expect(isFirstRelease('undefined')).toBe(true);
  });

  it('treats a real tag as not first release', () => {
    expect(isFirstRelease('v1.2.3')).toBe(false);
  });
});

describe('matchesAnyPrefix', () => {
  it('matches files under a package prefix', () => {
    expect(matchesAnyPrefix('packages/swift-launcher/Package.swift', MACOS_PATH_PREFIXES)).toBe(
      true
    );
    expect(matchesAnyPrefix('packages/spoon/src/index.ts', MACOS_PATH_PREFIXES)).toBe(true);
    expect(matchesAnyPrefix('packages/ios-app/scripts/x.sh', IOS_PATH_PREFIXES)).toBe(true);
  });

  it('does not match unrelated files', () => {
    expect(matchesAnyPrefix('packages/webapp/src/main.ts', MACOS_PATH_PREFIXES)).toBe(false);
    expect(matchesAnyPrefix('packages/swift-launcher/Package.swift', IOS_PATH_PREFIXES)).toBe(
      false
    );
  });

  it('does not treat a sibling with a shared prefix as a match', () => {
    // A hypothetical `packages/spoon-extra/…` must not match `packages/spoon/`.
    expect(matchesAnyPrefix('packages/spoon-extra/index.ts', MACOS_PATH_PREFIXES)).toBe(false);
  });

  it('matches the bare directory path itself', () => {
    expect(matchesAnyPrefix('packages/ios-app', IOS_PATH_PREFIXES)).toBe(true);
  });
});

describe('parseChangedFiles', () => {
  it('splits and trims git diff output, dropping blanks', () => {
    expect(parseChangedFiles('a\n b \n\nc\n')).toEqual(['a', 'b', 'c']);
  });

  it('handles empty / nullish output', () => {
    expect(parseChangedFiles('')).toEqual([]);
    expect(parseChangedFiles(undefined)).toEqual([]);
  });
});

describe('decideGating', () => {
  it('builds both on first release regardless of changed files', () => {
    expect(decideGating({ lastTag: '', changedFiles: [] })).toEqual({
      macos: true,
      ios: true,
      firstRelease: true,
    });
    expect(decideGating({ lastTag: 'null', changedFiles: ['packages/webapp/x.ts'] })).toEqual({
      macos: true,
      ios: true,
      firstRelease: true,
    });
  });

  it('gates macOS only when a macOS-relevant path changed', () => {
    expect(
      decideGating({ lastTag: 'v1.0.0', changedFiles: ['packages/swift-server/Sources/x.swift'] })
    ).toEqual({ macos: true, ios: false, firstRelease: false });
  });

  it('gates iOS only when an iOS-relevant path changed', () => {
    expect(
      decideGating({ lastTag: 'v1.0.0', changedFiles: ['packages/ios-app/Sources/App.swift'] })
    ).toEqual({ macos: false, ios: true, firstRelease: false });
  });

  it('builds neither when only unrelated packages changed', () => {
    expect(
      decideGating({
        lastTag: 'v1.0.0',
        changedFiles: ['packages/webapp/src/main.ts', 'docs/development.md'],
      })
    ).toEqual({ macos: false, ios: false, firstRelease: false });
  });

  it('builds both when both path sets changed', () => {
    expect(
      decideGating({
        lastTag: 'v1.0.0',
        changedFiles: ['packages/spoon/src/x.ts', 'packages/ios-app/y.swift'],
      })
    ).toEqual({ macos: true, ios: true, firstRelease: false });
  });

  it('gates macOS on a spoon change (embedded web artifact)', () => {
    expect(
      decideGating({ lastTag: 'v1.0.0', changedFiles: ['packages/spoon/src/launcher.ts'] })
    ).toEqual({ macos: true, ios: false, firstRelease: false });
  });
});

describe('parseArgs', () => {
  it('parses --last= inline form (as passed by the release template)', () => {
    expect(parseArgs(['--last=v1.2.3'])).toEqual({ last: 'v1.2.3', dryRun: false, help: false });
    expect(parseArgs(['--last='])).toEqual({ last: '', dryRun: false, help: false });
  });

  it('parses --last with a separate value', () => {
    expect(parseArgs(['--last', 'v2.0.0'])).toEqual({
      last: 'v2.0.0',
      dryRun: false,
      help: false,
    });
  });

  it('parses --dry-run and --help aliases', () => {
    expect(parseArgs(['-n']).dryRun).toBe(true);
    expect(parseArgs(['--dry-run']).dryRun).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it('defaults to empty last / false flags', () => {
    expect(parseArgs([])).toEqual({ last: '', dryRun: false, help: false });
  });
});
