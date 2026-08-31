import { describe, expect, it } from 'vitest';
import {
  assessCompactionProgress,
  blockedGuidePaths,
  buildBranchName,
  buildCompactionPrBody,
  buildCompactMatrix,
  buildPartialPrBody,
  buildPrompt,
  COMPACTION_BRANCH_PREFIX,
  COMPACTION_PR_TITLE,
  COMPACTION_TITLE_PREFIX,
  COMPACTOR_MAX_CHARS,
  COMPACTOR_TARGET_CHARS,
  computeMaxTurns,
  DEFAULT_MAX_GUIDES,
  EXCLUDED_GUIDES,
  excludeBlockedGuides,
  findExistingCompactionPr,
  formatBeforeSizes,
  formatProgressReport,
  formatReport,
  guideSafeName,
  isExcludedGuide,
  listCompactionPrs,
  MAX_TURNS_CAP,
  measureGuides,
  mergeShardProgress,
  parseBeforeSizes,
  parseMaxGuides,
  parseWorklist,
  selectAboveTarget,
  selectOversized,
  selectPublishPaths,
  selectWorklist,
  TURNS_PER_GUIDE,
  TURNS_PER_OVERFLOW_CHUNK,
} from './lib.mjs';

/** A guide of exactly `n` characters. */
const guide = (n) => 'x'.repeat(n);

describe('policy constants', () => {
  it('sets the stricter compactor policy well below the repo 20,000-char gate', () => {
    expect(COMPACTOR_MAX_CHARS).toBe(10000);
    expect(COMPACTOR_TARGET_CHARS).toBe(9500);
    expect(COMPACTOR_TARGET_CHARS).toBeLessThan(COMPACTOR_MAX_CHARS);
    // The repo's own committed gate (check-doc-sizes-lib.mjs) is 20,000; the
    // policy must stay strictly stricter or it would be pointless.
    expect(COMPACTOR_MAX_CHARS).toBeLessThan(20000);
    expect(DEFAULT_MAX_GUIDES).toBe(0);
    expect(TURNS_PER_GUIDE).toBe(300);
    expect(TURNS_PER_OVERFLOW_CHUNK).toBe(50);
    expect(MAX_TURNS_CAP).toBe(600);
  });
});

describe('computeMaxTurns', () => {
  it('scales with worklist length (the files Claude is asked to rewrite)', () => {
    const atTarget = { chars: 9500 };
    expect(computeMaxTurns([atTarget])).toBe(TURNS_PER_GUIDE);
    expect(computeMaxTurns([atTarget, atTarget])).toBe(TURNS_PER_GUIDE * 2);
  });

  it('adds overflow turns so a 20k guide is not starved at the 1-file default', () => {
    // Dispatch 33320764465: 19,998 chars, fixed 250 turns, cap at 9,609.
    const webapp = { chars: 19998 };
    const extra = Math.ceil((19998 - 9500) / 2500) * TURNS_PER_OVERFLOW_CHUNK;
    expect(computeMaxTurns([webapp])).toBe(TURNS_PER_GUIDE + extra);
    expect(computeMaxTurns([webapp])).toBeGreaterThan(250);
  });

  it('caps an 8-file dispatch so the job cannot run for hours', () => {
    const eight = Array.from({ length: 8 }, () => ({ chars: 15000 }));
    expect(computeMaxTurns(eight)).toBe(MAX_TURNS_CAP);
  });

  it('treats an empty worklist as one slot (Claude is not invoked anyway)', () => {
    expect(computeMaxTurns([])).toBe(TURNS_PER_GUIDE);
    expect(computeMaxTurns(null)).toBe(TURNS_PER_GUIDE);
  });
});

describe('measureGuides', () => {
  it('measures CHARACTERS, not bytes (multi-byte content differs)', () => {
    // 'é' is 1 UTF-16 code unit but 2 UTF-8 bytes; '🍦' is 2 code units but 4 bytes.
    const content = `${'é'.repeat(100)}${'🍦'.repeat(10)}`;
    expect(content.length).toBe(120);
    expect(Buffer.byteLength(content, 'utf8')).toBe(240);

    const [m] = measureGuides([{ path: 'docs/CLAUDE.md', content }]);
    expect(m.chars).toBe(120);
    expect(m.chars).not.toBe(Buffer.byteLength(content, 'utf8'));
  });

  it('treats exactly 10,000 characters as oversized and 9,999 as fine', () => {
    const measurements = measureGuides([
      { path: 'a/CLAUDE.md', content: guide(9999) },
      { path: 'b/CLAUDE.md', content: guide(10000) },
      { path: 'c/CLAUDE.md', content: guide(10001) },
    ]);
    expect(measurements.map((m) => m.oversized)).toEqual([false, true, true]);
  });

  it('honours a maxChars override', () => {
    const entries = [{ path: 'a/CLAUDE.md', content: guide(9000) }];
    expect(measureGuides(entries)[0].oversized).toBe(false);
    expect(measureGuides(entries, { maxChars: 8000 })[0].oversized).toBe(true);
  });

  it('accepts an array, a Map, and a plain object of path → content', () => {
    const expected = [{ path: 'a/CLAUDE.md', chars: 3, oversized: false, excluded: false }];
    expect(measureGuides([{ path: 'a/CLAUDE.md', content: 'abc' }])).toEqual(expected);
    expect(measureGuides(new Map([['a/CLAUDE.md', 'abc']]))).toEqual(expected);
    expect(measureGuides({ 'a/CLAUDE.md': 'abc' })).toEqual(expected);
  });

  it('sorts by path and tolerates empty/missing content', () => {
    const measurements = measureGuides([
      { path: 'z/CLAUDE.md', content: '' },
      { path: 'a/CLAUDE.md', content: undefined },
    ]);
    expect(measurements.map((m) => m.path)).toEqual(['a/CLAUDE.md', 'z/CLAUDE.md']);
    expect(measurements.every((m) => m.chars === 0)).toBe(true);
  });
});

describe('the agent-facing runtime guide is never compaction work', () => {
  it('names the 3,000-byte runtime guide as excluded', () => {
    expect(EXCLUDED_GUIDES).toContain('packages/vfs-root/shared/CLAUDE.md');
    expect(isExcludedGuide('packages/vfs-root/shared/CLAUDE.md')).toBe(true);
    expect(isExcludedGuide('./packages/vfs-root/shared/CLAUDE.md')).toBe(true);
    expect(isExcludedGuide('packages/webapp/CLAUDE.md')).toBe(false);
  });

  it('never marks it oversized even at an absurd length', () => {
    const measurements = measureGuides([
      { path: 'packages/vfs-root/shared/CLAUDE.md', content: guide(50000) },
      { path: 'packages/webapp/CLAUDE.md', content: guide(50000) },
    ]);
    const runtime = measurements.find((m) => m.path.includes('vfs-root'));
    expect(runtime.excluded).toBe(true);
    expect(runtime.oversized).toBe(false);
    expect(selectOversized(measurements).map((m) => m.path)).toEqual(['packages/webapp/CLAUDE.md']);
  });
});

describe('selectOversized', () => {
  it('returns only oversized guides, largest first', () => {
    const measurements = measureGuides([
      { path: 'a/CLAUDE.md', content: guide(10500) },
      { path: 'b/CLAUDE.md', content: guide(9000) },
      { path: 'c/CLAUDE.md', content: guide(12000) },
    ]);
    expect(selectOversized(measurements).map((m) => m.path)).toEqual([
      'c/CLAUDE.md',
      'a/CLAUDE.md',
    ]);
  });

  it('is empty on a clean repo', () => {
    expect(selectOversized(measureGuides([{ path: 'a/CLAUDE.md', content: guide(100) }]))).toEqual(
      []
    );
  });
});

describe('selectWorklist', () => {
  const measurements = measureGuides([
    { path: 'a/CLAUDE.md', content: guide(10500) },
    { path: 'b/CLAUDE.md', content: guide(9000) },
    { path: 'c/CLAUDE.md', content: guide(12000) },
    { path: 'd/CLAUDE.md', content: guide(11000) },
  ]);

  it('defaults to every oversized guide (fan-out, largest first)', () => {
    expect(selectWorklist(measurements).map((m) => m.path)).toEqual([
      'c/CLAUDE.md',
      'd/CLAUDE.md',
      'a/CLAUDE.md',
    ]);
    expect(
      selectWorklist(measurements, { maxGuides: DEFAULT_MAX_GUIDES }).map((m) => m.path)
    ).toEqual(['c/CLAUDE.md', 'd/CLAUDE.md', 'a/CLAUDE.md']);
  });

  it('takes the N largest when maxGuides is set', () => {
    expect(selectWorklist(measurements, { maxGuides: 2 }).map((m) => m.path)).toEqual([
      'c/CLAUDE.md',
      'd/CLAUDE.md',
    ]);
  });

  it('returns everyone oversized when maxGuides is non-positive', () => {
    expect(selectWorklist(measurements, { maxGuides: 0 }).map((m) => m.path)).toEqual([
      'c/CLAUDE.md',
      'd/CLAUDE.md',
      'a/CLAUDE.md',
    ]);
  });
});

describe('parseMaxGuides', () => {
  it('treats empty or invalid as the default (all)', () => {
    expect(parseMaxGuides('')).toBe(0);
    expect(parseMaxGuides(undefined)).toBe(0);
    expect(parseMaxGuides('nope')).toBe(0);
    expect(parseMaxGuides('1.5')).toBe(0);
  });

  it('accepts 0 as all and a positive integer as a cap', () => {
    expect(parseMaxGuides('0')).toBe(0);
    expect(parseMaxGuides('1')).toBe(1);
    expect(parseMaxGuides('8')).toBe(8);
  });
});

describe('guideSafeName / buildCompactMatrix', () => {
  it('turns a guide path into an artifact-safe id', () => {
    expect(guideSafeName('packages/ios-app/CLAUDE.md')).toBe('packages-ios-app');
    expect(guideSafeName('CLAUDE.md')).toBe('root');
    expect(guideSafeName('docs/CLAUDE.md')).toBe('docs');
  });

  it('emits one matrix row per worklist file with per-shard max_turns', () => {
    const worklist = [
      { path: 'packages/ios-app/CLAUDE.md', chars: 17332 },
      { path: 'packages/swift-server/CLAUDE.md', chars: 10199 },
    ];
    const matrix = buildCompactMatrix(worklist);
    expect(matrix.include).toHaveLength(2);
    expect(matrix.include[0]).toEqual({
      guide: 'packages/ios-app/CLAUDE.md',
      safe_name: 'packages-ios-app',
      max_turns: String(computeMaxTurns([worklist[0]])),
      chars: '17332',
    });
    expect(Number(matrix.include[0].max_turns)).toBeLessThan(MAX_TURNS_CAP);
    expect(matrix.include[1].safe_name).toBe('packages-swift-server');
  });
});

describe('claimed-file exclusion', () => {
  it('pulls CLAUDE.md paths out of a PR file list and drops them from the worklist', () => {
    const blocked = blockedGuidePaths([
      { filename: 'packages/swift-launcher/CLAUDE.md' },
      { filename: 'docs/swift-launcher-details.md' },
      { filename: '.github/workflows/claude-md-compactor.yml' },
      'CLAUDE.md',
    ]);
    expect(blocked).toEqual(['packages/swift-launcher/CLAUDE.md', 'CLAUDE.md']);
    const worklist = [
      { path: 'packages/ios-app/CLAUDE.md', chars: 17332 },
      { path: 'packages/swift-launcher/CLAUDE.md', chars: 19533 },
    ];
    expect(excludeBlockedGuides(worklist, blocked).map((m) => m.path)).toEqual([
      'packages/ios-app/CLAUDE.md',
    ]);
  });

  it('lists every open compaction PR, not just the first', () => {
    const open = [
      {
        number: 2679,
        title: COMPACTION_PR_TITLE,
        html_url: 'https://example/2679',
        head: { ref: `${COMPACTION_BRANCH_PREFIX}2026-08-30-1` },
      },
      { number: 1, title: 'unrelated', html_url: 'https://example/1', head: { ref: 'feat/x' } },
    ];
    const prs = listCompactionPrs(open);
    expect(prs).toHaveLength(1);
    expect(prs[0].number).toBe(2679);
    expect(findExistingCompactionPr(open)?.number).toBe(2679);
  });
});

describe('mergeShardProgress', () => {
  it('concatenates per-guide shards into one assessment for the consolidated PR', () => {
    const out = mergeShardProgress([
      {
        worklist: ['packages/ios-app/CLAUDE.md'],
        before: { 'packages/ios-app/CLAUDE.md': 17332 },
        after: [{ path: 'packages/ios-app/CLAUDE.md', chars: 9400, oversized: false }],
      },
      {
        worklist: ['packages/webcomponents/CLAUDE.md'],
        before: { 'packages/webcomponents/CLAUDE.md': 16364 },
        after: [{ path: 'packages/webcomponents/CLAUDE.md', chars: 9480, oversized: false }],
      },
    ]);
    expect(out.policyOk).toBe(true);
    expect(out.openPr).toBe(true);
    expect(out.shrunk.map((r) => r.path)).toEqual([
      'packages/ios-app/CLAUDE.md',
      'packages/webcomponents/CLAUDE.md',
    ]);
  });
});

describe('selectAboveTarget', () => {
  // Regression: the post-Claude check used to receive only MAX_CHARS, so a guide
  // rewritten to just under the oversized threshold passed verification even
  // though the brief promised the target — and it would be re-selected the
  // following week for nothing.
  const measurements = () =>
    measureGuides(
      [
        { path: 'a/CLAUDE.md', content: guide(8900) },
        { path: 'b/CLAUDE.md', content: guide(8400) },
        { path: 'c/CLAUDE.md', content: guide(8900) },
      ],
      { maxChars: 9000 }
    );

  it('flags a selected guide left above the target', () => {
    const out = selectAboveTarget(measurements(), {
      worklist: ['a/CLAUDE.md', 'b/CLAUDE.md'],
      targetChars: 8500,
    });
    expect(out.map((m) => m.path)).toEqual(['a/CLAUDE.md']);
  });

  it('ignores guides that were never on the worklist', () => {
    // c is also 8,900 but nobody asked Claude to touch it.
    const out = selectAboveTarget(measurements(), { worklist: ['b/CLAUDE.md'], targetChars: 8500 });
    expect(out).toEqual([]);
  });

  it('accepts a guide exactly at the target', () => {
    const out = selectAboveTarget([{ path: 'a/CLAUDE.md', chars: 8500 }], {
      worklist: ['a/CLAUDE.md'],
      targetChars: 8500,
    });
    expect(out).toEqual([]);
  });

  it('is empty with no worklist, so a plain --check keeps its old meaning', () => {
    expect(selectAboveTarget(measurements(), { worklist: [], targetChars: 1 })).toEqual([]);
  });

  it('orders the biggest miss first', () => {
    const out = selectAboveTarget(
      [
        { path: 'a/CLAUDE.md', chars: 8600 },
        { path: 'b/CLAUDE.md', chars: 8900 },
      ],
      { worklist: ['a/CLAUDE.md', 'b/CLAUDE.md'], targetChars: 8500 }
    );
    expect(out.map((m) => m.path)).toEqual(['b/CLAUDE.md', 'a/CLAUDE.md']);
  });
});

describe('parseWorklist', () => {
  it('splits on commas and newlines and trims', () => {
    expect(parseWorklist('a/CLAUDE.md, b/CLAUDE.md\n c/CLAUDE.md ')).toEqual([
      'a/CLAUDE.md',
      'b/CLAUDE.md',
      'c/CLAUDE.md',
    ]);
  });

  it('is empty for absent or blank input', () => {
    expect(parseWorklist(undefined)).toEqual([]);
    expect(parseWorklist('')).toEqual([]);
    expect(parseWorklist(' , \n ')).toEqual([]);
  });
});

describe('formatBeforeSizes / parseBeforeSizes', () => {
  it('round-trips a worklist as sorted JSON', () => {
    const raw = formatBeforeSizes([
      { path: 'b/CLAUDE.md', chars: 12000 },
      { path: 'a/CLAUDE.md', chars: 19998 },
    ]);
    expect(raw).toBe('{"a/CLAUDE.md":19998,"b/CLAUDE.md":12000}');
    expect(Object.fromEntries(parseBeforeSizes(raw))).toEqual({
      'a/CLAUDE.md': 19998,
      'b/CLAUDE.md': 12000,
    });
  });

  it('parses a JSON array of {path, chars}', () => {
    const map = parseBeforeSizes(
      JSON.stringify([
        { path: 'a/CLAUDE.md', chars: 10 },
        { path: 'b/CLAUDE.md', chars: 20 },
      ])
    );
    expect(map.get('a/CLAUDE.md')).toBe(10);
    expect(map.get('b/CLAUDE.md')).toBe(20);
  });

  it('parses path:chars pairs as a fallback', () => {
    expect(
      Object.fromEntries(
        parseBeforeSizes('a/CLAUDE.md:19998, b/CLAUDE.md:12000\nc/CLAUDE.md:10199')
      )
    ).toEqual({
      'a/CLAUDE.md': 19998,
      'b/CLAUDE.md': 12000,
      'c/CLAUDE.md': 10199,
    });
  });

  it('is empty for absent or blank input', () => {
    expect(parseBeforeSizes(undefined).size).toBe(0);
    expect(parseBeforeSizes('').size).toBe(0);
    expect(parseBeforeSizes(' , \n ').size).toBe(0);
  });
});

describe('assessCompactionProgress', () => {
  const measured = (entries, maxChars = 10000) => measureGuides(entries, { maxChars });

  it('recovers when selected guides shrank but are still oversized (the Saturday miss)', () => {
    const out = assessCompactionProgress({
      before: { 'packages/webapp/CLAUDE.md': 19998, 'packages/ios-app/CLAUDE.md': 17332 },
      after: measured([
        { path: 'packages/webapp/CLAUDE.md', content: guide(15000) },
        { path: 'packages/ios-app/CLAUDE.md', content: guide(16000) },
      ]),
      worklist: ['packages/webapp/CLAUDE.md', 'packages/ios-app/CLAUDE.md'],
    });
    expect(out.policyOk).toBe(false);
    expect(out.recovered).toBe(true);
    expect(out.openPr).toBe(true);
    expect(out.shrunk.map((r) => r.path)).toEqual([
      'packages/webapp/CLAUDE.md',
      'packages/ios-app/CLAUDE.md',
    ]);
    expect(out.shrunk[0].delta).toBe(15000 - 19998);
  });

  it('does not recover when every selected guide is unchanged (run 33283868860)', () => {
    const out = assessCompactionProgress({
      before: { 'packages/webapp/CLAUDE.md': 19998, 'packages/swift-server/CLAUDE.md': 10199 },
      after: measured([
        { path: 'packages/webapp/CLAUDE.md', content: guide(19998) },
        { path: 'packages/swift-server/CLAUDE.md', content: guide(10199) },
      ]),
      worklist: ['packages/webapp/CLAUDE.md', 'packages/swift-server/CLAUDE.md'],
    });
    expect(out.policyOk).toBe(false);
    expect(out.recovered).toBe(false);
    expect(out.openPr).toBe(false);
    expect(out.unchanged).toHaveLength(2);
  });

  it('does not recover when any selected guide grew', () => {
    const out = assessCompactionProgress({
      before: { 'a/CLAUDE.md': 12000, 'b/CLAUDE.md': 11000 },
      after: measured([
        { path: 'a/CLAUDE.md', content: guide(9000) },
        { path: 'b/CLAUDE.md', content: guide(13000) },
      ]),
      worklist: ['a/CLAUDE.md', 'b/CLAUDE.md'],
    });
    expect(out.recovered).toBe(false);
    expect(out.openPr).toBe(false);
    expect(out.grew.map((r) => r.path)).toEqual(['b/CLAUDE.md']);
    expect(out.shrunk.map((r) => r.path)).toEqual(['a/CLAUDE.md']);
  });

  it('does not recover when a guide that was not oversized became oversized', () => {
    const out = assessCompactionProgress({
      before: { 'a/CLAUDE.md': 12000 },
      after: measured([
        { path: 'a/CLAUDE.md', content: guide(9000) },
        { path: 'b/CLAUDE.md', content: guide(15000) },
      ]),
      worklist: ['a/CLAUDE.md'],
    });
    expect(out.recovered).toBe(false);
    expect(out.newOversized.map((m) => m.path)).toEqual(['b/CLAUDE.md']);
  });

  it('does not treat a deferred leftover as a new oversized guide', () => {
    // One-file-per-run: b was already oversized going in, just not selected.
    const out = assessCompactionProgress({
      before: { 'a/CLAUDE.md': 12000, 'b/CLAUDE.md': 15000 },
      after: measured([
        { path: 'a/CLAUDE.md', content: guide(8000) },
        { path: 'b/CLAUDE.md', content: guide(15000) },
      ]),
      worklist: ['a/CLAUDE.md'],
    });
    expect(out.newOversized).toEqual([]);
    expect(out.recovered).toBe(true);
  });

  it('allows some worklist files to stay unchanged if others shrank', () => {
    const out = assessCompactionProgress({
      before: { 'a/CLAUDE.md': 12000, 'b/CLAUDE.md': 11000 },
      after: measured([
        { path: 'a/CLAUDE.md', content: guide(8000) },
        { path: 'b/CLAUDE.md', content: guide(11000) },
      ]),
      worklist: ['a/CLAUDE.md', 'b/CLAUDE.md'],
    });
    expect(out.recovered).toBe(true);
    expect(out.unchanged.map((r) => r.path)).toEqual(['b/CLAUDE.md']);
  });

  it('is policyOk (not recovered) when every selected guide hit the target', () => {
    const out = assessCompactionProgress({
      before: { 'a/CLAUDE.md': 12000 },
      after: measured([{ path: 'a/CLAUDE.md', content: guide(9000) }]),
      worklist: ['a/CLAUDE.md'],
    });
    expect(out.policyOk).toBe(true);
    expect(out.recovered).toBe(false);
    expect(out.openPr).toBe(true);
  });

  it('treats a missing after-file as not recoverable', () => {
    const out = assessCompactionProgress({
      before: { 'a/CLAUDE.md': 12000, 'b/CLAUDE.md': 11000 },
      after: measured([{ path: 'a/CLAUDE.md', content: guide(8000) }]),
      worklist: ['a/CLAUDE.md', 'b/CLAUDE.md'],
    });
    expect(out.recovered).toBe(false);
    expect(out.missing.map((r) => r.path)).toEqual(['b/CLAUDE.md']);
  });
});

describe('formatProgressReport / buildPartialPrBody', () => {
  const assessment = assessCompactionProgress({
    before: { 'packages/webapp/CLAUDE.md': 19998 },
    after: measureGuides([{ path: 'packages/webapp/CLAUDE.md', content: guide(15000) }]),
    worklist: ['packages/webapp/CLAUDE.md'],
  });

  it('renders a before/after/delta table for a partial recovery', () => {
    const report = formatProgressReport(assessment);
    expect(report).toContain('1 selected guide(s) got smaller; the policy target was not met.');
    expect(report).toContain(
      '| `packages/webapp/CLAUDE.md` | 19,998 | 15,000 | -4,998 | still oversized |'
    );
  });

  it('synthesises a PR body that names the partial and the validation commands', () => {
    const body = buildPartialPrBody(assessment);
    expect(body).toContain('Partial CLAUDE.md compaction');
    expect(body).toContain('claimed-file dedup');
    expect(body).toContain('npm run lint:docs');
    expect(body).toContain(
      'node packages/dev-tools/claude-md-compactor/measure-claude-guides.mjs --check'
    );
  });

  it('synthesises a full-hit body when policyOk, and delegates to partial otherwise', () => {
    const hit = assessCompactionProgress({
      before: { 'packages/webapp/CLAUDE.md': 19998 },
      after: measureGuides([{ path: 'packages/webapp/CLAUDE.md', content: guide(9000) }]),
      worklist: ['packages/webapp/CLAUDE.md'],
    });
    const body = buildCompactionPrBody(hit);
    expect(body).toContain('Selected guides are at or below 9,500 chars');
    expect(body).not.toContain('Partial CLAUDE.md compaction');
    expect(buildCompactionPrBody(assessment)).toContain('Partial CLAUDE.md compaction');
  });
});

describe('selectPublishPaths', () => {
  it('keeps worklist guides and docs overflow Claude touched', () => {
    expect(
      selectPublishPaths({
        claudeTouched: [
          'packages/webapp/CLAUDE.md',
          'docs/webapp-details.md',
          '.github/workflows/claude-md-compactor.yml',
        ],
        shrunk: ['packages/webapp/CLAUDE.md'],
      })
    ).toEqual(['packages/webapp/CLAUDE.md', 'docs/webapp-details.md']);
  });

  it('drops files the workflow PR already changed versus origin/main', () => {
    expect(
      selectPublishPaths({
        claudeTouched: ['docs/dev-tools-details.md', 'packages/webapp/CLAUDE.md'],
        workflowTouched: ['docs/dev-tools-details.md', '.github/workflows/claude-md-compactor.yml'],
        shrunk: ['packages/webapp/CLAUDE.md'],
      })
    ).toEqual(['packages/webapp/CLAUDE.md']);
  });

  it('still publishes a shrunk guide Claude did not `git add`', () => {
    expect(
      selectPublishPaths({
        claudeTouched: [],
        shrunk: ['packages/webapp/CLAUDE.md'],
      })
    ).toEqual(['packages/webapp/CLAUDE.md']);
  });

  it('still publishes a shrunk guide even if this branch is behind a merged compaction of it', () => {
    // Dispatch 33325727205: origin/main..ORIG_SHA listed webapp CLAUDE.md
    // because #2678 had merged and 2676 still had the 19,998-char copy.
    expect(
      selectPublishPaths({
        claudeTouched: ['packages/webapp/CLAUDE.md'],
        workflowTouched: [
          'packages/webapp/CLAUDE.md',
          'docs/dev-tools-details.md',
          '.github/workflows/claude-md-compactor.yml',
        ],
        shrunk: ['packages/webapp/CLAUDE.md'],
      })
    ).toEqual(['packages/webapp/CLAUDE.md']);
  });
});

describe('formatReport', () => {
  const measurements = measureGuides([
    { path: 'packages/swift-server/CLAUDE.md', content: guide(10012) },
    { path: 'packages/webapp/CLAUDE.md', content: guide(9000) },
    { path: 'packages/vfs-root/shared/CLAUDE.md', content: guide(2900) },
  ]);
  const report = formatReport(measurements);

  it('emits a before/after markdown table sorted largest first', () => {
    const lines = report.split('\n').filter((l) => l.startsWith('|'));
    expect(lines[0]).toBe('| Guide | Before | After | Status |');
    expect(lines[1]).toBe('| --- | --- | --- | --- |');
    expect(lines).toHaveLength(5);
    expect(lines[2]).toBe('| `packages/swift-server/CLAUDE.md` | 10,012 | _pending_ | oversized |');
    expect(lines[3]).toBe('| `packages/webapp/CLAUDE.md` | 9,000 | unchanged | ok |');
    expect(lines[4]).toBe(
      '| `packages/vfs-root/shared/CLAUDE.md` | 2,900 | unchanged | excluded |'
    );
  });

  it('leads with a verdict counting the oversized guides', () => {
    expect(report.split('\n')[0]).toBe('1 of 3 tracked guides are at or above 10,000 chars.');
  });

  it('states the clean no-op explicitly', () => {
    const clean = formatReport(measureGuides([{ path: 'a/CLAUDE.md', content: guide(10) }]));
    expect(clean).toContain('nothing to compact');
  });
});

describe('buildBranchName', () => {
  it('formats the UTC date into the automation branch name', () => {
    expect(buildBranchName(new Date('2026-02-07T22:40:00Z'))).toBe(
      'automation/weekend-claude-compaction-2026-02-07'
    );
    expect(buildBranchName(new Date('2026-01-03T00:00:00Z'))).toBe(
      `${COMPACTION_BRANCH_PREFIX}2026-01-03`
    );
  });

  it('uses UTC, not local time, at a day boundary', () => {
    // 23:30Z Saturday is still the 7th in UTC even where local time is the 8th.
    expect(buildBranchName(new Date('2026-02-07T23:30:00Z'))).toBe(
      `${COMPACTION_BRANCH_PREFIX}2026-02-07`
    );
  });

  it('accepts a string or epoch date and rejects an invalid one', () => {
    expect(buildBranchName('2026-02-07T22:40:00Z')).toBe(`${COMPACTION_BRANCH_PREFIX}2026-02-07`);
    expect(buildBranchName(Date.UTC(2026, 1, 7))).toBe(`${COMPACTION_BRANCH_PREFIX}2026-02-07`);
    expect(() => buildBranchName('not-a-date')).toThrow(/invalid date/);
  });

  it('appends a run id so a same-day re-dispatch cannot reopen a closed PR', () => {
    expect(buildBranchName(new Date('2026-08-30T13:00:00Z'), '33314073562')).toBe(
      `${COMPACTION_BRANCH_PREFIX}2026-08-30-33314073562`
    );
    expect(buildBranchName(new Date('2026-08-30T13:00:00Z'), '  ')).toBe(
      `${COMPACTION_BRANCH_PREFIX}2026-08-30`
    );
  });
});

describe('findExistingCompactionPr', () => {
  const unrelated = {
    html_url: 'https://github.com/ai-ecoverse/slicc/pull/1',
    title: 'feat(webapp): add a panel',
    head: { ref: 'feat/panel' },
  };

  it('matches on the head-branch prefix', () => {
    const pr = {
      html_url: 'https://github.com/ai-ecoverse/slicc/pull/2',
      title: 'anything at all',
      head: { ref: 'automation/weekend-claude-compaction-2026-02-07' },
    };
    expect(findExistingCompactionPr([unrelated, pr])?.url).toBe(pr.html_url);
  });

  it('matches on the title prefix even when the branch was renamed', () => {
    const pr = {
      html_url: 'https://github.com/ai-ecoverse/slicc/pull/3',
      title: `${COMPACTION_TITLE_PREFIX} for weekly headroom`,
      head: { ref: 'someone/manual-rebase' },
    };
    expect(findExistingCompactionPr([unrelated, pr])?.url).toBe(pr.html_url);
    expect(findExistingCompactionPr([{ title: COMPACTION_PR_TITLE, url: 'u' }])?.url).toBe('u');
  });

  it('returns null for unrelated, empty, or malformed input', () => {
    expect(findExistingCompactionPr([unrelated])).toBeNull();
    expect(findExistingCompactionPr([])).toBeNull();
    expect(findExistingCompactionPr(null)).toBeNull();
    expect(findExistingCompactionPr([{}, { head: {} }])).toBeNull();
  });
});

describe('buildPrompt', () => {
  const oversized = selectOversized(
    measureGuides([{ path: 'packages/swift-server/CLAUDE.md', content: guide(10012) }])
  );
  const prompt = buildPrompt({
    oversized,
    branch: 'automation/weekend-claude-compaction-2026-02-07',
    report: 'REPORT_MARKER',
  });

  it('lists the worklist with its measured size and the target', () => {
    expect(prompt).toContain('`packages/swift-server/CLAUDE.md` — 10,012 chars → target ≤ 9,500');
    expect(prompt).toContain('REPORT_MARKER');
  });

  it('forbids mechanical truncation', () => {
    expect(prompt).toContain('Never mechanically truncate');
  });

  it('forbids weakening any gate', () => {
    expect(prompt).toContain('Never change a size gate');
    expect(prompt).toContain('check-doc-sizes-lib.mjs');
  });

  it('forbids PR-number breadcrumbs', () => {
    expect(prompt).toContain('No PR-number breadcrumbs');
  });

  it('explains the 20,000-char gate vs the 10,000-char policy', () => {
    expect(prompt).toContain('20,000 chars');
    expect(prompt).toContain('10,000 → 9,500');
  });

  it('excludes the 3,000-byte runtime guide by name', () => {
    expect(prompt).toContain('packages/vfs-root/shared/CLAUDE.md');
    expect(prompt).toContain('3,000 bytes');
    expect(prompt).toContain('do not touch it');
  });

  it('requires moving overflow detail into docs/ with a resolving link', () => {
    expect(prompt).toContain('existing document under `docs/`');
    expect(prompt).toContain('leave a one-line link behind');
    expect(prompt).toContain('check-doc-refs.mjs');
  });

  it('carries the exact PR title, branch, and validation commands', () => {
    expect(prompt).toContain(COMPACTION_PR_TITLE);
    expect(prompt).toContain('automation/weekend-claude-compaction-2026-02-07');
    expect(prompt).toContain('npm run lint:docs');
    expect(prompt).toContain(
      'node packages/dev-tools/claude-md-compactor/measure-claude-guides.mjs --check'
    );
    expect(prompt).toContain('npx vitest run --project dev-tools');
  });

  it('leaves git, tests, and PR creation to the deterministic workflow step', () => {
    expect(prompt).toContain('Do not create a branch, do not commit, do not push');
    expect(prompt).not.toMatch(/git push -u origin/);
    // `gh pr create` may appear in the prohibition, never as an invocation.
    expect(prompt).not.toMatch(/^\s*gh pr create/m);
    expect(prompt.match(/gh pr create/g)).toHaveLength(1);
    expect(prompt).toContain('PR_BODY_FILE');
    expect(prompt).toContain('synthesises one');
  });

  it('tells Claude the workflow still publishes honest shrinkage', () => {
    expect(prompt).toContain('branched from `origin/main`');
    expect(prompt).toContain('33312644577');
  });

  it('forbids subagents and ending the turn before writes land', () => {
    expect(prompt).toContain('no subagents');
    expect(prompt).toContain('Do not spawn');
    expect(prompt).toContain('Edit/Write');
  });

  it('forbids merging and CI polling', () => {
    expect(prompt).toContain('Never merge the PR');
    expect(prompt).toContain('Do not poll CI');
  });

  it('honours threshold overrides and tolerates an empty worklist', () => {
    const overridden = buildPrompt({ oversized, maxChars: 8000, targetChars: 7600 });
    expect(overridden).toContain('8,000 → 7,600');
    expect(() => buildPrompt()).not.toThrow();
    expect(buildPrompt({ oversized: [] })).toContain('you should not have been invoked');
  });
});
