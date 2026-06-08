import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), '..', '..', '..');
const hookPath = resolve(repoRoot, '.husky/pre-commit');
const pkgPath = resolve(repoRoot, 'package.json');
const hook = readFileSync(hookPath, 'utf8');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const docGlob = '**/*.{md,html,yaml,yml}';
const checkScript = 'node packages/dev-tools/tools/check-doc-sizes.mjs';

describe('pre-commit doc-size wiring (husky hook)', () => {
  it('invokes the doc-size script with node', () => {
    expect(hook).toContain(checkScript);
  });

  it('guards the doc-size check with a staged-files grep on CLAUDE.md', () => {
    const guardPattern =
      /if\s+git\s+diff\s+--cached\s+--name-only\s*\|\s*grep\s+-qE\s+'\^\(CLAUDE\\\.md\|packages\/vfs-root\/shared\/CLAUDE\\\.md\)\$'/;
    expect(hook).toMatch(guardPattern);
  });

  it('runs the doc-size check AFTER npx lint-staged', () => {
    const lintStagedIdx = hook.indexOf('npx lint-staged');
    const checkIdx = hook.indexOf(checkScript);
    expect(lintStagedIdx).toBeGreaterThanOrEqual(0);
    expect(checkIdx).toBeGreaterThanOrEqual(0);
    expect(checkIdx).toBeGreaterThan(lintStagedIdx);
  });

  it('places the doc-size check inside the staged-files guard block', () => {
    const guardIdx = hook.search(/if\s+git\s+diff\s+--cached\s+--name-only/);
    const fiIdx = hook.indexOf('\nfi', guardIdx);
    const checkIdx = hook.indexOf(checkScript);
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(fiIdx).toBeGreaterThan(guardIdx);
    expect(checkIdx).toBeGreaterThan(guardIdx);
    expect(checkIdx).toBeLessThan(fiIdx);
  });
});

describe('lint-staged no longer runs the doc-size check', () => {
  it('has the markdown lint-staged entry as an array', () => {
    const entry = pkg['lint-staged']?.[docGlob];
    expect(Array.isArray(entry)).toBe(true);
  });

  it('does not invoke check-doc-sizes.mjs from any lint-staged entry', () => {
    const config = pkg['lint-staged'] ?? {};
    for (const [glob, commands] of Object.entries(config)) {
      const list = Array.isArray(commands) ? commands : [commands];
      for (const cmd of list) {
        expect(
          typeof cmd === 'string' && cmd.includes('check-doc-sizes.mjs'),
          `lint-staged entry ${glob} unexpectedly runs check-doc-sizes.mjs: ${cmd}`
        ).toBe(false);
      }
    }
  });
});
