import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ALLOWLIST,
  extractCandidates,
  globToRegex,
  hasKnownPrefix,
  hasTemplatePlaceholder,
  isAbsolutePath,
  isAllowlisted,
  isGlobPath,
  isIllustrativePath,
  resolveToken,
  shouldSkip,
} from './check-doc-refs-lib.mjs';

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), '..', '..', '..');
const scriptPath = resolve(repoRoot, 'packages/dev-tools/tools/check-doc-refs.mjs');

/** Run the gate as the entry script and capture output even on non-zero exit. */
function runGuard() {
  try {
    return { code: 0, out: execFileSync('node', [scriptPath], { encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

// ---------------------------------------------------------------------------
// resolveToken
// ---------------------------------------------------------------------------

describe('check-doc-refs: resolveToken', () => {
  it('returns the token unchanged when clean', () => {
    expect(resolveToken('packages/webapp/src/ui/main.ts')).toEqual({
      path: 'packages/webapp/src/ui/main.ts',
      hadTrailingSlash: false,
    });
  });

  it('strips numeric :line suffix', () => {
    expect(resolveToken('docs/shell-reference.md:42').path).toBe('docs/shell-reference.md');
  });

  it('strips :functionName suffix', () => {
    expect(
      resolveToken('packages/chrome-extension/src/fetch-proxy-shared.ts:handleFetchProxy').path
    ).toBe('packages/chrome-extension/src/fetch-proxy-shared.ts');
  });

  it('strips :main() function-call suffix', () => {
    expect(resolveToken('packages/webapp/src/ui/main.ts:main()').path).toBe(
      'packages/webapp/src/ui/main.ts'
    );
  });

  it('strips content after first whitespace (CLI args, §4 anchors)', () => {
    expect(resolveToken('docs/adding-features.md §4').path).toBe('docs/adding-features.md');
    expect(resolveToken('packages/dev-tools/tools/release-native.mjs --gate=chrome').path).toBe(
      'packages/dev-tools/tools/release-native.mjs'
    );
  });

  it('records hadTrailingSlash and strips the slash', () => {
    const r = resolveToken('packages/webapp/src/cdp/');
    expect(r.path).toBe('packages/webapp/src/cdp');
    expect(r.hadTrailingSlash).toBe(true);
  });

  it('does NOT strip mid-path colons (unusual but safe)', () => {
    // A colon followed by a slash stays intact.
    expect(resolveToken('packages/a:b/c.ts').path).toBe('packages/a:b/c.ts');
  });
});

// ---------------------------------------------------------------------------
// isAbsolutePath / hasKnownPrefix
// ---------------------------------------------------------------------------

describe('check-doc-refs: isAbsolutePath', () => {
  it('flags paths starting with /', () => {
    expect(isAbsolutePath('/workspace/skills/sprinkles/')).toBe(true);
    expect(isAbsolutePath('/shared/CLAUDE.md')).toBe(true);
  });

  it('passes relative paths', () => {
    expect(isAbsolutePath('packages/foo')).toBe(false);
    expect(isAbsolutePath('docs/bar.md')).toBe(false);
  });
});

describe('check-doc-refs: hasKnownPrefix', () => {
  it('accepts each of the four known prefixes', () => {
    expect(hasKnownPrefix('packages/webapp/src/foo.ts')).toBe(true);
    expect(hasKnownPrefix('docs/architecture.md')).toBe(true);
    expect(hasKnownPrefix('.github/workflows/ci.yml')).toBe(true);
    expect(hasKnownPrefix('.agents/skills/demo-recording/SKILL.md')).toBe(true);
  });

  it('rejects paths without a known prefix', () => {
    expect(hasKnownPrefix('coverage-thresholds.json')).toBe(false);
    expect(hasKnownPrefix('noExcessiveLinesPerFunction')).toBe(false);
    expect(hasKnownPrefix('CLAUDE.md')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isGlobPath / hasTemplatePlaceholder / isIllustrativePath
// ---------------------------------------------------------------------------

describe('check-doc-refs: isGlobPath', () => {
  it('flags paths with * or {', () => {
    expect(isGlobPath('packages/*/CLAUDE.md')).toBe(true);
    expect(isGlobPath('packages/vfs-root/workspace/skills/*/SKILL.md')).toBe(true);
    expect(isGlobPath('packages/webapp/src/{a,b}.ts')).toBe(true);
  });

  it('passes paths without glob chars', () => {
    expect(isGlobPath('packages/webapp/src/ui/main.ts')).toBe(false);
  });
});

describe('check-doc-refs: hasTemplatePlaceholder', () => {
  it('flags paths with angle-bracket placeholders', () => {
    expect(hasTemplatePlaceholder('packages/webapp/src/ui/<panel>-panel.ts')).toBe(true);
    expect(hasTemplatePlaceholder('packages/vfs-root/workspace/skills/<name>')).toBe(true);
  });

  it('passes paths without placeholders', () => {
    expect(hasTemplatePlaceholder('packages/webapp/src/ui/main.ts')).toBe(false);
  });
});

describe('check-doc-refs: isIllustrativePath', () => {
  it('flags paths where a segment starts with my-', () => {
    expect(isIllustrativePath('packages/webapp/src/ui/my-panel.ts')).toBe(true);
    expect(isIllustrativePath('packages/webapp/providers/my-corp.ts')).toBe(true);
    expect(isIllustrativePath('packages/vfs-root/workspace/skills/my-skill/SKILL.md')).toBe(true);
  });

  it('passes paths without my- segments', () => {
    expect(isIllustrativePath('packages/webapp/src/ui/main.ts')).toBe(false);
    expect(isIllustrativePath('packages/webapp/src/skills/discover.ts')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// globToRegex
// ---------------------------------------------------------------------------

describe('check-doc-refs: globToRegex', () => {
  it('matches exact path literals', () => {
    const re = globToRegex('packages/shared-swift');
    expect(re.test('packages/shared-swift')).toBe(true);
    expect(re.test('packages/shared-swift-extra')).toBe(false);
  });

  it('handles ** as any number of path segments', () => {
    const re = globToRegex('packages/playwright-core/**');
    expect(re.test('packages/playwright-core/src/tools/commands.ts')).toBe(true);
    expect(re.test('packages/playwright-core/a')).toBe(true); // single child segment
    // Without a trailing slash the glob requires at least one slash after the prefix.
    // Callers always strip trailing slashes before matching, so bare directory names
    // are matched by exact BUILTIN_ALLOWLIST entries, not by the /** glob.
    expect(re.test('packages/playwright-core')).toBe(false);
  });

  it('handles * as a single segment wildcard', () => {
    const re = globToRegex('packages/*/CLAUDE.md');
    expect(re.test('packages/webapp/CLAUDE.md')).toBe(true);
    expect(re.test('packages/a/b/CLAUDE.md')).toBe(false);
  });

  it('escapes regex metacharacters in the pattern', () => {
    const re = globToRegex('packages/dev-tools/tools/check-doc-refs-lib.mjs');
    expect(re.test('packages/dev-tools/tools/check-doc-refs-lib.mjs')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isAllowlisted
// ---------------------------------------------------------------------------

describe('check-doc-refs: isAllowlisted', () => {
  it('matches an exact entry', () => {
    expect(isAllowlisted('packages/shared-swift', BUILTIN_ALLOWLIST)).toBe(true);
  });

  it('matches a glob entry', () => {
    expect(
      isAllowlisted('packages/playwright-core/src/tools/cli-daemon/commands.ts', BUILTIN_ALLOWLIST)
    ).toBe(true);
    expect(
      isAllowlisted('packages/swift-server/.build/release/slicc-server', BUILTIN_ALLOWLIST)
    ).toBe(true);
    expect(
      isAllowlisted('packages/webapp/src/kernel/realm/sync-fs-bridge.ts', BUILTIN_ALLOWLIST)
    ).toBe(true);
  });

  it('returns false for non-allowlisted paths', () => {
    expect(isAllowlisted('packages/webapp/src/ui/main.ts', BUILTIN_ALLOWLIST)).toBe(false);
    expect(isAllowlisted('docs/architecture.md', BUILTIN_ALLOWLIST)).toBe(false);
  });

  it('merges a caller-supplied extra allowlist', () => {
    expect(isAllowlisted('packages/foo/bar.ts', ['packages/foo/**'])).toBe(true);
  });

  it('covers the gitignored preview-bridge-assets build artifact', () => {
    // packages/cloudflare-worker/src/preview-bridge-assets.ts is .gitignored
    // (regenerated by cherry/scripts/build-preview-bootstrap.mjs on postinstall)
    // but referenced in packages/cherry/CLAUDE.md.
    expect(
      isAllowlisted('packages/cloudflare-worker/src/preview-bridge-assets.ts', BUILTIN_ALLOWLIST)
    ).toBe(true);
  });

  it('covers branch-only planning artifacts (docs/superpowers/**)', () => {
    // docs/superpowers/specs/ and docs/superpowers/plans/ are intentionally
    // absent from main — the planning-artifact-cleanup workflow scrubs them.
    // BUILTIN_ALLOWLIST must cover both so the gate does not fail on main.
    expect(isAllowlisted('docs/superpowers/specs', BUILTIN_ALLOWLIST)).toBe(true);
    expect(isAllowlisted('docs/superpowers/plans', BUILTIN_ALLOWLIST)).toBe(true);
    expect(isAllowlisted('docs/superpowers/specs/2026-07-15-design.md', BUILTIN_ALLOWLIST)).toBe(
      true
    );
  });
});

// ---------------------------------------------------------------------------
// shouldSkip
// ---------------------------------------------------------------------------

describe('check-doc-refs: shouldSkip', () => {
  it('skips absolute paths', () => {
    expect(shouldSkip('/workspace/skills/sprinkles/')).toBe(true);
    expect(shouldSkip('/shared/CLAUDE.md')).toBe(true);
  });

  it('skips paths without known prefix', () => {
    expect(shouldSkip('coverage-thresholds.json')).toBe(true);
    expect(shouldSkip('noExcessiveLinesPerFunction')).toBe(true);
  });

  it('skips glob paths', () => {
    expect(shouldSkip('packages/*/CLAUDE.md')).toBe(true);
    expect(shouldSkip('packages/vfs-root/workspace/skills/*/SKILL.md')).toBe(true);
  });

  it('skips template placeholder paths', () => {
    expect(shouldSkip('packages/webapp/src/ui/<panel>-panel.ts')).toBe(true);
  });

  it('skips illustrative my-* paths', () => {
    expect(shouldSkip('packages/webapp/src/ui/my-panel.ts')).toBe(true);
    expect(shouldSkip('packages/vfs-root/workspace/skills/my-skill/SKILL.md')).toBe(true);
  });

  it('skips allowlisted paths', () => {
    expect(shouldSkip('packages/shared-swift')).toBe(true);
    expect(shouldSkip('packages/playwright-core/src/tools/cli-daemon/commands.ts')).toBe(true);
  });

  it('does NOT skip checkable real repo paths', () => {
    expect(shouldSkip('packages/webapp/src/ui/main.ts')).toBe(false);
    expect(shouldSkip('docs/architecture.md')).toBe(false);
    expect(shouldSkip('.github/workflows/ci.yml')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractCandidates
// ---------------------------------------------------------------------------

describe('check-doc-refs: extractCandidates', () => {
  it('extracts repo-prefixed paths from single-backtick spans', () => {
    const md = 'See `packages/webapp/src/ui/main.ts` for details.';
    const results = extractCandidates(md);
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe('packages/webapp/src/ui/main.ts');
    expect(results[0].hadTrailingSlash).toBe(false);
  });

  it('strips :line suffix before checking', () => {
    const md = 'See `docs/pitfalls.md:42` for context.';
    expect(extractCandidates(md)[0].path).toBe('docs/pitfalls.md');
  });

  it('strips content after first whitespace', () => {
    const md = 'See `docs/adding-features.md §4` for the pattern.';
    expect(extractCandidates(md)[0].path).toBe('docs/adding-features.md');
  });

  it('skips absolute paths (VFS runtime paths)', () => {
    const md = 'Mount at `/workspace/skills/` or `/shared/CLAUDE.md`.';
    expect(extractCandidates(md)).toHaveLength(0);
  });

  it('skips tokens without known prefix', () => {
    const md = 'Use `noExcessiveLinesPerFunction` and `coverage-thresholds.json`.';
    expect(extractCandidates(md)).toHaveLength(0);
  });

  it('skips glob paths (auto-allowed)', () => {
    const md =
      'Matches `packages/*/CLAUDE.md` and `packages/vfs-root/workspace/skills/*/SKILL.md`.';
    expect(extractCandidates(md)).toHaveLength(0);
  });

  it('skips template placeholder paths', () => {
    const md = 'Create `packages/webapp/src/ui/<panel>-panel.ts`.';
    expect(extractCandidates(md)).toHaveLength(0);
  });

  it('skips illustrative my-* paths', () => {
    const md = 'Create `packages/webapp/src/ui/my-panel.ts`.';
    expect(extractCandidates(md)).toHaveLength(0);
  });

  it('skips allowlisted paths', () => {
    const md =
      'See `packages/playwright-core/src/tools/cli-daemon/commands.ts` in the microsoft/playwright repo.';
    expect(extractCandidates(md)).toHaveLength(0);
  });

  it('deduplicates the same path appearing multiple times', () => {
    const md =
      'Modify `packages/webapp/src/ui/main.ts` and `packages/webapp/src/ui/main.ts` again.';
    expect(extractCandidates(md)).toHaveLength(1);
  });

  it('records hadTrailingSlash for directory hints', () => {
    const md = 'See `packages/webapp/src/cdp/` for CDP code.';
    const r = extractCandidates(md)[0];
    expect(r.path).toBe('packages/webapp/src/cdp');
    expect(r.hadTrailingSlash).toBe(true);
  });

  it('respects an extra allowlist', () => {
    const md = 'See `packages/foo/bar.ts` for details.';
    expect(extractCandidates(md, ['packages/foo/**'])).toHaveLength(0);
  });

  it('ignores content inside triple-backtick code fences', () => {
    // Triple-backtick content is not matched by single-backtick regex.
    const md = [
      '```typescript',
      '// packages/webapp/src/ui/layout.ts',
      'import { x } from "./x.js";',
      '```',
    ].join('\n');
    expect(extractCandidates(md)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: run the guard against the real repo tree
// ---------------------------------------------------------------------------

describe('check-doc-refs: end-to-end over the real tree', () => {
  it('passes (no dead references) and reports the checked count', () => {
    const { code, out } = runGuard();
    expect(code).toBe(0);
    expect(out).toMatch(/^ok: no dead references in \d+ doc files \(\d+ paths checked\)$/m);
  });

  it('ignores CLAUDE.md files in linked-worktree directories', () => {
    const fixtureDirs = [
      resolve(repoRoot, '.worktrees/check-doc-refs-test'),
      resolve(repoRoot, '.claude/worktrees/check-doc-refs-test'),
    ];

    try {
      for (const fixtureDir of fixtureDirs) {
        mkdirSync(fixtureDir, { recursive: true });
        writeFileSync(
          resolve(fixtureDir, 'CLAUDE.md'),
          'Dead reference: `packages/does-not-exist.ts`\n'
        );
      }

      const { code, out } = runGuard();
      expect(code, out).toBe(0);
    } finally {
      for (const fixtureDir of fixtureDirs) {
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    }
  });
});
