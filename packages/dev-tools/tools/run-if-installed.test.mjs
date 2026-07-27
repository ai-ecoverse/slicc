import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findOnPath, isExecutableFile, skipMessage } from './run-if-installed.mjs';

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
  it('finds a binary in one of the PATH entries', () => {
    const { binDir, path } = makeExecutable('swiftlint');
    expect(findOnPath('swiftlint', `/nonexistent:${binDir}`)).toBe(path);
  });

  it('returns null when the binary is absent from every PATH entry', () => {
    const { binDir } = makeExecutable('swiftlint');
    expect(findOnPath('gofmt', binDir)).toBeNull();
  });

  it('returns null for an empty PATH', () => {
    expect(findOnPath('gofmt', '')).toBeNull();
  });

  it('returns null for an empty binary name', () => {
    expect(findOnPath('', '/usr/bin')).toBeNull();
  });

  it('treats a name containing a separator as a direct path', () => {
    const { path } = makeExecutable('tool');
    expect(findOnPath(path, '')).toBe(path);
    expect(findOnPath(join(tmpDir, 'missing/tool'), '')).toBeNull();
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
