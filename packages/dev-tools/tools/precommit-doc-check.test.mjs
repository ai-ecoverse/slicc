import { execFileSync } from 'node:child_process';
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

// Capture the script's output even when it exits non-zero (execFileSync throws,
// but stashes stdout/stderr on the error), so assertions see the `ok:` lines.
function runCheckDocSizes() {
  try {
    return execFileSync(
      'node',
      [resolve(repoRoot, 'packages/dev-tools/tools/check-doc-sizes.mjs')],
      {
        encoding: 'utf8',
      }
    );
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

describe('pre-commit doc-size wiring (husky hook)', () => {
  it('invokes the doc-size script with node', () => {
    expect(hook).toContain(checkScript);
  });

  it('guards the doc-size check with a staged-files grep covering every budgeted file', () => {
    expect(hook).toMatch(/git\s+diff\s+--cached\s+--name-only\s*\|\s*grep\s+-qE/);
    // Every budgeted path must appear in the guard alternation so that staging
    // it triggers the size check locally (CI runs the check unconditionally).
    for (const token of [
      'CLAUDE\\.md',
      'packages/vfs-root/shared/CLAUDE\\.md',
      '.github/copilot-instructions\\.md',
      '.github/instructions/.*\\.instructions\\.md',
      'packages/.*/CLAUDE\\.md',
    ]) {
      expect(hook).toContain(token);
    }
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

describe('check-doc-sizes budgets the GitHub Copilot instruction files', () => {
  const output = runCheckDocSizes();

  it('budgets the repo-wide Copilot instructions at 4000 chars', () => {
    expect(output).toMatch(/ok: \.github\/copilot-instructions\.md is \d+\/4000 chars/);
  });

  it('budgets path-specific *.instructions.md files at 4000 chars', () => {
    expect(output).toMatch(
      /ok: \.github\/instructions\/cross-runtime\.instructions\.md is \d+\/4000 chars/
    );
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
