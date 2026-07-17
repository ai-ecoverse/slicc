import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkPackageClaudes,
  discoverPackageClaudes,
  PACKAGE_CLAUDE_EXEMPTIONS,
  PACKAGE_CLAUDE_MAX_CHARS,
  resolvePackageClaudeLimit,
} from './check-doc-sizes-lib.mjs';

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), '..', '..', '..');
const scriptPath = resolve(repoRoot, 'packages/dev-tools/tools/check-doc-sizes.mjs');

/** Run check-doc-sizes.mjs, capturing output even on non-zero exit. */
function runCheckDocSizes() {
  try {
    return { code: 0, out: execFileSync('node', [scriptPath], { encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('PACKAGE_CLAUDE_MAX_CHARS', () => {
  it('is 20000', () => {
    expect(PACKAGE_CLAUDE_MAX_CHARS).toBe(20000);
  });
});

describe('PACKAGE_CLAUDE_EXEMPTIONS', () => {
  it('is empty (all packages graduated)', () => {
    expect(Object.keys(PACKAGE_CLAUDE_EXEMPTIONS)).toEqual([]);
  });

  it('graduated packages are not in the exemption map', () => {
    expect(PACKAGE_CLAUDE_EXEMPTIONS['packages/webapp/CLAUDE.md']).toBeUndefined();
    expect(PACKAGE_CLAUDE_EXEMPTIONS['packages/cloudflare-worker/CLAUDE.md']).toBeUndefined();
    expect(PACKAGE_CLAUDE_EXEMPTIONS['packages/chrome-extension/CLAUDE.md']).toBeUndefined();
    expect(PACKAGE_CLAUDE_EXEMPTIONS['packages/dev-tools/CLAUDE.md']).toBeUndefined();
  });
});

describe('resolvePackageClaudeLimit', () => {
  it('returns PACKAGE_CLAUDE_MAX_CHARS for all packages (no exemptions)', () => {
    expect(resolvePackageClaudeLimit('packages/webapp/CLAUDE.md')).toBe(PACKAGE_CLAUDE_MAX_CHARS);
    expect(resolvePackageClaudeLimit('packages/cloudflare-worker/CLAUDE.md')).toBe(
      PACKAGE_CLAUDE_MAX_CHARS
    );
    expect(resolvePackageClaudeLimit('packages/cherry/CLAUDE.md')).toBe(PACKAGE_CLAUDE_MAX_CHARS);
    expect(resolvePackageClaudeLimit('packages/chrome-extension/CLAUDE.md')).toBe(
      PACKAGE_CLAUDE_MAX_CHARS
    );
    expect(resolvePackageClaudeLimit('packages/dev-tools/CLAUDE.md')).toBe(
      PACKAGE_CLAUDE_MAX_CHARS
    );
    expect(resolvePackageClaudeLimit('packages/node-server/CLAUDE.md')).toBe(
      PACKAGE_CLAUDE_MAX_CHARS
    );
    expect(resolvePackageClaudeLimit('packages/shared-ts/CLAUDE.md')).toBe(
      PACKAGE_CLAUDE_MAX_CHARS
    );
  });

  it('returns PACKAGE_CLAUDE_MAX_CHARS for unknown paths', () => {
    expect(resolvePackageClaudeLimit('packages/new-package/CLAUDE.md')).toBe(
      PACKAGE_CLAUDE_MAX_CHARS
    );
    expect(resolvePackageClaudeLimit('')).toBe(PACKAGE_CLAUDE_MAX_CHARS);
  });
});

describe('discoverPackageClaudes', () => {
  it('maps package dir names to repo-relative paths', () => {
    expect(discoverPackageClaudes(['webapp', 'cherry'])).toEqual([
      'packages/cherry/CLAUDE.md',
      'packages/webapp/CLAUDE.md',
    ]);
  });

  it('sorts results alphabetically', () => {
    const result = discoverPackageClaudes(['zebra', 'apple', 'mango']);
    expect(result).toEqual([
      'packages/apple/CLAUDE.md',
      'packages/mango/CLAUDE.md',
      'packages/zebra/CLAUDE.md',
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(discoverPackageClaudes([])).toEqual([]);
  });

  it('skips empty strings', () => {
    expect(discoverPackageClaudes(['', 'cherry', ''])).toEqual(['packages/cherry/CLAUDE.md']);
  });
});

describe('checkPackageClaudes', () => {
  it('marks paths under the limit as passing', () => {
    const sizes = new Map([['packages/cherry/CLAUDE.md', 10000]]);
    const results = checkPackageClaudes(['packages/cherry/CLAUDE.md'], sizes);
    expect(results).toEqual([
      {
        path: 'packages/cherry/CLAUDE.md',
        size: 10000,
        limit: PACKAGE_CLAUDE_MAX_CHARS,
        pass: true,
      },
    ]);
  });

  it('marks paths at the limit as passing', () => {
    const sizes = new Map([['packages/cherry/CLAUDE.md', PACKAGE_CLAUDE_MAX_CHARS]]);
    const results = checkPackageClaudes(['packages/cherry/CLAUDE.md'], sizes);
    expect(results[0].pass).toBe(true);
  });

  it('marks paths over the limit as failing', () => {
    const sizes = new Map([['packages/cherry/CLAUDE.md', PACKAGE_CLAUDE_MAX_CHARS + 1]]);
    const results = checkPackageClaudes(['packages/cherry/CLAUDE.md'], sizes);
    expect(results[0].pass).toBe(false);
    expect(results[0].size).toBe(PACKAGE_CLAUDE_MAX_CHARS + 1);
  });

  it('all packages resolve at the default 20000 limit', () => {
    const path = 'packages/cloudflare-worker/CLAUDE.md';
    const sizes = new Map([[path, 18000]]);
    const [result] = checkPackageClaudes([path], sizes);
    expect(result.limit).toBe(PACKAGE_CLAUDE_MAX_CHARS);
    expect(result.pass).toBe(true);
  });

  it('returns size 0 for paths not in the size map', () => {
    const sizes = new Map();
    const results = checkPackageClaudes(['packages/cherry/CLAUDE.md'], sizes);
    expect(results[0].size).toBe(0);
    expect(results[0].pass).toBe(true);
  });

  it('handles multiple paths in one call', () => {
    const sizes = new Map([
      ['packages/cherry/CLAUDE.md', 5000],
      ['packages/webapp/CLAUDE.md', 10000],
    ]);
    const results = checkPackageClaudes(
      ['packages/cherry/CLAUDE.md', 'packages/webapp/CLAUDE.md'],
      sizes
    );
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ path: 'packages/cherry/CLAUDE.md', pass: true });
    expect(results[1]).toMatchObject({
      path: 'packages/webapp/CLAUDE.md',
      limit: PACKAGE_CLAUDE_MAX_CHARS,
      pass: true,
    });
  });
});

describe('check-doc-sizes.mjs: package CLAUDE.md integration', () => {
  const { code, out } = runCheckDocSizes();

  it('exits 0 on the current repo (all files within their limits)', () => {
    expect(code).toBe(0);
  });

  it('reports ok for every packages/*/CLAUDE.md discovered', () => {
    expect(out).toMatch(/ok: packages\/cherry\/CLAUDE\.md is \d+\/20000 chars/);
    expect(out).toMatch(/ok: packages\/node-server\/CLAUDE\.md is \d+\/20000 chars/);
  });

  it('no files are grandfathered', () => {
    expect(out).not.toMatch(/grandfathered/);
  });

  it.each([
    'webapp',
    'cloudflare-worker',
    'chrome-extension',
    'dev-tools',
  ])('reports %s at the 20000 default', (packageName) => {
    expect(out).toMatch(new RegExp(`ok: packages/${packageName}/CLAUDE\\.md is \\d+/20000 chars`));
  });
});
