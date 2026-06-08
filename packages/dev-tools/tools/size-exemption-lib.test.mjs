import { describe, expect, it } from 'vitest';
import {
  COMPLEXITY_RULE_KEY,
  extractExemptionGlobsFor,
  extractSizeExemptionGlobs,
  findAddedExemptions,
  findTouchedExemptions,
  globToRegex,
  isExemptionOverrideFor,
  isSizeExemptionOverride,
  matchesAnyGlob,
  SIZE_RULE_KEY,
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

describe('isExemptionOverrideFor (parameterized by rule key)', () => {
  const sizeOnly = {
    includes: ['packages/x.ts'],
    linter: { rules: { complexity: { noExcessiveLinesPerFunction: 'off' } } },
  };
  const complexityOnly = {
    includes: ['packages/y.ts'],
    linter: { rules: { complexity: { noExcessiveCognitiveComplexity: 'off' } } },
  };
  const multiRule = {
    includes: ['**/*.test.ts'],
    linter: {
      rules: {
        complexity: {
          noExcessiveCognitiveComplexity: 'off',
          noExcessiveLinesPerFunction: 'off',
        },
      },
    },
  };

  it('matches a complexity-only debt block for the complexity key but not the size key', () => {
    expect(isExemptionOverrideFor(complexityOnly, COMPLEXITY_RULE_KEY)).toBe(true);
    expect(isExemptionOverrideFor(complexityOnly, SIZE_RULE_KEY)).toBe(false);
  });

  it('matches a size-only debt block for the size key but not the complexity key', () => {
    expect(isExemptionOverrideFor(sizeOnly, SIZE_RULE_KEY)).toBe(true);
    expect(isExemptionOverrideFor(sizeOnly, COMPLEXITY_RULE_KEY)).toBe(false);
  });

  it('rejects a multi-rule block for either key', () => {
    expect(isExemptionOverrideFor(multiRule, SIZE_RULE_KEY)).toBe(false);
    expect(isExemptionOverrideFor(multiRule, COMPLEXITY_RULE_KEY)).toBe(false);
  });

  it('rejects rules at a non-off level for the requested key', () => {
    expect(
      isExemptionOverrideFor(
        {
          includes: ['packages/y.ts'],
          linter: { rules: { complexity: { noExcessiveCognitiveComplexity: 'warn' } } },
        },
        COMPLEXITY_RULE_KEY
      )
    ).toBe(false);
  });
});

describe('extractExemptionGlobsFor (parameterized by rule key)', () => {
  const cfg = {
    overrides: [
      {
        includes: ['**/*.test.ts'],
        linter: { rules: { suspicious: { noExplicitAny: 'off' } } },
      },
      {
        includes: ['packages/size-a.ts', 'packages/size-b.ts'],
        linter: { rules: { complexity: { noExcessiveLinesPerFunction: 'off' } } },
      },
      {
        includes: ['packages/cx-a.ts', 'packages/cx-b.ts'],
        linter: { rules: { complexity: { noExcessiveCognitiveComplexity: 'off' } } },
      },
      {
        includes: ['packages/size-b.ts', 'packages/size-c.ts'],
        linter: { rules: { complexity: { noExcessiveLinesPerFunction: 'off' } } },
      },
    ],
  };

  it('returns only size-rule globs for the size key', () => {
    expect(extractExemptionGlobsFor(cfg, SIZE_RULE_KEY)).toEqual([
      'packages/size-a.ts',
      'packages/size-b.ts',
      'packages/size-c.ts',
    ]);
  });

  it('returns only complexity-rule globs for the complexity key', () => {
    expect(extractExemptionGlobsFor(cfg, COMPLEXITY_RULE_KEY)).toEqual([
      'packages/cx-a.ts',
      'packages/cx-b.ts',
    ]);
  });

  it('returns [] when no debt block exists for the key', () => {
    expect(extractExemptionGlobsFor({ overrides: [] }, COMPLEXITY_RULE_KEY)).toEqual([]);
    expect(extractExemptionGlobsFor({}, COMPLEXITY_RULE_KEY)).toEqual([]);
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

describe('findAddedExemptions', () => {
  it('returns globs present in current but not in base', () => {
    expect(
      findAddedExemptions(
        ['packages/a.ts', 'packages/b.ts'],
        ['packages/a.ts', 'packages/b.ts', 'packages/c.ts', 'packages/d.ts']
      )
    ).toEqual(['packages/c.ts', 'packages/d.ts']);
  });

  it('returns [] when current is a subset of (or equal to) base', () => {
    expect(
      findAddedExemptions(['packages/a.ts', 'packages/b.ts'], ['packages/a.ts', 'packages/b.ts'])
    ).toEqual([]);
    expect(findAddedExemptions(['packages/a.ts', 'packages/b.ts'], ['packages/a.ts'])).toEqual([]);
  });

  it('returns all current entries when base is empty (caller decides bootstrapping)', () => {
    expect(findAddedExemptions([], ['packages/a.ts', 'packages/b.ts'])).toEqual([
      'packages/a.ts',
      'packages/b.ts',
    ]);
  });

  it('returns [] when current is empty', () => {
    expect(findAddedExemptions(['packages/a.ts'], [])).toEqual([]);
  });

  it('treats non-array inputs as empty', () => {
    expect(findAddedExemptions(null, ['packages/a.ts'])).toEqual(['packages/a.ts']);
    expect(findAddedExemptions(undefined, ['packages/a.ts'])).toEqual(['packages/a.ts']);
    expect(findAddedExemptions(['packages/a.ts'], null)).toEqual([]);
    expect(findAddedExemptions(['packages/a.ts'], undefined)).toEqual([]);
    expect(findAddedExemptions(null, null)).toEqual([]);
  });

  it('dedupes current and preserves first-seen order', () => {
    expect(
      findAddedExemptions(
        ['packages/a.ts'],
        ['packages/c.ts', 'packages/b.ts', 'packages/c.ts', 'packages/b.ts', 'packages/d.ts']
      )
    ).toEqual(['packages/c.ts', 'packages/b.ts', 'packages/d.ts']);
  });

  it('skips empty/non-string current entries', () => {
    expect(findAddedExemptions([], ['packages/a.ts', '', 'packages/b.ts'])).toEqual([
      'packages/a.ts',
      'packages/b.ts',
    ]);
  });
});
