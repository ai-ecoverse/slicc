import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findCodeOccurrences } from './check-hosted-origin-literal.mjs';

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), '..', '..', '..');
const scriptPath = resolve(repoRoot, 'packages/dev-tools/tools/check-hosted-origin-literal.mjs');

function runGuard() {
  try {
    return {
      code: 0,
      out: execFileSync('node', [scriptPath], { encoding: 'utf8' }),
    };
  } catch (err) {
    return {
      code: err.status ?? 1,
      out: `${err.stdout ?? ''}${err.stderr ?? ''}`,
    };
  }
}

describe('check-hosted-origin-literal: findCodeOccurrences', () => {
  it('flags a raw literal in a single-quoted string', () => {
    const hits = findCodeOccurrences("const url = 'https://www.sliccy.ai';");
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
  });

  it('flags a raw literal in a template literal', () => {
    expect(findCodeOccurrences('const u = `https://www.sliccy.ai/path`;')).toHaveLength(1);
  });

  it('ignores line comments', () => {
    expect(findCodeOccurrences('// https://www.sliccy.ai is the origin')).toEqual([]);
    expect(findCodeOccurrences('  // served by www.sliccy.ai')).toEqual([]);
  });

  it('ignores block comments', () => {
    expect(findCodeOccurrences('/* www.sliccy.ai */ const x = 1;')).toEqual([]);
  });

  it('ignores block-comment continuation lines', () => {
    expect(findCodeOccurrences(' * hosted at https://www.sliccy.ai')).toEqual([]);
  });

  it('returns nothing for clean code using the constant', () => {
    expect(findCodeOccurrences("import { SLICC_HOSTED_ORIGIN } from '@slicc/shared-ts';")).toEqual(
      []
    );
  });

  it('handles multi-line block comments spanning multiple lines', () => {
    const source = [
      'const a = 1;',
      '/**',
      ' * The leader runs at https://www.sliccy.ai',
      ' */',
      'const b = 2;',
    ].join('\n');
    expect(findCodeOccurrences(source)).toEqual([]);
  });
});

describe('check-hosted-origin-literal: end-to-end', () => {
  it('passes against the real source tree', () => {
    const { code, out } = runGuard();
    expect(code).toBe(0);
    expect(out).toMatch(/ok: no raw 'www\.sliccy\.ai' literals in \d+ package source files/);
  });
});
