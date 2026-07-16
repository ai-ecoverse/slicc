import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findViolations, isSymlink, isValidAgentsSymlink } from './check-agents-symlinks.mjs';

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), '..', '..', '..');
const scriptPath = resolve(repoRoot, 'packages/dev-tools/tools/check-agents-symlinks.mjs');

/** Run the guard as the entry script, capturing output even on non-zero exit. */
function runGuard() {
  try {
    return { code: 0, out: execFileSync('node', [scriptPath], { encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

// ---------------------------------------------------------------------------
// Temporary workspace helpers
// ---------------------------------------------------------------------------

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'check-agents-symlinks-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a fake package directory under tmpDir with optional files. */
function makePackage(pkgName, { claudeMd = false, agentsMd = null } = {}) {
  const pkgDir = join(tmpDir, pkgName);
  mkdirSync(pkgDir, { recursive: true });
  if (claudeMd) writeFileSync(join(pkgDir, 'CLAUDE.md'), `# ${pkgName}\n`);
  if (agentsMd === 'symlink-valid') {
    symlinkSync('CLAUDE.md', join(pkgDir, 'AGENTS.md'));
  } else if (agentsMd === 'symlink-wrong') {
    symlinkSync('something-else.md', join(pkgDir, 'AGENTS.md'));
  } else if (agentsMd === 'plain-file') {
    writeFileSync(join(pkgDir, 'AGENTS.md'), '# agents\n');
  }
  return pkgDir;
}

// ---------------------------------------------------------------------------
// isSymlink
// ---------------------------------------------------------------------------

describe('isSymlink', () => {
  it('returns true for a symlink', () => {
    const target = join(tmpDir, 'target.txt');
    const link = join(tmpDir, 'link.txt');
    writeFileSync(target, 'hi');
    symlinkSync(target, link);
    expect(isSymlink(link)).toBe(true);
  });

  it('returns false for a plain file', () => {
    const file = join(tmpDir, 'plain.txt');
    writeFileSync(file, 'hi');
    expect(isSymlink(file)).toBe(false);
  });

  it('returns false for a path that does not exist', () => {
    expect(isSymlink(join(tmpDir, 'nonexistent'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isValidAgentsSymlink
// ---------------------------------------------------------------------------

describe('isValidAgentsSymlink', () => {
  it('returns true when the symlink target is exactly "CLAUDE.md"', () => {
    const link = join(tmpDir, 'AGENTS.md');
    symlinkSync('CLAUDE.md', link);
    expect(isValidAgentsSymlink(link)).toBe(true);
  });

  it('returns false when the symlink target is something else', () => {
    const link = join(tmpDir, 'AGENTS.md');
    symlinkSync('README.md', link);
    expect(isValidAgentsSymlink(link)).toBe(false);
  });

  it('returns false for a plain file', () => {
    const file = join(tmpDir, 'AGENTS.md');
    writeFileSync(file, 'hi');
    expect(isValidAgentsSymlink(file)).toBe(false);
  });

  it('returns false for a non-existent path', () => {
    expect(isValidAgentsSymlink(join(tmpDir, 'missing'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findViolations
// ---------------------------------------------------------------------------

describe('findViolations', () => {
  it('returns no violations when all packages with CLAUDE.md have valid AGENTS.md', () => {
    makePackage('pkg-a', { claudeMd: true, agentsMd: 'symlink-valid' });
    makePackage('pkg-b', { claudeMd: true, agentsMd: 'symlink-valid' });
    expect(findViolations(tmpDir, ['pkg-a', 'pkg-b'])).toEqual([]);
  });

  it('ignores packages without a CLAUDE.md', () => {
    makePackage('assets'); // no CLAUDE.md, no AGENTS.md
    expect(findViolations(tmpDir, ['assets'])).toEqual([]);
  });

  it('flags a package with CLAUDE.md but no AGENTS.md', () => {
    makePackage('cherry', { claudeMd: true });
    const violations = findViolations(tmpDir, ['cherry']);
    expect(violations).toHaveLength(1);
    expect(violations[0].pkg).toBe('cherry');
    expect(violations[0].reason).toContain('missing or is not a symlink');
  });

  it('flags a package with CLAUDE.md and a plain-file AGENTS.md', () => {
    makePackage('cloud-core', { claudeMd: true, agentsMd: 'plain-file' });
    const violations = findViolations(tmpDir, ['cloud-core']);
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toContain('missing or is not a symlink');
  });

  it('flags a package with CLAUDE.md and a symlink pointing at the wrong target', () => {
    makePackage('spoon', { claudeMd: true, agentsMd: 'symlink-wrong' });
    const violations = findViolations(tmpDir, ['spoon']);
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toContain('something-else.md');
  });

  it('returns multiple violations when several packages are missing the symlink', () => {
    makePackage('pkg-x', { claudeMd: true });
    makePackage('pkg-y', { claudeMd: true });
    makePackage('pkg-z', { claudeMd: true, agentsMd: 'symlink-valid' });
    const violations = findViolations(tmpDir, ['pkg-x', 'pkg-y', 'pkg-z']);
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.pkg)).toEqual(expect.arrayContaining(['pkg-x', 'pkg-y']));
  });
});

// ---------------------------------------------------------------------------
// End-to-end over the real repo tree
// ---------------------------------------------------------------------------

describe('check-agents-symlinks: end-to-end over the real repo', () => {
  it('passes (all packages with CLAUDE.md have a valid AGENTS.md symlink)', () => {
    const { code, out } = runGuard();
    expect(code).toBe(0);
    expect(out).toMatch(/ok: all \d+ packages with CLAUDE\.md have a valid AGENTS\.md symlink/);
  });
});
