import { describe, expect, it } from 'vitest';
import {
  buildPrompt,
  CONFIG,
  cooldownElapsed,
  discriminatingTokens,
  isCandidateFix,
  parseFirstParentLog,
  productSources,
  rankSiblings,
  reachedPackages,
  releasedVersion,
  selectCandidate,
  signatureTokens,
  sweptMarker,
} from './lib.mjs';

describe('parseFirstParentLog', () => {
  it('links merge-queue commits to their PR number', () => {
    const log = [
      'a63154411|Merge pull request #2888 from ai-ecoverse/bb/fix-2878-playwright',
      '56141ecc5|chore(release): 6.130.1 [skip ci]',
      'f3802d751|fix(webapp): skip cone prompt when sudo_request is granted',
    ].join('\n');
    expect(parseFirstParentLog(log)).toEqual([
      {
        sha: 'a63154411',
        pr: 2888,
        subject: 'Merge pull request #2888 from ai-ecoverse/bb/fix-2878-playwright',
      },
      { sha: '56141ecc5', pr: null, subject: 'chore(release): 6.130.1 [skip ci]' },
      {
        sha: 'f3802d751',
        pr: null,
        subject: 'fix(webapp): skip cone prompt when sudo_request is granted',
      },
    ]);
  });

  it('does not invent a PR from a bare (#N) subject', () => {
    // This repo's history has no squash subjects; a `(#N)` in a message body is
    // an issue reference, not a merge.
    expect(parseFirstParentLog('abc|fix(webapp): tidy up (#1234)')[0].pr).toBeNull();
  });

  it('tolerates blank and malformed lines', () => {
    expect(parseFirstParentLog('\n\n  \n')).toEqual([]);
    expect(parseFirstParentLog(null)).toEqual([]);
  });
});

describe('releasedVersion', () => {
  it('reports the version semantic-release published', () => {
    expect(
      releasedVersion([
        { subject: 'Merge pull request #2888 from x' },
        { subject: 'chore(release): 6.130.1 [skip ci]' },
      ])
    ).toBe('6.130.1');
  });

  it('returns null when Release ran but published nothing', () => {
    // `Release` runs on every push to main, so a workflow_run completion is not
    // proof a release landed. This is the gate that distinguishes them.
    expect(releasedVersion([{ subject: 'Merge pull request #2888 from x' }])).toBeNull();
    expect(releasedVersion([])).toBeNull();
  });
});

describe('isCandidateFix', () => {
  const src = ['packages/webapp/src/shell/proxied-fetch.ts'];

  it('accepts a product fix', () => {
    expect(
      isCandidateFix({ title: 'fix(webapp): keep jsh fetch binary bodies byte-exact', files: src })
    ).toBe(true);
  });

  it('accepts perf fixes', () => {
    expect(isCandidateFix({ title: 'perf(webapp): cache pack index', files: src })).toBe(true);
  });

  it('rejects dependency bumps, docs, tests, chores and reverts', () => {
    for (const title of [
      'chore(deps): update dependency wrangler to v4.127.1',
      'docs(shell-reference): fix the command table',
      'test(e2e): two-instance follower suite',
      'ci: pin the checkout action',
      'revert: "fix(webapp): keep jsh fetch binary bodies byte-exact"',
      'refactor(persistence): one canonical conversation record',
    ]) {
      expect(isCandidateFix({ title, files: src }), title).toBe(false);
    }
  });

  it('rejects a fix scoped to deps or docs', () => {
    expect(isCandidateFix({ title: 'fix(deps): bump zen-fs', files: src })).toBe(false);
    expect(isCandidateFix({ title: 'fix(docs): stale link', files: src })).toBe(false);
  });

  it('rejects a fix that changed no product source', () => {
    expect(
      isCandidateFix({
        title: 'fix(webapp): tighten a test',
        files: ['packages/webapp/tests/shell/proxied-fetch.test.ts', 'docs/shell-reference.md'],
      })
    ).toBe(false);
  });

  it('rejects a non-conventional subject', () => {
    expect(isCandidateFix({ title: 'Update the fetch adapter', files: src })).toBe(false);
  });
});

describe('productSources', () => {
  it('keeps source and drops tests, docs, dist and lockfiles', () => {
    expect(
      productSources([
        'packages/webapp/src/shell/proxied-fetch.ts',
        'packages/swift-server/Sources/Server/APIRoutes.swift',
        'packages/webapp/tests/shell/proxied-fetch.test.ts',
        'docs/shell-reference.md',
        'dist/extension/bundle.js',
        'package-lock.json',
      ])
    ).toEqual([
      'packages/webapp/src/shell/proxied-fetch.ts',
      'packages/swift-server/Sources/Server/APIRoutes.swift',
    ]);
  });
});

describe('signatureTokens', () => {
  /** Wrap raw hunk lines in a source-file header so they are harvested. */
  const inSource = (...lines) =>
    ['diff --git a/packages/webapp/src/a.ts b/packages/webapp/src/a.ts', ...lines].join('\n');

  it('reads the deleted construct, not the remedy', () => {
    // The whole hunt inverts if this reads `+` lines: grepping for the fix
    // finds the sites that are already correct.
    const diff = [
      'diff --git a/packages/webapp/src/a.ts b/packages/webapp/src/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '-  send(bytesToLatin1(payloadBuffer));',
      '+  send(preserveRawBytes(payloadBuffer));',
    ].join('\n');
    const tokens = signatureTokens(diff);
    // `preserveRawBytes` is the remedy. Grepping for it would find every site
    // that is already correct and file issues against healthy code.
    expect(tokens).not.toContain('preserveRawBytes');
    // Purely deleted beats survived: `payloadBuffer` is on both sides, so it is
    // the subject the defect was applied to, not the defect.
    expect(tokens[0]).toBe('bytesToLatin1');
    expect(tokens.indexOf('bytesToLatin1')).toBeLessThan(tokens.indexOf('payloadBuffer'));
  });

  it('ignores the `---` file header', () => {
    expect(signatureTokens(inSource('--- a/packages/webapp/src/thing.ts'))).toEqual([]);
  });

  it('harvests nothing from docs, markdown or test hunks', () => {
    // A fix's diff routinely carries `docs/shell-reference.md` and its own
    // tests. Harvesting those turns English prose into "signature tokens".
    const diff = [
      'diff --git a/docs/shell-reference.md b/docs/shell-reference.md',
      '-The proxy avoids re-encoding when targeting a binary body.',
      'diff --git a/packages/webapp/tests/a.test.ts b/packages/webapp/tests/a.test.ts',
      '-  expect(uniqueTestOnlyHelper(x)).toBe(1);',
    ].join('\n');
    expect(signatureTokens(diff)).toEqual([]);
  });

  it('skips comment lines, which are prose and match half the repo', () => {
    // Replaying #2888 without this produced `avoids`, `clicking`, `targeting`,
    // `Convert` and `Detect` as top signatures — every one from a comment.
    const diff = inSource(
      '-  // Convert the buffer, which avoids clicking through targeting logic.',
      '-   * Detect the activeElement before uploading.',
      '-  const encoded = uint8ToBase64(buffer);'
    );
    const tokens = signatureTokens(diff);
    expect(tokens).toContain('uint8ToBase64');
    for (const prose of ['Convert', 'avoids', 'clicking', 'targeting', 'Detect', 'activeElement']) {
      expect(tokens, prose).not.toContain(prose);
    }
  });

  it('ignores a hunk before any file header', () => {
    expect(signatureTokens('-  strayLineWithNoHeader(x);')).toEqual([]);
  });

  it('drops language keywords and short lowercase locals', () => {
    const tokens = signatureTokens(inSource('-  const foo = await this.data.map(x);'));
    expect(tokens).not.toContain('const');
    expect(tokens).not.toContain('await');
    expect(tokens).not.toContain('data');
    expect(tokens).not.toContain('foo');
  });

  it('keeps camelCase and PascalCase identifiers', () => {
    const tokens = signatureTokens(inSource('-  new TextEncoder().encode(rawBody);'));
    expect(tokens).toContain('TextEncoder');
    expect(tokens).toContain('rawBody');
  });

  it('drops tokens that survive into the fixed version', () => {
    // #2888 rewrote a playwright handler, so `PlaywrightHandler` and
    // `requireTab` sat on both sides of the diff and matched all ~18 sibling
    // handlers for no reason. Only what was purely deleted is the construct.
    const diff = inSource(
      '-  const h: PlaywrightHandler = async (t) => uint8ToBase64(await requireTab(t));',
      '+  const h: PlaywrightHandler = async (t) => rawBytes(await requireTab(t));'
    );
    const tokens = signatureTokens(diff);
    expect(tokens[0]).toBe('uint8ToBase64');
    for (const survivor of ['PlaywrightHandler', 'requireTab']) {
      expect(tokens.indexOf('uint8ToBase64'), survivor).toBeLessThan(tokens.indexOf(survivor));
    }
  });

  it('still yields a signature when every token survived the rewrite', () => {
    // Dropping survivors outright was tried: most fixes rewrite a line in
    // place, and #2888 came back with no signature at all.
    const tokens = signatureTokens(
      inSource('-  encodeUpload(payloadBuffer, true);', '+  encodeUpload(payloadBuffer, false);')
    );
    expect(tokens).toContain('encodeUpload');
  });

  it('orders by how often the construct was deleted', () => {
    const diff = inSource('-  bytesToLatin1(a);', '-  bytesToLatin1(b);', '-  otherHelper(c);');
    expect(signatureTokens(diff)[0]).toBe('bytesToLatin1');
  });
});

describe('discriminatingTokens', () => {
  it('drops tokens that describe the language rather than the bug', () => {
    const filesFor = (t) => (t === 'toString' ? new Array(400).fill('f.ts') : ['a.ts', 'b.ts']);
    const kept = discriminatingTokens(['toString', 'bytesToLatin1'], filesFor);
    expect(kept.map((k) => k.token)).toEqual(['bytesToLatin1']);
  });

  it('drops tokens that exist nowhere else', () => {
    expect(discriminatingTokens(['goneEntirely'], () => [])).toEqual([]);
  });
});

describe('rankSiblings', () => {
  const tokenFiles = [
    { token: 'bytesToLatin1', files: ['packages/webapp/src/a.ts', 'packages/webapp/src/b.ts'] },
    { token: 'TextEncoder', files: ['packages/webapp/src/a.ts', 'packages/node-server/src/c.ts'] },
    { token: 'rawBody', files: ['packages/webapp/src/a.ts'] },
  ];

  it('ranks by how many signature tokens co-occur', () => {
    const ranked = rankSiblings(tokenFiles, []);
    expect(ranked[0]).toEqual({
      file: 'packages/webapp/src/a.ts',
      tokens: ['TextEncoder', 'bytesToLatin1', 'rawBody'],
      score: 3,
    });
  });

  it('excludes the files the fix already repaired', () => {
    const ranked = rankSiblings(tokenFiles, ['packages/webapp/src/a.ts']);
    expect(ranked.map((r) => r.file)).not.toContain('packages/webapp/src/a.ts');
  });

  it('requires co-occurrence — one shared token is a coincidence', () => {
    // c.ts carries only TextEncoder; b.ts only bytesToLatin1.
    expect(rankSiblings(tokenFiles, ['packages/webapp/src/a.ts'])).toEqual([]);
  });

  it('never proposes tests, docs or dist as siblings', () => {
    const noise = [
      { token: 'bytesToLatin1', files: ['packages/webapp/tests/a.test.ts', 'dist/bundle.js'] },
      { token: 'TextEncoder', files: ['packages/webapp/tests/a.test.ts', 'dist/bundle.js'] },
    ];
    expect(rankSiblings(noise, [])).toEqual([]);
  });

  it('caps the worklist', () => {
    const many = ['x', 'y'].map((token) => ({
      token,
      files: Array.from({ length: 50 }, (_, i) => `packages/webapp/src/f${i}.ts`),
    }));
    expect(rankSiblings(many, []).length).toBe(CONFIG.maxSiblings);
  });
});

describe('reachedPackages', () => {
  it('reports cross-runtime reach', () => {
    expect(
      reachedPackages([
        { file: 'packages/webapp/src/a.ts' },
        { file: 'packages/swift-server/Sources/B.swift' },
        { file: 'packages/webapp/src/c.ts' },
      ])
    ).toEqual(['swift-server', 'webapp']);
  });

  it('labels root-level files', () => {
    expect(reachedPackages([{ file: 'scripts/a.mjs' }])).toEqual(['(root)']);
  });
});

describe('cooldownElapsed', () => {
  const now = new Date('2026-09-04T12:00:00Z');

  it('lets the first-ever run through', () => {
    expect(cooldownElapsed(null, now, 12)).toBe(true);
  });

  it('blocks a hunt inside the window', () => {
    expect(cooldownElapsed('2026-09-04T06:00:00Z', now, 12)).toBe(false);
  });

  it('allows one at the boundary', () => {
    expect(cooldownElapsed('2026-09-04T00:00:00Z', now, 12)).toBe(true);
  });

  it('fails open on an unparseable timestamp', () => {
    expect(cooldownElapsed('not-a-date', now, 12)).toBe(true);
  });
});

describe('selectCandidate', () => {
  const sib = (n, pkg = 'webapp') =>
    Array.from({ length: n }, (_, i) => ({ file: `packages/${pkg}/src/f${i}.ts`, score: 2 }));

  it('picks the fix whose construct survives in the most places', () => {
    const chosen = selectCandidate([
      { pr: 1, title: 'a', siblings: sib(2) },
      { pr: 2, title: 'b', siblings: sib(6) },
    ]);
    expect(chosen.pr).toBe(2);
  });

  it('dispatches nothing below the cluster threshold', () => {
    expect(selectCandidate([{ pr: 1, title: 'a', siblings: sib(1) }])).toBeNull();
    expect(selectCandidate([])).toBeNull();
  });

  it('breaks a tie on cross-package reach', () => {
    const spread = [
      { file: 'packages/webapp/src/a.ts', score: 2 },
      { file: 'packages/swift-server/Sources/B.swift', score: 2 },
    ];
    const chosen = selectCandidate([
      { pr: 1, title: 'single-package', siblings: sib(2) },
      { pr: 2, title: 'cross-runtime', siblings: spread },
    ]);
    expect(chosen.pr).toBe(2);
  });
});

describe('buildPrompt', () => {
  const candidate = {
    pr: 2818,
    title: 'fix(webapp): keep jsh fetch binary bodies byte-exact',
    sha: 'b33887d1a',
    version: '6.130.1',
    tokens: ['bytesToLatin1', 'TextEncoder'],
    fixedFiles: ['packages/webapp/src/shell/proxied-fetch.ts'],
    siblings: [
      {
        file: 'packages/webapp/src/cdp/playwright-command.ts',
        tokens: ['bytesToLatin1'],
        score: 2,
      },
      {
        file: 'packages/swift-server/Sources/Server/APIRoutes.swift',
        tokens: ['TextEncoder'],
        score: 2,
      },
    ],
  };

  it('names the fix, the release and the surviving sites', () => {
    const p = buildPrompt(candidate);
    expect(p).toContain('#2818');
    expect(p).toContain('release 6.130.1');
    expect(p).toContain('git show b33887d1a');
    expect(p).toContain('packages/webapp/src/cdp/playwright-command.ts');
  });

  it('carries the dedup marker the next run reads back', () => {
    expect(buildPrompt(candidate)).toContain(sweptMarker(2818));
  });

  it('tells the model the table is a lead, not a finding', () => {
    // Without this the sweep files issues against every lexical match.
    expect(buildPrompt(candidate)).toContain('a lead, not a finding');
  });

  it('makes filing nothing an explicitly good outcome', () => {
    expect(buildPrompt(candidate)).toContain('Filing nothing is a good outcome');
  });

  it('honours the issue cap', () => {
    expect(buildPrompt({ ...candidate, maxIssues: 3 })).toContain('at most **3**');
  });

  it('points the sweep at the other runtimes', () => {
    const p = buildPrompt(candidate);
    for (const pkg of ['packages/swift-server/', 'packages/node-server/', 'packages/go-optel/']) {
      expect(p).toContain(pkg);
    }
  });
});

describe('selectCandidate ranks on the uncapped count', () => {
  const sib = (n) =>
    Array.from({ length: n }, (_, i) => ({ file: `packages/webapp/src/f${i}.ts`, score: 2 }));

  it('prefers the larger cluster even when both briefs are truncated to the cap', () => {
    // Both carry 25 files in `siblings` (the brief-length cap), so ranking on
    // that list would tie and pick arbitrarily.
    const chosen = selectCandidate([
      { pr: 2850, title: 'smaller', siblings: sib(25), totalSiblings: 31 },
      { pr: 2888, title: 'larger', siblings: sib(25), totalSiblings: 104 },
    ]);
    expect(chosen.pr).toBe(2888);
  });

  it('falls back to the visible list when no total is supplied', () => {
    const chosen = selectCandidate([
      { pr: 1, title: 'a', siblings: sib(2) },
      { pr: 2, title: 'b', siblings: sib(5) },
    ]);
    expect(chosen.pr).toBe(2);
  });

  it('applies the cluster floor to the uncapped count', () => {
    expect(selectCandidate([{ pr: 1, title: 'a', siblings: sib(0), totalSiblings: 1 }])).toBeNull();
  });
});
