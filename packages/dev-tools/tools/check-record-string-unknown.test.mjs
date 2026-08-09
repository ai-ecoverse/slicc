import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_PATH,
  compareToBaseline,
  countsFromHits,
  isTestPath,
  parseDiagnostics,
  scanRecordTypes,
} from './check-record-string-unknown.mjs';

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), '..', '..', '..');
const scriptPath = resolve(repoRoot, 'packages/dev-tools/tools/check-record-string-unknown.mjs');

/** Run the guard as the entry script, capturing output even on non-zero exit. */
function runGuard() {
  try {
    return { code: 0, out: execFileSync('node', [scriptPath], { encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

const MARKER = 'Record<string, unknown> is banned in source: declare a named type';

/** Minimal Biome `--reporter=json` diagnostic for this rule. */
function diagnostic(path, line = 1, column = 1, message = MARKER) {
  return {
    severity: 'error',
    message,
    category: 'plugin',
    location: { path, start: { line, column } },
  };
}

describe('check-record-string-unknown: isTestPath', () => {
  it('treats the repo tests/ convention as out of scope', () => {
    expect(isTestPath('packages/webapp/tests/ui/wc/wc-attach.test.ts')).toBe(true);
    expect(isTestPath('packages/shared-ts/test/helper.ts')).toBe(true);
  });

  it('treats per-file test/spec suffixes as out of scope', () => {
    expect(isTestPath('packages/webapp/src/foo.test.ts')).toBe(true);
    expect(isTestPath('packages/webapp/src/foo.test.tsx')).toBe(true);
    expect(isTestPath('packages/webapp/src/foo.spec.ts')).toBe(true);
    expect(isTestPath('packages/dev-tools/tools/check-doc-refs.test.mjs')).toBe(true);
    expect(isTestPath('packages/dev-tools/tools/test-dips.mjs')).toBe(true);
  });

  it('keeps ordinary source in scope', () => {
    expect(isTestPath('packages/webapp/src/cdp/browser-api.ts')).toBe(false);
    expect(isTestPath('packages/cherry/src/protocol.ts')).toBe(false);
    // Storybook stories are shipped source, not test scaffolding.
    expect(isTestPath('packages/webcomponents/src/overlay/slicc-permissions.stories.ts')).toBe(
      false
    );
    // "latest.ts" contains "test" but is not a test path.
    expect(isTestPath('packages/webapp/src/providers/latest.ts')).toBe(false);
  });
});

describe('check-record-string-unknown: parseDiagnostics', () => {
  it('extracts file/line/column for this rule', () => {
    const hits = parseDiagnostics({ diagnostics: [diagnostic('packages/cherry/src/a.ts', 12, 7)] });
    expect(hits).toEqual([{ file: 'packages/cherry/src/a.ts', line: 12, column: 7 }]);
  });

  it('ignores diagnostics from other plugins sharing the run', () => {
    const payload = {
      diagnostics: [
        diagnostic('packages/webapp/src/a.ts'),
        diagnostic('packages/webapp/src/b.ts', 1, 1, 'innerHTML assignment is banned'),
      ],
    };
    expect(parseDiagnostics(payload).map((h) => h.file)).toEqual(['packages/webapp/src/a.ts']);
  });

  it('drops hits in test files', () => {
    const payload = {
      diagnostics: [
        diagnostic('packages/webapp/tests/a.test.ts'),
        diagnostic('packages/webapp/src/a.ts'),
      ],
    };
    expect(parseDiagnostics(payload).map((h) => h.file)).toEqual(['packages/webapp/src/a.ts']);
  });

  it('normalizes Windows path separators', () => {
    const hits = parseDiagnostics({ diagnostics: [diagnostic('packages\\cherry\\src\\a.ts')] });
    expect(hits[0].file).toBe('packages/cherry/src/a.ts');
    // …and the normalized path is what the test filter sees.
    expect(
      parseDiagnostics({ diagnostics: [diagnostic('packages\\webapp\\tests\\a.ts')] })
    ).toEqual([]);
  });

  it('sorts by file then line', () => {
    const payload = {
      diagnostics: [diagnostic('b.ts', 5), diagnostic('a.ts', 9), diagnostic('a.ts', 2)],
    };
    expect(parseDiagnostics(payload).map((h) => `${h.file}:${h.line}`)).toEqual([
      'a.ts:2',
      'a.ts:9',
      'b.ts:5',
    ]);
  });

  it('returns [] for malformed payloads instead of throwing', () => {
    expect(parseDiagnostics(null)).toEqual([]);
    expect(parseDiagnostics({})).toEqual([]);
    expect(parseDiagnostics({ diagnostics: 'nope' })).toEqual([]);
    expect(parseDiagnostics({ diagnostics: [{ message: MARKER }] })).toEqual([]);
    expect(parseDiagnostics({ diagnostics: [{ location: { path: 'a.ts' } }] })).toEqual([]);
  });
});

describe('check-record-string-unknown: countsFromHits', () => {
  it('collapses hits into per-file counts', () => {
    const hits = [
      { file: 'a.ts', line: 1 },
      { file: 'a.ts', line: 4 },
      { file: 'b.ts', line: 2 },
    ];
    expect(countsFromHits(hits)).toEqual({ 'a.ts': 2, 'b.ts': 1 });
  });

  it('returns {} for no hits', () => {
    expect(countsFromHits([])).toEqual({});
  });
});

describe('check-record-string-unknown: compareToBaseline', () => {
  it('passes when current matches the baseline exactly', () => {
    expect(compareToBaseline({ 'a.ts': 2 }, { 'a.ts': 2 })).toEqual([]);
  });

  it('fails on a NEW occurrence in an unbaselined file', () => {
    const failures = compareToBaseline({ 'b.ts': 1 }, {});
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('b.ts: 1 Record<string, unknown>, baseline allows 0');
  });

  it('fails when a baselined file grows more occurrences', () => {
    const failures = compareToBaseline({ 'a.ts': 3 }, { 'a.ts': 2 });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('baseline allows 2');
  });

  it('fails (ratchet) when a file has fewer occurrences than the baseline', () => {
    const failures = compareToBaseline({ 'a.ts': 1 }, { 'a.ts': 2 });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('--update');
  });

  it('fails on a stale baseline entry for a clean file', () => {
    const failures = compareToBaseline({}, { 'gone.ts': 1 });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('stale');
  });
});

// Unlike the layer back-edge scan, which is pure JS, each of these spawns
// Biome over the whole repo. That is ~0.5s on an idle machine but well past
// Vitest's 5s default on a CI runner building three Node versions at once, so
// both subprocess tests carry an explicit timeout.
const SPAWN_TIMEOUT_MS = 60_000;

describe('check-record-string-unknown: end-to-end over the real tree', () => {
  it(
    'scan matches the committed baseline (one-way ratchet holds)',
    () => {
      const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
      expect(compareToBaseline(scanRecordTypes().counts, baseline)).toEqual([]);
    },
    SPAWN_TIMEOUT_MS
  );

  it('baseline contains only non-test source files', () => {
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    expect(Object.keys(baseline).filter(isTestPath)).toEqual([]);
  });

  it(
    'guard entry script passes and reports the grandfathered count',
    () => {
      const { code, out } = runGuard();
      expect(code).toBe(0);
      expect(out).toMatch(/ok: no new Record<string, unknown> in source/);
    },
    SPAWN_TIMEOUT_MS
  );
});
