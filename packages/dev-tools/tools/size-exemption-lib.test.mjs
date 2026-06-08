import { describe, expect, it } from 'vitest';
import {
  extractSizeExemptionGlobs,
  findTouchedExemptions,
  globToRegex,
  isSizeExemptionOverride,
  matchesAnyGlob,
} from './size-exemption-lib.mjs';

describe('isSizeExemptionOverride', () => {
  it('accepts an override that disables only the size rule', () => {
    expect(
      isSizeExemptionOverride({
        includes: ['packages/x.ts'],
        linter: { rules: { complexity: { noExcessiveLinesPerFunction: 'off' } } },
      })
    ).toBe(true);
  });

  it('rejects overrides that touch any other rule (e.g. the test block)', () => {
    expect(
      isSizeExemptionOverride({
        includes: ['**/*.test.ts'],
        linter: {
          rules: {
            complexity: {
              noExcessiveCognitiveComplexity: 'off',
              noExcessiveLinesPerFunction: 'off',
            },
            suspicious: { noExplicitAny: 'off' },
          },
        },
      })
    ).toBe(false);
  });

  it('rejects overrides with the size rule at a non-off level', () => {
    expect(
      isSizeExemptionOverride({
        includes: ['packages/x.ts'],
        linter: { rules: { complexity: { noExcessiveLinesPerFunction: 'warn' } } },
      })
    ).toBe(false);
  });

  it('rejects overrides without the linter block', () => {
    expect(isSizeExemptionOverride({ includes: ['x'] })).toBe(false);
    expect(isSizeExemptionOverride({})).toBe(false);
    expect(isSizeExemptionOverride(null)).toBe(false);
  });
});

describe('extractSizeExemptionGlobs', () => {
  it('returns the union of includes from every debt-list override', () => {
    const cfg = {
      overrides: [
        {
          includes: ['**/*.test.ts'],
          linter: { rules: { suspicious: { noExplicitAny: 'off' } } },
        },
        {
          includes: ['packages/a.ts', 'packages/b.ts'],
          linter: { rules: { complexity: { noExcessiveLinesPerFunction: 'off' } } },
        },
        {
          includes: ['packages/b.ts', 'packages/c.ts'],
          linter: { rules: { complexity: { noExcessiveLinesPerFunction: 'off' } } },
        },
      ],
    };
    expect(extractSizeExemptionGlobs(cfg)).toEqual([
      'packages/a.ts',
      'packages/b.ts',
      'packages/c.ts',
    ]);
  });

  it('returns an empty array when no debt block exists', () => {
    expect(extractSizeExemptionGlobs({ overrides: [] })).toEqual([]);
    expect(extractSizeExemptionGlobs({})).toEqual([]);
  });
});

describe('globToRegex', () => {
  it('matches exact file paths literally', () => {
    const re = globToRegex('packages/webapp/src/ui/main.ts');
    expect(re.test('packages/webapp/src/ui/main.ts')).toBe(true);
    expect(re.test('packages/webapp/src/ui/main.tsx')).toBe(false);
    expect(re.test('xpackages/webapp/src/ui/main.ts')).toBe(false);
  });

  it('handles ** as zero or more path segments', () => {
    const re = globToRegex('**/*.test.ts');
    expect(re.test('foo.test.ts')).toBe(true);
    expect(re.test('a/b/foo.test.ts')).toBe(true);
    expect(re.test('foo.ts')).toBe(false);
  });

  it('handles * as a single path segment wildcard', () => {
    const re = globToRegex('packages/*/src/index.ts');
    expect(re.test('packages/webapp/src/index.ts')).toBe(true);
    expect(re.test('packages/a/b/src/index.ts')).toBe(false);
  });

  it('escapes regex metacharacters', () => {
    const re = globToRegex('a.b+c.ts');
    expect(re.test('a.b+c.ts')).toBe(true);
    expect(re.test('axbycts')).toBe(false);
  });
});

describe('matchesAnyGlob', () => {
  it('returns true when any glob matches', () => {
    expect(
      matchesAnyGlob('packages/webapp/src/ui/main.ts', ['**/x.ts', 'packages/**/main.ts'])
    ).toBe(true);
  });
  it('returns false when no glob matches', () => {
    expect(matchesAnyGlob('packages/a.ts', ['packages/b.ts'])).toBe(false);
  });
});

describe('findTouchedExemptions', () => {
  const exemptions = [
    'packages/webapp/src/ui/main.ts',
    'packages/webapp/src/scoops/orchestrator.ts',
  ];

  it('returns the intersection of changed files and the debt list', () => {
    expect(
      findTouchedExemptions(
        ['packages/webapp/src/ui/main.ts', 'packages/webapp/src/ui/new-stage.ts'],
        exemptions
      )
    ).toEqual(['packages/webapp/src/ui/main.ts']);
  });

  it('returns [] when no changed files are exempted', () => {
    expect(findTouchedExemptions(['packages/webapp/src/ui/new-stage.ts'], exemptions)).toEqual([]);
  });

  it('returns [] for empty inputs', () => {
    expect(findTouchedExemptions([], exemptions)).toEqual([]);
    expect(findTouchedExemptions(['x'], [])).toEqual([]);
  });
});
