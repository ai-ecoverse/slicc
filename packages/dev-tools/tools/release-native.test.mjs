import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub only the fs write so main()'s dry-run guard can be checked hermetically —
// keep the real realpathSync the module uses for its isMain check at import time.
vi.mock('node:fs', async (importActual) => {
  const actual = await importActual();
  return { ...actual, writeFileSync: vi.fn() };
});

vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual();
  return { ...actual, execFileSync: vi.fn() };
});

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import {
  buildKnownGoodPointer,
  decideChromeGating,
  decideGating,
  decideWorkerGating,
  EXTENSION_PATH_PREFIXES,
  getChangedFiles,
  IOS_PATH_PREFIXES,
  isFirstRelease,
  MACOS_PATH_PREFIXES,
  main,
  matchesAnyPrefix,
  parseArgs,
  parseChangedFiles,
  resolveDiffRef,
  WORKER_PATH_PREFIXES,
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

  it('matches files under an extension-relevant prefix', () => {
    expect(
      matchesAnyPrefix('packages/chrome-extension/src/service-worker.ts', EXTENSION_PATH_PREFIXES)
    ).toBe(true);
    expect(matchesAnyPrefix('packages/webapp/src/main.ts', EXTENSION_PATH_PREFIXES)).toBe(true);
    expect(matchesAnyPrefix('packages/cloud-core/src/index.ts', EXTENSION_PATH_PREFIXES)).toBe(
      true
    );
  });

  it('does not treat a sibling with a shared extension prefix as a match', () => {
    // A hypothetical `packages/webapp-extra/…` must not match `packages/webapp/`.
    expect(matchesAnyPrefix('packages/webapp-extra/index.ts', EXTENSION_PATH_PREFIXES)).toBe(false);
  });

  it('does not treat native / worker / node-server / docs as extension-relevant', () => {
    expect(matchesAnyPrefix('packages/ios-app/Sources/App.swift', EXTENSION_PATH_PREFIXES)).toBe(
      false
    );
    expect(matchesAnyPrefix('packages/cloudflare-worker/src/x.ts', EXTENSION_PATH_PREFIXES)).toBe(
      false
    );
    expect(matchesAnyPrefix('packages/node-server/src/index.ts', EXTENSION_PATH_PREFIXES)).toBe(
      false
    );
    expect(matchesAnyPrefix('docs/development.md', EXTENSION_PATH_PREFIXES)).toBe(false);
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

describe('resolveDiffRef', () => {
  it('excludes a generated semantic-release commit', () => {
    expect(resolveDiffRef({ headSubject: 'chore(release): 5.38.0' })).toBe('HEAD^');
    expect(resolveDiffRef({ headSubject: 'chore(release): 5.38.0', headRef: 'abc123' })).toBe(
      'abc123^'
    );
  });

  it('keeps HEAD for a normal commit', () => {
    expect(resolveDiffRef({ headSubject: 'fix(deps): update wrangler' })).toBe('HEAD');
    expect(resolveDiffRef({ headSubject: 'docs: mention chore(release): commits' })).toBe('HEAD');
  });
});

describe('getChangedFiles', () => {
  beforeEach(() => execFileSync.mockReset());

  it('diffs against HEAD^ so a generated release-only bump is excluded', () => {
    execFileSync.mockReturnValueOnce('chore(release): 5.38.0\n').mockReturnValueOnce('');

    const changedFiles = getChangedFiles('v5.37.0');

    expect(execFileSync).toHaveBeenNthCalledWith(1, 'git', ['log', '-1', '--format=%s', 'HEAD'], {
      encoding: 'utf8',
    });
    expect(execFileSync).toHaveBeenNthCalledWith(
      2,
      'git',
      ['diff', '--name-only', 'v5.37.0', 'HEAD^'],
      { encoding: 'utf8' }
    );
    expect(decideWorkerGating({ lastTag: 'v5.37.0', changedFiles })).toEqual({
      worker: false,
      firstRelease: false,
    });
  });

  it('diffs against HEAD and deploys for a genuine dependency bump', () => {
    execFileSync
      .mockReturnValueOnce('fix(deps): update wrangler\n')
      .mockReturnValueOnce('package.json\npackage-lock.json\n');

    const changedFiles = getChangedFiles('v5.37.0');

    expect(execFileSync).toHaveBeenNthCalledWith(
      2,
      'git',
      ['diff', '--name-only', 'v5.37.0', 'HEAD'],
      { encoding: 'utf8' }
    );
    expect(decideWorkerGating({ lastTag: 'v5.37.0', changedFiles })).toEqual({
      worker: true,
      firstRelease: false,
    });
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

  it('gates macOS on an assets change (.app bundle icon)', () => {
    expect(
      decideGating({
        lastTag: 'v1.0.0',
        changedFiles: ['packages/assets/logos/macos-icon.png'],
      })
    ).toEqual({ macos: true, ios: false, firstRelease: false });
  });
});

describe('decideChromeGating', () => {
  it('publishes on first release regardless of changed files', () => {
    expect(decideChromeGating({ lastTag: '', changedFiles: [] })).toEqual({
      chrome: true,
      firstRelease: true,
    });
    expect(
      decideChromeGating({ lastTag: 'null', changedFiles: ['packages/ios-app/App.swift'] })
    ).toEqual({ chrome: true, firstRelease: true });
  });

  it('publishes when a chrome-extension path changed', () => {
    expect(
      decideChromeGating({
        lastTag: 'v1.0.0',
        changedFiles: ['packages/chrome-extension/src/service-worker.ts'],
      })
    ).toEqual({ chrome: true, firstRelease: false });
  });

  it('publishes when a webapp path changed', () => {
    expect(
      decideChromeGating({ lastTag: 'v1.0.0', changedFiles: ['packages/webapp/src/main.ts'] })
    ).toEqual({ chrome: true, firstRelease: false });
  });

  it('publishes when an assets path changed (logos / fonts / favicon)', () => {
    expect(
      decideChromeGating({ lastTag: 'v1.0.0', changedFiles: ['packages/assets/logos/icon.png'] })
    ).toEqual({ chrome: true, firstRelease: false });
  });

  it('does not publish when only native (swift/ios) changed', () => {
    expect(
      decideChromeGating({
        lastTag: 'v1.0.0',
        changedFiles: ['packages/swift-server/Sources/x.swift', 'packages/ios-app/App.swift'],
      })
    ).toEqual({ chrome: false, firstRelease: false });
  });

  it('does not publish when only the worker changed', () => {
    expect(
      decideChromeGating({
        lastTag: 'v1.0.0',
        changedFiles: ['packages/cloudflare-worker/src/index.ts'],
      })
    ).toEqual({ chrome: false, firstRelease: false });
  });

  it('does not publish when only node-server changed', () => {
    expect(
      decideChromeGating({
        lastTag: 'v1.0.0',
        changedFiles: ['packages/node-server/src/index.ts'],
      })
    ).toEqual({ chrome: false, firstRelease: false });
  });

  it('does not publish when only docs changed', () => {
    expect(
      decideChromeGating({ lastTag: 'v1.0.0', changedFiles: ['docs/development.md'] })
    ).toEqual({ chrome: false, firstRelease: false });
  });
});

describe('decideWorkerGating', () => {
  const requiredPrefixes = [
    'packages/cloudflare-worker/',
    'packages/webapp/',
    'packages/webcomponents/',
    'packages/spoon/',
    'packages/cherry/',
    'packages/shared-ts/',
    'packages/cloud-core/',
    'packages/dev-tools/e2b-template/',
  ];

  it('deploys on first release with an empty last tag', () => {
    expect(decideWorkerGating({ lastTag: '', changedFiles: [] })).toEqual({
      worker: true,
      firstRelease: true,
    });
  });

  it('deploys for a worker/UI-relevant change', () => {
    expect(
      decideWorkerGating({
        lastTag: 'v1.0.0',
        changedFiles: ['packages/webapp/src/main.ts'],
      })
    ).toEqual({ worker: true, firstRelease: false });
  });

  it('skips for an irrelevant change', () => {
    expect(
      decideWorkerGating({ lastTag: 'v1.0.0', changedFiles: ['docs/development.md'] })
    ).toEqual({ worker: false, firstRelease: false });
  });

  it.each([
    'package.json',
    'package-lock.json',
  ])('deploys for genuine root metadata change %s', (file) => {
    expect(WORKER_PATH_PREFIXES).toContain(file);
    expect(decideWorkerGating({ lastTag: 'v1.0.0', changedFiles: [file] })).toEqual({
      worker: true,
      firstRelease: false,
    });
  });

  it.each(requiredPrefixes)('deploys for required prefix %s', (prefix) => {
    expect(WORKER_PATH_PREFIXES).toContain(prefix);
    expect(
      decideWorkerGating({ lastTag: 'v1.0.0', changedFiles: [`${prefix}changed-file`] })
    ).toEqual({ worker: true, firstRelease: false });
  });
});

describe('parseArgs', () => {
  it('parses --last= inline form (as passed by the release template)', () => {
    expect(parseArgs(['--last=v1.2.3'])).toEqual({
      last: 'v1.2.3',
      next: '',
      gate: '',
      dryRun: false,
      help: false,
    });
    expect(parseArgs(['--last='])).toEqual({
      last: '',
      next: '',
      gate: '',
      dryRun: false,
      help: false,
    });
  });

  it('parses --last with a separate value', () => {
    expect(parseArgs(['--last', 'v2.0.0'])).toEqual({
      last: 'v2.0.0',
      next: '',
      gate: '',
      dryRun: false,
      help: false,
    });
  });

  it('parses --next= inline and separate forms (mirrors --last)', () => {
    expect(parseArgs(['--next=5.38.0'])).toEqual({
      last: '',
      next: '5.38.0',
      gate: '',
      dryRun: false,
      help: false,
    });
    expect(parseArgs(['--next', '5.38.0'])).toEqual({
      last: '',
      next: '5.38.0',
      gate: '',
      dryRun: false,
      help: false,
    });
    expect(parseArgs(['--next=']).next).toBe('');
  });

  it('parses --last and --next together (as passed by prepareCmd)', () => {
    expect(parseArgs(['--last=v5.36.0', '--next=5.37.0'])).toEqual({
      last: 'v5.36.0',
      next: '5.37.0',
      gate: '',
      dryRun: false,
      help: false,
    });
  });

  it('parses --gate= inline and separate forms', () => {
    expect(parseArgs(['--gate=chrome', '--last=v1.2.3'])).toEqual({
      last: 'v1.2.3',
      next: '',
      gate: 'chrome',
      dryRun: false,
      help: false,
    });
    expect(parseArgs(['--gate', 'chrome'])).toEqual({
      last: '',
      next: '',
      gate: 'chrome',
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

  it('defaults to empty last / next / gate / false flags', () => {
    expect(parseArgs([])).toEqual({ last: '', next: '', gate: '', dryRun: false, help: false });
  });
});

describe('buildKnownGoodPointer', () => {
  it('returns a { version } pointer for a plain version', () => {
    expect(buildKnownGoodPointer('5.37.0')).toEqual({ version: '5.37.0' });
  });

  it('trims a leading v (git-tag style) and surrounding whitespace', () => {
    expect(buildKnownGoodPointer('v5.37.0')).toEqual({ version: '5.37.0' });
    expect(buildKnownGoodPointer('  v5.37.0  ')).toEqual({ version: '5.37.0' });
  });

  it('throws on empty / whitespace / non-string input', () => {
    expect(() => buildKnownGoodPointer('')).toThrow();
    expect(() => buildKnownGoodPointer('   ')).toThrow();
    expect(() => buildKnownGoodPointer(undefined)).toThrow();
    expect(() => buildKnownGoodPointer(null)).toThrow();
  });
});

describe('main native gate — dry-run', () => {
  it('does not write the known-good macOS pointer on a dry-run (macOS gate open, non-empty --next)', () => {
    // Empty --last => first release => decision.macos is true WITHOUT touching git
    // (getChangedFiles is skipped) and runStep only logs under --dry-run, so this
    // exercises the write guard hermetically — no real git, shell, or fs write.
    writeFileSync.mockClear();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(main(['--last=', '--next=9.9.9', '--dry-run'])).toBe(0);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
    expect(writeFileSync).not.toHaveBeenCalled();
  });
});
