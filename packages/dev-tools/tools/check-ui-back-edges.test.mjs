import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_PATH,
  baselineFiles,
  compareToBaseline,
  isWebappSource,
  scanBackEdges,
} from './check-ui-back-edges.mjs';
import { findUiImports, stripComments } from './ui-back-edge-imports-lib.mjs';

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), '..', '..', '..');
const scriptPath = resolve(repoRoot, 'packages/dev-tools/tools/check-ui-back-edges.mjs');

/** Run the guard as the entry script, capturing output even on non-zero exit. */
function runGuard() {
  try {
    return { code: 0, out: execFileSync('node', [scriptPath], { encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('check-ui-back-edges: isWebappSource', () => {
  it('accepts .ts and .tsx source', () => {
    expect(isWebappSource('export-service.ts')).toBe(true);
    expect(isWebappSource('widget.tsx')).toBe(true);
  });

  it('rejects tests and non-TS files', () => {
    expect(isWebappSource('export-service.test.ts')).toBe(false);
    expect(isWebappSource('widget.test.tsx')).toBe(false);
    expect(isWebappSource('README.md')).toBe(false);
  });
});

describe('check-ui-back-edges: import detection', () => {
  it('detects every supported static and dynamic ui import form', () => {
    const samples = [
      "import { x } from '../ui/foo.js';",
      "export * from '../../ui/foo.js';",
      "const x = await import('../ui/foo.js');",
      "const x = require('../../ui/foo.js');",
      "type X = typeof import('../../ui/foo.js');",
      "const x = await import(\n  '../../ui/foo.js'\n);",
    ];
    for (const source of samples) expect(findUiImports(source)).toHaveLength(1);
  });

  it('ignores comments, non-ui paths, and non-literal dynamic imports', () => {
    const source = [
      "// import x from '../ui/comment.js';",
      "import { build } from '@earendil-works/pi-ai/dist/x.js';",
      "import x from '../guidance/foo.js';",
      'const x = await import(uiSpec);',
    ].join('\n');
    expect(findUiImports(source)).toEqual([]);
    expect(stripComments(source).split('\n')).toHaveLength(source.split('\n').length);
  });

  it('preserves comment markers inside strings while stripping real comments', () => {
    const source =
      'const help = `pattern: http://127.0.0.1/*`;\n' +
      "const x = await import('../ui/foo.js'); // forbidden";
    expect(stripComments(source)).toContain('http://127.0.0.1/*');
    expect(findUiImports(source)).toEqual([{ line: 2, match: "import('../ui/foo.js'" }]);
  });
});

describe('check-ui-back-edges: baselineFiles', () => {
  it('returns the baseline keys as a debt list', () => {
    expect(baselineFiles({ 'a.ts': 2, 'b.ts': 1 })).toEqual(['a.ts', 'b.ts']);
  });

  it('returns [] for non-object or empty input', () => {
    expect(baselineFiles(null)).toEqual([]);
    expect(baselineFiles(undefined)).toEqual([]);
    expect(baselineFiles([])).toEqual([]);
    expect(baselineFiles({})).toEqual([]);
  });
});

describe('check-ui-back-edges: compareToBaseline', () => {
  it('passes when current matches the baseline exactly', () => {
    expect(compareToBaseline({ 'a.ts': 2 }, { 'a.ts': 2 })).toEqual([]);
  });

  it('fails on a NEW back-edge in an unbaselined file', () => {
    const failures = compareToBaseline({ 'b.ts': 1 }, {});
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('b.ts: 1 ui/ back-edge(s), baseline allows 0');
  });

  it('fails when a baselined file grows more back-edges', () => {
    const failures = compareToBaseline({ 'a.ts': 3 }, { 'a.ts': 2 });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('baseline allows 2');
  });

  it('fails (ratchet) when a file has fewer back-edges than the baseline', () => {
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

describe('check-ui-back-edges: end-to-end over the real tree', () => {
  it('scan matches the committed baseline (one-way ratchet holds)', () => {
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    expect(compareToBaseline(scanBackEdges(), baseline)).toEqual([]);
  });

  it('guard entry script passes and reports the grandfathered count', () => {
    const { code, out } = runGuard();
    expect(code).toBe(0);
    expect(out).toMatch(/ok: no new ui\/ back-edges in packages\/webapp\/src/);
  });
});
