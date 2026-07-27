import { describe, expect, it } from 'vitest';
import {
  DEBT_LIST_SOURCES,
  evaluateDebtSource,
  evaluateRuleDebtList,
  extractBiomeRuleDisablingGlobs,
  extractCoverageExcludeEntries,
  extractJscpdIgnoreEntries,
  extractKnipIgnoreEntries,
  findAddedEntries,
  formatGrowthReport,
  scopedEntry,
  scopeOfEntry,
} from './debt-list-sources.mjs';

const sourceById = (id) => DEBT_LIST_SOURCES.find((s) => s.id === id);

describe('scopeOfEntry / scopedEntry', () => {
  it('round-trips a scoped entry', () => {
    const entry = scopedEntry('typescript.webapp', '**/dist/**');
    expect(entry).toBe('typescript.webapp::**/dist/**');
    expect(scopeOfEntry(entry)).toBe('typescript.webapp');
  });

  it('treats an unscoped entry as the empty scope', () => {
    expect(scopedEntry('', '**/dist/**')).toBe('**/dist/**');
    expect(scopeOfEntry('**/dist/**')).toBe('');
    expect(scopeOfEntry(null)).toBe('');
  });
});

describe('findAddedEntries', () => {
  it('reports entries added to an existing list', () => {
    expect(findAddedEntries(['a', 'b'], ['a', 'b', 'c'])).toEqual(['c']);
  });

  it('exempts a list that is being introduced (base empty)', () => {
    expect(findAddedEntries([], ['a', 'b'])).toEqual([]);
  });

  it('exempts a scope that does not exist in the base at all', () => {
    const base = ['typescript.webapp::**/dist/**'];
    const current = [
      'typescript.webapp::**/dist/**',
      'go.slicc-cli::**/mock_*.go',
      'go.slicc-cli::**/*_test.go',
    ];
    expect(findAddedEntries(base, current)).toEqual([]);
  });

  it('still catches growth inside a scope the base already has', () => {
    const base = ['typescript.webapp::**/dist/**', 'go.slicc-cli::**/mock_*.go'];
    const current = [...base, 'typescript.webapp::packages/webapp/src/ui/**'];
    expect(findAddedEntries(base, current)).toEqual([
      'typescript.webapp::packages/webapp/src/ui/**',
    ]);
  });
});

describe('extractBiomeRuleDisablingGlobs', () => {
  const config = {
    overrides: [
      {
        includes: ['**/*.test.ts'],
        linter: {
          rules: {
            suspicious: { noExplicitAny: 'off' },
            complexity: { noExcessiveLinesPerFunction: 'off' },
          },
        },
      },
      {
        includes: ['packages/webapp/providers/**/*.ts'],
        linter: { rules: { style: { useNamingConvention: 'off' } } },
      },
      {
        includes: ['**/tsconfig*.json'],
        linter: { enabled: false },
      },
      {
        includes: ['packages/webapp/cloud/app.js'],
        linter: { rules: { complexity: { noExcessiveLinesPerFunction: 'off' } } },
      },
    ],
  };

  it('collects globs from blocks that disable non-complexity rules', () => {
    expect(extractBiomeRuleDisablingGlobs(config)).toEqual([
      '**/*.test.ts',
      'packages/webapp/providers/**/*.ts',
      '**/tsconfig*.json',
    ]);
  });

  it('excludes pure complexity debt blocks (gated separately)', () => {
    expect(extractBiomeRuleDisablingGlobs(config)).not.toContain('packages/webapp/cloud/app.js');
  });

  it('ignores blocks that only downgrade a rule to warn', () => {
    expect(
      extractBiomeRuleDisablingGlobs({
        overrides: [{ includes: ['x.ts'], linter: { rules: { style: { useConst: 'warn' } } } }],
      })
    ).toEqual([]);
  });

  it('tolerates a missing or malformed overrides array', () => {
    expect(extractBiomeRuleDisablingGlobs({})).toEqual([]);
    expect(extractBiomeRuleDisablingGlobs(null)).toEqual([]);
    expect(extractBiomeRuleDisablingGlobs({ overrides: [null, {}, { linter: 3 }] })).toEqual([]);
  });
});

describe('extractCoverageExcludeEntries', () => {
  it('walks every group and package generically', () => {
    const thresholds = {
      $comment: 'ignored',
      typescript: {
        webapp: { lines: 79, coverageExclude: ['**/dist/**', '**/*.d.ts'] },
        cherry: { lines: 83 },
      },
      go: { 'slicc-cli': { lines: 70, coverageExclude: ['**/*_test.go'] } },
      swift: { 'swift-server': { lines: 60 } },
    };
    expect(extractCoverageExcludeEntries(thresholds)).toEqual([
      'typescript.webapp::**/dist/**',
      'typescript.webapp::**/*.d.ts',
      'go.slicc-cli::**/*_test.go',
    ]);
  });

  it('returns [] for an empty or malformed file', () => {
    expect(extractCoverageExcludeEntries({})).toEqual([]);
    expect(extractCoverageExcludeEntries(null)).toEqual([]);
  });
});

describe('extractJscpdIgnoreEntries', () => {
  it('returns the ignore list, deduped', () => {
    expect(
      extractJscpdIgnoreEntries({ ignore: ['**/dist/**', '**/dist/**', '**/*.d.ts'] })
    ).toEqual(['**/dist/**', '**/*.d.ts']);
  });

  it('returns [] when there is no ignore list', () => {
    expect(extractJscpdIgnoreEntries({})).toEqual([]);
  });
});

describe('extractKnipIgnoreEntries', () => {
  it('scopes root and per-workspace ignore keys', () => {
    const config = {
      ignore: ['dist/**'],
      ignoreDependencies: ['pyodide'],
      ignoreBinaries: ['swift'],
      workspaces: {
        'packages/webapp': { ignore: ['src/types/**'], ignoreDependencies: ['buffer'] },
        'packages/cherry': {},
      },
    };
    expect(extractKnipIgnoreEntries(config)).toEqual([
      'ignore::dist/**',
      'ignoreDependencies::pyodide',
      'ignoreBinaries::swift',
      'packages/webapp.ignore::src/types/**',
      'packages/webapp.ignoreDependencies::buffer',
    ]);
  });
});

describe('evaluateDebtSource', () => {
  const coverage = sourceById('coverage-exclude');

  it('fails a frozen source when its list grows', () => {
    const result = evaluateDebtSource(coverage, {
      baseEntries: ['typescript.webapp::**/dist/**'],
      currentEntries: ['typescript.webapp::**/dist/**', 'typescript.webapp::src/ui/**'],
      baseAvailable: true,
    });
    expect(result.added).toEqual(['typescript.webapp::src/ui/**']);
    expect(result.failed).toBe(true);
    expect(result.warned).toBe(false);
  });

  it('passes when the list is unchanged', () => {
    const result = evaluateDebtSource(coverage, {
      baseEntries: ['typescript.webapp::**/dist/**'],
      currentEntries: ['typescript.webapp::**/dist/**'],
      baseAvailable: true,
    });
    expect(result.failed).toBe(false);
    expect(result.added).toEqual([]);
  });

  it('degrades gracefully when the base config cannot be read', () => {
    const result = evaluateDebtSource(coverage, {
      baseEntries: [],
      currentEntries: ['typescript.webapp::src/ui/**'],
      baseAvailable: false,
    });
    expect(result.skipReason).toBe('base config unreadable');
    expect(result.added).toEqual([]);
    expect(result.failed).toBe(false);
  });

  it('warns instead of failing for a warn-only source', () => {
    const knip = sourceById('knip-ignore');
    const result = evaluateDebtSource(knip, {
      baseEntries: ['ignoreDependencies::pyodide'],
      currentEntries: ['ignoreDependencies::pyodide', 'ignoreDependencies::new-tool'],
      baseAvailable: true,
    });
    expect(result.added).toEqual(['ignoreDependencies::new-tool']);
    expect(result.failed).toBe(false);
    expect(result.warned).toBe(true);
  });

  it('never applies the touched-file rule to a freeze-only source', () => {
    for (const source of DEBT_LIST_SOURCES) {
      expect(source.semantics.touched).toBe(false);
      const result = evaluateDebtSource(source, {
        baseEntries: ['**/*.d.ts'],
        currentEntries: ['**/*.d.ts'],
        baseAvailable: true,
        changedFiles: ['**/*.d.ts', 'packages/webapp/src/types/foo.d.ts'],
      });
      expect(result.touched).toBeUndefined();
      expect(result.failed).toBe(false);
    }
  });
});

describe('evaluateRuleDebtList', () => {
  const rule = {
    id: 'function-size',
    label: 'function-size',
    location: 'biome.json `overrides` → complexity.noExcessiveLinesPerFunction = off',
    semantics: { touched: true, freeze: true, failOnGrowth: true },
    touchedFixIt: 'refactor it',
    growthFixIt: 'do not add it',
  };

  it('fails when a changed file is still on the list', () => {
    const result = evaluateRuleDebtList(rule, {
      currentGlobs: ['packages/webapp/src/a.ts'],
      baseGlobs: ['packages/webapp/src/a.ts'],
      baseAvailable: true,
      changedFiles: ['packages/webapp/src/a.ts', 'packages/webapp/src/b.ts'],
    });
    expect(result.touched).toEqual(['packages/webapp/src/a.ts']);
    expect(result.failed).toBe(true);
  });

  it('fails when the list grows', () => {
    const result = evaluateRuleDebtList(rule, {
      currentGlobs: ['packages/webapp/src/a.ts', 'packages/webapp/src/c.ts'],
      baseGlobs: ['packages/webapp/src/a.ts'],
      baseAvailable: true,
      changedFiles: ['packages/webapp/src/unrelated.ts'],
    });
    expect(result.added).toEqual(['packages/webapp/src/c.ts']);
    expect(result.failed).toBe(true);
  });

  it('passes when nothing is touched and nothing was added', () => {
    const result = evaluateRuleDebtList(rule, {
      currentGlobs: ['packages/webapp/src/a.ts'],
      baseGlobs: ['packages/webapp/src/a.ts'],
      baseAvailable: true,
      changedFiles: ['packages/webapp/src/unrelated.ts'],
    });
    expect(result.failed).toBe(false);
  });

  it('skips the growth check when the base config is unreadable', () => {
    const result = evaluateRuleDebtList(rule, {
      currentGlobs: ['packages/webapp/src/a.ts', 'packages/webapp/src/c.ts'],
      baseGlobs: [],
      baseAvailable: false,
      changedFiles: [],
    });
    expect(result.added).toEqual([]);
    expect(result.skipReason).toBe('base config unreadable');
    expect(result.failed).toBe(false);
  });
});

describe('formatGrowthReport', () => {
  it('says "must not grow" for an enforced source and names the entries', () => {
    const source = sourceById('duplication-ignore');
    const lines = formatGrowthReport({ source, added: ['packages/webapp/src/**'], warned: false });
    expect(lines.join('\n')).toContain('frozen and must not grow');
    expect(lines.join('\n')).toContain('+ packages/webapp/src/**');
    expect(lines.join('\n')).toContain('jscpd.json `ignore`');
  });

  it('softens the verdict for a warn-only source', () => {
    const source = sourceById('knip-ignore');
    const lines = formatGrowthReport({ source, added: ['ignoreDependencies::x'], warned: true });
    expect(lines.join('\n')).toContain('reported, not enforced');
  });
});
