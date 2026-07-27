import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildVitestArgs } from './coverage-gate.mjs';

const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'packages/dev-tools/tools/coverage-gate.mjs'
);

describe('buildVitestArgs', () => {
  it('runs the named project with coverage', () => {
    expect(buildVitestArgs('shared', {})).toEqual(['run', '--project', 'shared', '--coverage']);
  });

  it('turns each numeric floor into a threshold flag', () => {
    const args = buildVitestArgs('webapp', { lines: 80, branches: 70.5 });
    expect(args).toContain('--coverage.thresholds.lines=80');
    expect(args).toContain('--coverage.thresholds.branches=70.5');
    expect(args.some((a) => a.startsWith('--coverage.thresholds.functions'))).toBe(false);
  });

  it('ignores non-numeric floor values', () => {
    const args = buildVitestArgs('webapp', { lines: '80', functions: null });
    expect(args.some((a) => a.startsWith('--coverage.thresholds.'))).toBe(false);
  });

  it('forwards a bespoke exclude list', () => {
    const args = buildVitestArgs('chrome-extension', {
      coverageExclude: ['packages/webapp/src/ui/**', 'packages/webapp/src/tools/**'],
    });
    expect(args).toContain('--coverage.exclude=packages/webapp/src/ui/**');
    expect(args).toContain('--coverage.exclude=packages/webapp/src/tools/**');
  });

  it('appends passthrough args last so a caller can override run-wide options', () => {
    const args = buildVitestArgs('node-server', { lines: 90 }, [
      '--reporter=json',
      '--outputFile=test-timing/vitest.json',
    ]);
    expect(args.slice(-2)).toEqual(['--reporter=json', '--outputFile=test-timing/vitest.json']);
  });
});

describe('coverage-gate: entry script', () => {
  it('exits 2 with usage when no package is given', () => {
    const result = spawnSync('node', [scriptPath], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: coverage-gate.mjs');
  });

  it('exits 2 when the package has no floors', () => {
    const result = spawnSync('node', [scriptPath, 'not-a-real-package'], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('No TypeScript coverage floors');
  });
});
