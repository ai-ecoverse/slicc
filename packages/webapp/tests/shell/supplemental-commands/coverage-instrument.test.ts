import { beforeAll, describe, expect, it } from 'vitest';
import {
  coverageSummary,
  extractCoverageCounts,
  instrumentSource,
  mergeCounts,
  resolveCoverageDir,
  type StatementMap,
  toLcov,
} from '../../../src/shell/supplemental-commands/coverage-instrument.js';
import {
  getTypeScript,
  resetTypeScriptForTests,
  type TypeScriptModule,
} from '../../../src/shell/supplemental-commands/shared.js';

let ts: TypeScriptModule;

beforeAll(async () => {
  resetTypeScriptForTests();
  ts = await getTypeScript();
});

describe('instrumentSource', () => {
  it('inserts a hit() before each executable statement and maps original lines', () => {
    const src = [
      'export function add(a, b) {',
      '  return a + b;',
      '}',
      'export function unused(x) {',
      '  return x;',
      '}',
      '',
    ].join('\n');
    const { source, map } = instrumentSource(ts, src, '/workspace/add.js');
    expect(source).toContain('__slicc_cov.init("/workspace/add.js"');
    expect(source).toContain('__slicc_cov.hit("/workspace/add.js"');
    expect(map.length).toBeGreaterThanOrEqual(3);
    const lines = new Set(map.map((s) => s.line));
    expect(lines.has(1)).toBe(true);
    expect(lines.has(2)).toBe(true);
    expect(lines.has(4)).toBe(true);
    expect(lines.has(5)).toBe(true);
  });

  it('skips import declarations', () => {
    const src = "import test from 'tst';\nconst x = 1;\n";
    const { source, map } = instrumentSource(ts, src, '/workspace/t.js');
    expect(map.every((s) => s.line !== 1)).toBe(true);
    expect(source).toContain("import test from 'tst'");
  });

  it('wraps an unbraced if-body so the skipped arm gets a counter', () => {
    const src = 'if (false)\n  missed();\ntaken();\n';
    const { source, map } = instrumentSource(ts, src, '/workspace/branch.js');
    expect(source).toContain('{');
    expect(map.some((s) => s.line === 2)).toBe(true);
    expect(source).toContain('__slicc_cov.hit("/workspace/branch.js"');
    expect(source).not.toContain('globalThis.__sliccCov');
  });
});

describe('extractCoverageCounts / lcov / summary', () => {
  it('strips the coverage marker line from TAP', () => {
    const tap = 'ok 1 - a\n1..1\n__SLICC_COVERAGE__{"/workspace/a.js":[1,0]}\n# pass 1\n';
    const { stdout, counts } = extractCoverageCounts(tap);
    expect(stdout).not.toContain('__SLICC_COVERAGE__');
    expect(stdout).toContain('ok 1 - a');
    expect(counts['/workspace/a.js']).toEqual([1, 0]);
  });

  it('merges per-file counts across realms', () => {
    const into: Record<string, number[]> = { '/a.js': [1, 0] };
    mergeCounts(into, { '/a.js': [0, 1], '/b.js': [2] });
    expect(into).toEqual({ '/a.js': [1, 1], '/b.js': [2] });
  });

  it('emits lcov DA lines from the statement map', () => {
    const maps: Record<string, StatementMap> = {
      '/workspace/add.js': [
        { id: 0, line: 1, endLine: 3 },
        { id: 1, line: 2, endLine: 2 },
        { id: 2, line: 4, endLine: 6 },
      ],
    };
    const lcov = toLcov({ '/workspace/add.js': [1, 4, 0] }, maps);
    expect(lcov).toContain('SF:/workspace/add.js');
    expect(lcov).toContain('DA:1,1');
    expect(lcov).toContain('DA:2,4');
    expect(lcov).toContain('DA:4,0');
    expect(lcov).toContain('LH:2');
    expect(lcov).toContain('LF:3');
  });

  it('resolves a relative coverage dir against cwd', () => {
    const resolvePath = (base: string, path: string) => `${base.replace(/\/$/, '')}/${path}`;
    expect(resolveCoverageDir('/workspace/project', 'reports', resolvePath)).toBe(
      '/workspace/project/reports'
    );
    expect(resolveCoverageDir('/workspace/project', '/abs/cov', resolvePath)).toBe('/abs/cov');
    expect(resolveCoverageDir('/workspace', '', resolvePath)).toBe('/workspace/coverage');
  });

  it('summarises statement percentages', () => {
    const maps: Record<string, StatementMap> = {
      '/a.js': [
        { id: 0, line: 1, endLine: 1 },
        { id: 1, line: 2, endLine: 2 },
      ],
    };
    const text = coverageSummary({ '/a.js': [1, 0] }, maps);
    expect(text).toContain('coverage statements 50% (1/2)');
    expect(text).toContain('/a.js  50% (1/2)');
  });
});
