import { describe, expect, it } from 'vitest';
import {
  BRANCH_PREFIX,
  buildCandidates,
  buildDebtMap,
  buildPrompt,
  categoryById,
  DEBT_CATEGORIES,
  isExcludedPath,
  PR_LABEL,
  RETIRED_DEBT_CATEGORIES,
  resolveGlobToSingleFile,
  scoreCandidate,
  selectDebtFile,
  slugForFile,
} from './lib.mjs';

const REPO_FILES = [
  'pkg/a.ts',
  'pkg/b.ts',
  'pkg/big.ts',
  'pkg/c.ts',
  'pkg/one.gen.ts',
  'pkg/two.gen.ts',
  'pkg/only.ts',
  'packages/webapp/tests/thing.test.ts',
  'packages/webapp/tests/other.test.ts',
  'dist/bundle.js',
  'pkg/deleted-from-baseline.ts',
];

function debtMapFixture(overrides = {}) {
  return buildDebtMap({
    layerBaseline: { 'pkg/a.ts': 2, 'pkg/c.ts': 1, 'pkg/gone.ts': 1 },
    repoFiles: REPO_FILES,
    ...overrides,
  });
}

describe('DEBT_CATEGORIES', () => {
  it('dispatches only the lists that still have per-file entries', () => {
    expect(DEBT_CATEGORIES.map((c) => c.id)).toEqual(['layer-back-edge']);
    for (const c of DEBT_CATEGORIES) {
      expect(c.source.length).toBeGreaterThan(0);
      expect(c.remediation.length).toBeGreaterThan(0);
      expect(c.kind).toBe('baseline');
      expect(c.baseline).toBe('layer');
    }
  });

  it('keeps paid-down categories retired rather than dispatching empty lists', () => {
    expect(RETIRED_DEBT_CATEGORIES).toEqual([
      'function-size',
      'cognitive-complexity',
      'floating-promise',
      'misused-promise',
      'record-string-unknown',
    ]);
    for (const id of RETIRED_DEBT_CATEGORIES) {
      expect(categoryById(id)).toBeUndefined();
    }
  });

  it('cites the supported --update command for the remaining baseline category', () => {
    expect(categoryById('layer-back-edge').remediation).toContain(
      'node packages/dev-tools/tools/check-layer-back-edges.mjs --update'
    );
  });

  it('returns undefined for an unknown id', () => {
    expect(categoryById('nope')).toBeUndefined();
  });
});

describe('resolveGlobToSingleFile', () => {
  it('resolves a literal tracked path', () => {
    expect(resolveGlobToSingleFile('pkg/a.ts', REPO_FILES)).toBe('pkg/a.ts');
  });

  it('drops a literal path that is not tracked (stale entry)', () => {
    expect(resolveGlobToSingleFile('pkg/never.ts', REPO_FILES)).toBeNull();
  });

  it('resolves a wildcard that matches exactly one file', () => {
    expect(resolveGlobToSingleFile('pkg/onl*.ts', REPO_FILES)).toBe('pkg/only.ts');
  });

  it('drops a wildcard matching many files (policy, not a per-file debt item)', () => {
    expect(resolveGlobToSingleFile('pkg/**/*.gen.ts', REPO_FILES)).toBeNull();
    expect(resolveGlobToSingleFile('**/*.test.ts', REPO_FILES)).toBeNull();
  });

  it('drops empty or non-string globs', () => {
    expect(resolveGlobToSingleFile('', REPO_FILES)).toBeNull();
    expect(resolveGlobToSingleFile(null, REPO_FILES)).toBeNull();
  });
});

describe('buildDebtMap', () => {
  const map = debtMapFixture();

  it('indexes files still on the layer-back-edge baseline', () => {
    expect(map.get('pkg/a.ts')).toEqual(['layer-back-edge']);
    expect(map.get('pkg/c.ts')).toEqual(['layer-back-edge']);
  });

  it('ignores retired biome / record-string-unknown lists even if sources are passed', () => {
    const mixed = buildDebtMap({
      biomeConfig: {
        overrides: [
          {
            includes: ['pkg/b.ts'],
            linter: { rules: { nursery: { noFloatingPromises: 'off' } } },
          },
        ],
      },
      layerBaseline: { 'pkg/a.ts': 1 },
      recordBaseline: { 'pkg/only.ts': 1 },
      repoFiles: REPO_FILES,
    });
    expect(mixed.get('pkg/a.ts')).toEqual(['layer-back-edge']);
    expect(mixed.has('pkg/b.ts')).toBe(false);
    expect(mixed.has('pkg/only.ts')).toBe(false);
  });

  it('drops baseline keys for files that no longer exist', () => {
    expect(map.has('pkg/gone.ts')).toBe(false);
  });

  it('tolerates a missing layer baseline', () => {
    const empty = buildDebtMap({
      layerBaseline: null,
      repoFiles: REPO_FILES,
    });
    expect(empty.size).toBe(0);
  });
});

describe('isExcludedPath', () => {
  it('excludes generated, vendored, minified and lockfile paths', () => {
    for (const p of [
      'dist/bundle.js',
      'packages/webapp/dist/app.js',
      'node_modules/foo/index.js',
      'coverage/lcov-report/index.html',
      'packages/x/vendor/lib.ts',
      'third_party/lib.ts',
      'packages/x/a.min.js',
      'packages/webapp/tests/theme-vectors.json',
      'package-lock.json',
      'packages/x/thing.generated.ts',
      'packages/x/foo.snap',
    ]) {
      expect(isExcludedPath(p), p).toBe(true);
    }
  });

  it('keeps ordinary source and test files', () => {
    expect(isExcludedPath('packages/webapp/src/net/link-header.ts')).toBe(false);
    expect(isExcludedPath('packages/webapp/tests/fs/sudo-fs.test.ts')).toBe(false);
  });

  it('treats an empty path as excluded', () => {
    expect(isExcludedPath('')).toBe(true);
    expect(isExcludedPath(null)).toBe(true);
  });
});

describe('scoreCandidate / buildCandidates', () => {
  it('prefers the smaller file at equal breadth', () => {
    const small = scoreCandidate({ bytes: 2048, categories: ['function-size'] });
    const large = scoreCandidate({ bytes: 20_480, categories: ['function-size'] });
    expect(small).toBeLessThan(large);
  });

  it('penalises a file that is on more debt lists (all must be paid in one PR)', () => {
    const one = scoreCandidate({ bytes: 4096, categories: ['function-size'] });
    const three = scoreCandidate({ bytes: 4096, categories: ['a', 'b', 'c'] });
    expect(three).toBeGreaterThan(one);
  });

  it('sorts unknown sizes last', () => {
    expect(scoreCandidate({ bytes: undefined, categories: ['x'] })).toBe(Number.POSITIVE_INFINITY);
  });

  it('orders candidates smallest-first and drops excluded paths', () => {
    const debtMap = new Map([
      ['pkg/big.ts', ['function-size']],
      ['pkg/small.ts', ['function-size']],
      ['dist/bundle.js', ['function-size']],
    ]);
    const candidates = buildCandidates({
      debtMap,
      fileSizes: { 'pkg/big.ts': 90_000, 'pkg/small.ts': 1200, 'dist/bundle.js': 10 },
    });
    expect(candidates.map((c) => c.file)).toEqual(['pkg/small.ts', 'pkg/big.ts']);
    expect(candidates[0].slug).toBe('pkg-small-ts');
  });

  it('breaks score ties deterministically by path', () => {
    const candidates = buildCandidates({
      debtMap: new Map([
        ['pkg/z.ts', ['function-size']],
        ['pkg/a.ts', ['function-size']],
      ]),
      fileSizes: { 'pkg/z.ts': 100, 'pkg/a.ts': 100 },
    });
    expect(candidates.map((c) => c.file)).toEqual(['pkg/a.ts', 'pkg/z.ts']);
  });

  it('works end-to-end from the remaining layer baseline', () => {
    const candidates = buildCandidates({
      debtMap: debtMapFixture(),
      fileSizes: { 'pkg/a.ts': 1000, 'pkg/c.ts': 400 },
    });
    expect(candidates.map((c) => c.file)).toEqual(['pkg/c.ts', 'pkg/a.ts']);
  });
});

describe('slugForFile', () => {
  it('strips the packages/ prefix and makes the path branch-safe', () => {
    expect(slugForFile('packages/webapp/src/net/link-header.ts')).toBe(
      'webapp-src-net-link-header-ts'
    );
  });

  it('truncates very long paths without a trailing dash', () => {
    const slug = slugForFile(`packages/webapp/src/${'very-long-segment/'.repeat(10)}file.ts`);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('selectDebtFile', () => {
  const candidates = [
    { file: 'pkg/c.ts', categories: ['misused-promise'], bytes: 400, score: 0.4, slug: 'pkg-c-ts' },
    {
      file: 'pkg/b.ts',
      categories: ['floating-promise'],
      bytes: 500,
      score: 0.5,
      slug: 'pkg-b-ts',
    },
  ];

  it('picks the best-scoring unclaimed candidate', () => {
    const r = selectDebtFile({ candidates, claimedFiles: [] });
    expect(r.candidate.file).toBe('pkg/c.ts');
    expect(r.reason).toBeNull();
    expect(r.overridden).toBe(false);
  });

  it('skips files already claimed by an open PR instead of blocking the run', () => {
    const r = selectDebtFile({ candidates, claimedFiles: new Set(['pkg/c.ts']) });
    expect(r.candidate.file).toBe('pkg/b.ts');
    expect(r.claimedSkipped).toBe(1);
  });

  it('reports a no-op when every candidate is claimed', () => {
    const r = selectDebtFile({ candidates, claimedFiles: ['pkg/c.ts', 'pkg/b.ts'] });
    expect(r.candidate).toBeNull();
    expect(r.reason).toContain('already claimed by an open pull request');
    expect(r.claimedSkipped).toBe(2);
  });

  it('reports a no-op when there are no candidates at all', () => {
    const r = selectDebtFile({ candidates: [] });
    expect(r.candidate).toBeNull();
    expect(r.reason).toContain('no tractable per-file debt entries');
  });

  it('honours a manual override even when the file is claimed', () => {
    const r = selectDebtFile({
      candidates,
      claimedFiles: ['pkg/b.ts'],
      override: '  pkg/b.ts  ',
    });
    expect(r.candidate.file).toBe('pkg/b.ts');
    expect(r.overridden).toBe(true);
  });

  it('refuses an override that is not a tractable candidate', () => {
    const r = selectDebtFile({ candidates, override: 'dist/bundle.js' });
    expect(r.candidate).toBeNull();
    expect(r.reason).toContain('is not a tractable debt candidate');
  });

  it('treats a blank override as no override', () => {
    expect(selectDebtFile({ candidates, override: '   ' }).candidate.file).toBe('pkg/c.ts');
    expect(selectDebtFile({ candidates, override: null }).candidate.file).toBe('pkg/c.ts');
  });

  it('tolerates being called with no arguments', () => {
    expect(selectDebtFile().candidate).toBeNull();
  });
});

describe('buildPrompt', () => {
  const candidate = {
    file: 'packages/cloudflare-worker/src/flags.ts',
    categories: ['layer-back-edge'],
    bytes: 14_483,
    slug: 'cloudflare-worker-src-flags-ts',
  };
  const prompt = buildPrompt(candidate);

  it('names the target file, its debt lists, and the working branch', () => {
    expect(prompt).toContain(candidate.file);
    expect(prompt).toContain('layer-back-edge');
    expect(prompt).toContain(`${BRANCH_PREFIX}/${candidate.slug}`);
  });

  it('includes the remediation for the remaining category', () => {
    expect(prompt).toContain('node packages/dev-tools/tools/check-layer-back-edges.mjs --update');
    expect(prompt).not.toContain('noMisusedPromises');
  });

  it('cites the authoritative verification procedure and the decisive gate', () => {
    expect(prompt).toContain('.agents/skills/verifying-before-push/SKILL.md');
    expect(prompt).toContain(
      'node packages/dev-tools/tools/check-touched-exemptions.mjs origin/main'
    );
    expect(prompt).toContain('npm run typecheck');
    expect(prompt).toContain('npx vitest run');
  });

  it('states the never-add-an-exemption prohibitions', () => {
    expect(prompt).toContain('Never ADD an exemption');
    expect(prompt).toContain('biome-ignore');
    expect(prompt).toContain('Never relax a threshold');
    expect(prompt).toContain('unsafe cast');
    expect(prompt).toContain('Never bundle unrelated cleanup');
    expect(prompt).toContain('behaviour-preservingly');
  });

  it('pushes the branch and hands the PR off to the workflow', () => {
    expect(prompt).toContain(`git push -u origin ${BRANCH_PREFIX}/${candidate.slug}`);
    expect(prompt).toContain('PR_BODY_FILE');
    expect(prompt).toContain(PR_LABEL);
    expect(prompt).toContain('Print the branch name');
  });

  it('never tells Claude to open the PR or touch a label itself', () => {
    // A PR opened by Claude's `gh` is authored by github-actions[bot], and
    // GitHub queues every check on such a PR as `action_required` until a human
    // approves it — so a deterministic workflow step opens it with BOT_PAT and
    // applies the label with GITHUB_TOKEN (labels need Issues write, which
    // BOT_PAT does not carry). Both verbs may appear in the prohibition, never
    // as an invocation.
    expect(prompt).not.toMatch(/^\s*gh (pr|label) (create|edit)/m);
    expect(prompt.match(/gh pr create/g)).toHaveLength(1);
    expect(prompt).toContain('Do NOT run `gh pr create`, `gh pr edit`, or `gh label create`');
    expect(prompt).toContain('action_required');
  });

  it('requires focused tests', () => {
    expect(prompt).toContain('Add or update focused tests');
    expect(prompt).toContain('.agents/skills/writing-slicc-tests/SKILL.md');
  });

  it('derives the slug when the candidate does not carry one', () => {
    const p = buildPrompt({ file: 'packages/x/y.ts', categories: ['function-size'] });
    expect(p).toContain(`${BRANCH_PREFIX}/x-y-ts`);
  });

  it('flags an unknown category id rather than dropping it silently', () => {
    const p = buildPrompt({ file: 'a.ts', categories: ['not-a-category'] });
    expect(p).toContain('unknown debt category');
  });
});
