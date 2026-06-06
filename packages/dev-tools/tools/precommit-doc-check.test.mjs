import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), '..', '..', '..');
const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
const docGlob = '**/*.{md,html,yaml,yml}';

describe('pre-commit doc-size wiring', () => {
  it('has the markdown lint-staged entry as an array', () => {
    const entry = pkg['lint-staged']?.[docGlob];
    expect(Array.isArray(entry)).toBe(true);
  });

  it('runs check-doc-sizes.mjs after prettier --write', () => {
    const entry = pkg['lint-staged'][docGlob];
    const prettierIdx = entry.findIndex((cmd) => cmd.includes('prettier --write'));
    const checkIdx = entry.findIndex((cmd) =>
      cmd.includes('packages/dev-tools/tools/check-doc-sizes.mjs')
    );
    expect(prettierIdx).toBeGreaterThanOrEqual(0);
    expect(checkIdx).toBeGreaterThanOrEqual(0);
    expect(checkIdx).toBeGreaterThan(prettierIdx);
  });

  it('invokes the doc-size script with node', () => {
    const entry = pkg['lint-staged'][docGlob];
    const checkCmd = entry.find((cmd) =>
      cmd.includes('packages/dev-tools/tools/check-doc-sizes.mjs')
    );
    expect(checkCmd).toMatch(/^node\s+packages\/dev-tools\/tools\/check-doc-sizes\.mjs$/);
  });
});
