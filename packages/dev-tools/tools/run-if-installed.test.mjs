import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  executableSuffixes,
  findOnPath,
  isExecutableFile,
  isExplicitPath,
  skipMessage,
  spawnPlan,
} from './run-if-installed.mjs';

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), '..', '..', '..');
const scriptPath = resolve(repoRoot, 'packages/dev-tools/tools/run-if-installed.mjs');

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'run-if-installed-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeExecutable(name, body = '#!/bin/sh\nexit 0\n') {
  const binDir = join(tmpDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return { binDir, path };
}

/** Run the wrapper as the entry script, capturing both streams and the code. */
function runWrapper(args, extraPath) {
  const env = { ...process.env };
  if (extraPath) env.PATH = `${extraPath}:${process.env.PATH}`;
  const result = spawnSync('node', [scriptPath, ...args], { encoding: 'utf8', env });
  return { code: result.status ?? 1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

describe('isExecutableFile', () => {
  it('returns true for a file with the execute bit set', () => {
    const { path } = makeExecutable('tool');
    expect(isExecutableFile(path)).toBe(true);
  });

  it('returns false for a non-executable file', () => {
    const path = join(tmpDir, 'plain.txt');
    writeFileSync(path, 'hi');
    chmodSync(path, 0o644);
    expect(isExecutableFile(path)).toBe(false);
  });

  it('returns false for a directory', () => {
    expect(isExecutableFile(tmpDir)).toBe(false);
  });

  it('returns false for a path that does not exist', () => {
    expect(isExecutableFile(join(tmpDir, 'nope'))).toBe(false);
  });
});

describe('findOnPath', () => {
  const posix = { platform: 'linux', env: {} };
  // PATHEXT entries are conventionally uppercase, so a resolved path only matches
  // the fixture's casing on a case-insensitive filesystem — compare lowercased.

  it('finds a binary in one of the PATH entries', () => {
    const { binDir, path } = makeExecutable('swiftlint');
    expect(findOnPath('swiftlint', { ...posix, path: `/nonexistent:${binDir}` })).toBe(path);
  });

  it('returns null when the binary is absent from every PATH entry', () => {
    const { binDir } = makeExecutable('swiftlint');
    expect(findOnPath('gofmt', { ...posix, path: binDir })).toBeNull();
  });

  it('returns null for an empty PATH', () => {
    expect(findOnPath('gofmt', { ...posix, path: '' })).toBeNull();
  });

  it('returns null for an empty binary name', () => {
    expect(findOnPath('', { ...posix, path: '/usr/bin' })).toBeNull();
  });

  it('treats a name containing a separator as a direct path', () => {
    const { path } = makeExecutable('tool');
    expect(findOnPath(path, { ...posix, path: '' })).toBe(path);
    expect(findOnPath(join(tmpDir, 'missing/tool'), { ...posix, path: '' })).toBeNull();
  });

  it('reads PATH from the injected env when no explicit path is given', () => {
    const { binDir, path } = makeExecutable('swiftlint');
    expect(findOnPath('swiftlint', { platform: 'linux', env: { PATH: binDir } })).toBe(path);
  });

  it('does not append PATHEXT suffixes on posix', () => {
    const { binDir } = makeExecutable('gofmt.exe');
    expect(findOnPath('gofmt', { ...posix, path: binDir })).toBeNull();
  });

  it('resolves a bare name through PATHEXT on win32', () => {
    const { binDir, path } = makeExecutable('gofmt.exe');
    const win32 = { platform: 'win32', env: { PATHEXT: '.COM;.EXE;.BAT;.CMD' } };
    const found = findOnPath('gofmt', { ...win32, path: `C:\\nowhere;${binDir}` });
    expect(found?.toLowerCase()).toBe(path.toLowerCase());
  });

  it('falls back to a default PATHEXT on win32 when the variable is unset', () => {
    const { binDir, path } = makeExecutable('gofmt.exe');
    const found = findOnPath('gofmt', { platform: 'win32', env: {}, path: binDir });
    expect(found?.toLowerCase()).toBe(path.toLowerCase());
  });

  it('reads PATHEXT case-insensitively on win32', () => {
    const { binDir, path } = makeExecutable('gofmt.bat');
    expect(findOnPath('gofmt', { platform: 'win32', env: { Pathext: '.bat' }, path: binDir })).toBe(
      path
    );
  });

  it('splits PATH on semicolons on win32 so drive letters survive', () => {
    const { binDir, path } = makeExecutable('gofmt.exe');
    const found = findOnPath('gofmt', {
      platform: 'win32',
      env: {},
      path: `C:\\Go\\bin;${binDir}`,
    });
    expect(found?.toLowerCase()).toBe(path.toLowerCase());
  });

  it('still prefers a bare name over a PATHEXT candidate on win32', () => {
    const { binDir, path } = makeExecutable('gofmt');
    makeExecutable('gofmt.exe');
    expect(findOnPath('gofmt', { platform: 'win32', env: {}, path: binDir })).toBe(path);
  });

  it('treats a backslash path as explicit on win32 instead of scanning PATH', () => {
    const { binDir } = makeExecutable('tool.exe');
    expect(findOnPath('bin\\tool', { platform: 'win32', env: {}, path: binDir })).toBeNull();
  });

  it('expands PATHEXT for an extensionless explicit path on win32', () => {
    const { path } = makeExecutable('tool.exe');
    const withoutExtension = path.slice(0, -'.exe'.length);
    expect(
      findOnPath(withoutExtension, { platform: 'win32', env: { PATHEXT: '.exe' }, path: '' })
    ).toBe(path);
  });
});

describe('executableSuffixes', () => {
  it('is a single empty suffix on posix', () => {
    expect(executableSuffixes({ platform: 'darwin', env: { PATHEXT: '.EXE' } })).toEqual(['']);
  });

  it('keeps the bare name first and normalises missing dots on win32', () => {
    expect(executableSuffixes({ platform: 'win32', env: { PATHEXT: 'EXE; .cmd ;' } })).toEqual([
      '',
      '.EXE',
      '.cmd',
    ]);
  });
});

describe('isExplicitPath', () => {
  it('accepts forward slashes everywhere and backslashes only on win32', () => {
    expect(isExplicitPath('./tool', 'linux')).toBe(true);
    expect(isExplicitPath('dir\\tool', 'linux')).toBe(false);
    expect(isExplicitPath('dir\\tool', 'win32')).toBe(true);
    expect(isExplicitPath('tool', 'win32')).toBe(false);
  });
});

describe('spawnPlan', () => {
  it('spawns directly for a native executable', () => {
    expect(spawnPlan('/usr/bin/gofmt', ['-l', 'a.go'], 'linux')).toEqual({
      command: '/usr/bin/gofmt',
      args: ['-l', 'a.go'],
      shell: false,
    });
    expect(spawnPlan('C:\\Go\\bin\\gofmt.exe', ['-l'], 'win32').shell).toBe(false);
  });

  it('uses a quoted shell invocation for a win32 batch wrapper', () => {
    const plan = spawnPlan('C:\\tools\\gofmt.cmd', ['-w', 'C:\\my code\\a.go'], 'win32');
    expect(plan.shell).toBe(true);
    expect(plan.command).toBe('C:\\tools\\gofmt.cmd');
    expect(plan.args).toEqual(['-w', '"C:\\my code\\a.go"']);
  });
});

describe('skipMessage', () => {
  it('names the missing binary and points at the setup docs', () => {
    const message = skipMessage('gofmt');
    expect(message).toContain('"gofmt" is not installed');
    expect(message).toContain('docs/development.md');
  });
});

describe('run-if-installed: entry script', () => {
  it('exits 0 with a warning when the binary is missing', () => {
    const { code, out } = runWrapper(['definitely-not-a-real-binary-xyz', '--fix']);
    expect(code).toBe(0);
    expect(out).toContain('is not installed');
  });

  it('exits 2 when no binary is given', () => {
    const { code, out } = runWrapper([]);
    expect(code).toBe(2);
    expect(out).toContain('usage:');
  });

  it('forwards arguments and the exit code when the binary exists', () => {
    const { binDir } = makeExecutable(
      'fake-formatter',
      '#!/bin/sh\necho "args: $*"\n[ "$1" = "--fail" ] && exit 3\nexit 0\n'
    );
    const ok = runWrapper(['fake-formatter', '--fix', 'a.swift'], binDir);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('args: --fix a.swift');

    const failed = runWrapper(['fake-formatter', '--fail'], binDir);
    expect(failed.code).toBe(3);
  });
});
