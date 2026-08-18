import { describe, expect, it } from 'vitest';
import {
  buildBranchName,
  buildPrompt,
  COMPACTION_BRANCH_PREFIX,
  COMPACTION_PR_TITLE,
  COMPACTION_TITLE_PREFIX,
  COMPACTOR_MAX_CHARS,
  COMPACTOR_TARGET_CHARS,
  EXCLUDED_GUIDES,
  findExistingCompactionPr,
  formatReport,
  isExcludedGuide,
  measureGuides,
  parseWorklist,
  selectAboveTarget,
  selectOversized,
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
