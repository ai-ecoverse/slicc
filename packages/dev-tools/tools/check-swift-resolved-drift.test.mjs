import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diffPins, pinMap } from './check-swift-resolved-drift.mjs';

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), '..', '..', '..');
const scriptPath = resolve(repoRoot, 'packages/dev-tools/tools/check-swift-resolved-drift.mjs');

/** A `Package.resolved` body with the given `identity -> {version, revision}` pins. */
function resolvedFile(pins, originHash = 'abc') {
  return `${JSON.stringify(
    {
      originHash,
      pins: Object.entries(pins).map(([identity, state]) => ({
        identity,
        kind: 'remoteSourceControl',
        location: `https://example.invalid/${identity}.git`,
        state,
      })),
      version: 3,
    },
    null,
    2
  )}\n`;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('pinMap', () => {
  it('keys pins by identity and folds version + revision into one comparable value', () => {
    const map = pinMap(resolvedFile({ msdisplaylink: { version: '2.1.0', revision: 'aaa' } }));
    expect(map).toEqual({ msdisplaylink: '2.1.0@aaa' });
  });

  it('falls back to the branch name for a branch pin, which carries no version', () => {
    const map = pinMap(resolvedFile({ ghostty: { branch: 'main', revision: 'bbb' } }));
    expect(map).toEqual({ ghostty: 'main@bbb' });
  });

  it('tolerates a lockfile with no pins at all', () => {
    expect(pinMap('{"originHash":"x","version":3}')).toEqual({});
  });
});

describe('diffPins', () => {
  it('reports nothing when the pin sets match', () => {
    expect(diffPins({ a: '1.0.0@x' }, { a: '1.0.0@x' })).toEqual([]);
  });

  it('reports a moved version, an added pin, and a removed pin', () => {
    const problems = diffPins(
      { a: '1.0.0@x', gone: '3.0.0@z' },
      { a: '2.0.0@y', fresh: '0.1.0@w' }
    );
    expect(problems).toEqual([
      'a: 1.0.0@x -> 2.0.0@y',
      'fresh: added 0.1.0@w',
      'gone: 3.0.0@z -> removed',
    ]);
  });

  it('ignores pin ORDER, which the resolver is free to shuffle', () => {
    const committed = pinMap(
      resolvedFile({
        a: { version: '1.0.0', revision: 'x' },
        b: { version: '2.0.0', revision: 'y' },
      })
    );
    const working = pinMap(
      resolvedFile({
        b: { version: '2.0.0', revision: 'y' },
        a: { version: '1.0.0', revision: 'x' },
      })
    );
    expect(diffPins(committed, working)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// End to end, against a throwaway git repo
// ---------------------------------------------------------------------------

let tmpDir;

function git(...args) {
  execFileSync('git', args, { cwd: tmpDir, encoding: 'utf8', stdio: 'pipe' });
}

function runGuard(...files) {
  try {
    return {
      code: 0,
      out: execFileSync('node', [scriptPath, ...files], { cwd: tmpDir, encoding: 'utf8' }),
    };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'check-swift-resolved-drift-'));
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  mkdirSync(join(tmpDir, 'pkg'), { recursive: true });
  writeFileSync(
    join(tmpDir, 'pkg/Package.resolved'),
    resolvedFile({ msdisplaylink: { version: '2.1.0', revision: 'aaa' } })
  );
  git('add', 'pkg/Package.resolved');
  git('commit', '-qm', 'seed');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('check-swift-resolved-drift', () => {
  it('passes when the working copy still matches the committed pins', () => {
    const { code, out } = runGuard('pkg/Package.resolved');
    expect(code).toBe(0);
    expect(out).toContain('ok  pkg/Package.resolved');
  });

  it('passes when only originHash moved — that digest tracks the toolchain, not the pins', () => {
    writeFileSync(
      join(tmpDir, 'pkg/Package.resolved'),
      resolvedFile({ msdisplaylink: { version: '2.1.0', revision: 'aaa' } }, 'DIFFERENT')
    );
    expect(runGuard('pkg/Package.resolved').code).toBe(0);
  });

  it('fails when resolution floated a transitive pin, naming the old and new version', () => {
    writeFileSync(
      join(tmpDir, 'pkg/Package.resolved'),
      resolvedFile({ msdisplaylink: { version: '2.2.0', revision: 'bbb' } })
    );
    const { code, out } = runGuard('pkg/Package.resolved');
    expect(code).toBe(1);
    expect(out).toContain('msdisplaylink: 2.1.0@aaa -> 2.2.0@bbb');
    expect(out).toContain('xcodegen generate');
  });

  it('fails when the lockfile is missing rather than reporting a silent pass', () => {
    const { code, out } = runGuard('pkg/Absent.resolved');
    expect(code).toBe(1);
    expect(out).toContain('does not exist');
  });

  it('fails when the lockfile exists but was never committed', () => {
    writeFileSync(
      join(tmpDir, 'pkg/Untracked.resolved'),
      resolvedFile({ a: { version: '1.0.0', revision: 'x' } })
    );
    const { code, out } = runGuard('pkg/Untracked.resolved');
    expect(code).toBe(1);
    expect(out).toContain('is not committed');
  });

  it('exits 2 with usage when handed no files', () => {
    const { code, out } = runGuard();
    expect(code).toBe(2);
    expect(out).toContain('usage:');
  });
});
