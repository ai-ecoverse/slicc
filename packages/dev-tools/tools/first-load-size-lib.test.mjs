import { describe, expect, it } from 'vitest';
import {
  bytesToKb,
  ceilingKeyFor,
  checkFirstLoad,
  chunkEagerClosure,
  manifestEagerClosure,
  parseStaticImports,
} from './first-load-size-lib.mjs';

describe('parseStaticImports', () => {
  it('matches minified import-from, export-from, and bare imports', () => {
    const src =
      'import{a as b,c}from"./chunk-abc.js";import t from\'./def-1.js\';' +
      'import"./side-effect.js";export{x}from"./re-export.js";export*from"./star.js"';
    expect(parseStaticImports(src).sort()).toEqual([
      './chunk-abc.js',
      './def-1.js',
      './re-export.js',
      './side-effect.js',
      './star.js',
    ]);
  });

  it('ignores dynamic imports (paren and template-literal forms)', () => {
    const src = 'import("./lazy-a.js");__vitePreload(()=>import(`./lazy-b.js`),[])';
    expect(parseStaticImports(src)).toEqual([]);
  });

  it('ignores absolute and package specifiers', () => {
    const src = 'import{x}from"lodash";import{y}from"/abs/path.js"';
    expect(parseStaticImports(src)).toEqual([]);
  });

  it('dedupes repeated specifiers', () => {
    const src = 'import{a}from"./x.js";export{b}from"./x.js"';
    expect(parseStaticImports(src)).toEqual(['./x.js']);
  });
});

describe('manifestEagerClosure', () => {
  const manifest = {
    'index.html': { file: 'assets/main.js', imports: ['_a.js', '_b.js'] },
    '_a.js': {
      file: 'assets/a.js',
      css: ['assets/a.css'],
      imports: ['_b.js'],
      dynamicImports: ['_lazy.js'],
    },
    '_b.js': { file: 'assets/b.js' },
    '_lazy.js': { file: 'assets/lazy.js', css: ['assets/lazy.css'] },
  };

  it('walks static imports transitively, excluding dynamic imports', () => {
    expect(manifestEagerClosure(manifest, 'index.html').sort()).toEqual([
      'assets/a.css',
      'assets/a.js',
      'assets/b.js',
      'assets/main.js',
    ]);
  });

  it('counts css only for chunks in the eager closure, not lazy ones', () => {
    expect(manifestEagerClosure(manifest, 'index.html')).not.toContain('assets/lazy.css');
  });

  it('throws on a missing entry so a renamed entry cannot silently pass', () => {
    expect(() => manifestEagerClosure(manifest, 'nope.html')).toThrow(/no entry/);
  });
});

describe('chunkEagerClosure', () => {
  it('walks emitted chunks and skips specifiers with no matching file', () => {
    const files = {
      'entry.js': 'import{a}from"./real.js";import{b}from"./ghost-in-a-doc-string.js"',
      'real.js': 'import("./lazy.js")',
      'lazy.js': '',
    };
    const closure = chunkEagerClosure('entry.js', (f) => files[f] ?? null);
    expect(closure.sort()).toEqual(['entry.js', 'real.js']);
  });
});

describe('checkFirstLoad', () => {
  const limits = { maxDeltaKb: 4, pageEagerCeilingKb: 768, workerEagerCeilingKb: 4288 };
  const kb = (n) => n * 1024;
  // Roughly main's real shape at the time the delta gate replaced the
  // absolute ratchet: page 731 kB, worker 4160 kB.
  const base = { page: kb(731), worker: kb(4160) };

  it('passes a change that adds nothing', () => {
    const { failures, notes } = checkFirstLoad(limits, base, base);
    expect(failures).toEqual([]);
    expect(notes).toEqual([]);
  });

  it('passes the real in-flight PR deltas that the absolute ratchet failed', () => {
    // Measured against their own merge-bases: #2422 +1.09 kB, #2436 +0.78 kB,
    // #2438 +0.64 kB. All three had to patch the old absolute budget anyway.
    for (const addedKb of [1.09, 0.78, 0.64, 1.54]) {
      const measured = { page: base.page, worker: base.worker + addedKb * 1024 };
      expect(checkFirstLoad(limits, measured, base).failures).toEqual([]);
    }
  });

  it('fails a hoist of a lazy chunk into the boot graph', () => {
    // A static `unpdf` import in the boot-critical supplemental-commands
    // index measured +7.0 kB on the real bundle.
    const measured = { page: base.page, worker: base.worker + 7.02 * 1024 };
    const { failures } = checkFirstLoad(limits, measured, base);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/worker graph/);
    expect(failures[0]).toMatch(/adds 7\.0 kB/);
    expect(failures[0]).toMatch(/4 kB per-change allowance/);
  });

  it('never fails a change for growth it inherited from the merge-base', () => {
    // The bug this gate shape replaced: main itself sat over the absolute
    // budget, so every webapp PR went red without having added anything.
    const overCeiling = { page: kb(800), worker: kb(4400) };
    const { failures } = checkFirstLoad(limits, overCeiling, overCeiling);
    // Both ceilings are breached, but neither failure blames a delta.
    expect(failures).toHaveLength(2);
    for (const f of failures) expect(f).toMatch(/ceiling/);
    expect(failures.join(' ')).not.toMatch(/allowance/);
  });

  it('reports a shrink as a negative delta without failing', () => {
    const measured = { page: base.page, worker: base.worker - kb(50) };
    const { failures, rows } = checkFirstLoad(limits, measured, base);
    expect(failures).toEqual([]);
    expect(rows.find((r) => r.graph === 'worker').deltaKb).toBe(-50);
  });

  it('fails when a graph exceeds its absolute ceiling', () => {
    const measured = { page: base.page, worker: kb(4289) };
    const { failures } = checkFirstLoad(limits, measured, measured);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/workerEagerCeilingKb/);
  });

  it('enforces both graphs independently', () => {
    const measured = { page: base.page + kb(9), worker: base.worker + kb(9) };
    const { failures } = checkFirstLoad(limits, measured, base);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatch(/page graph/);
    expect(failures[1]).toMatch(/worker graph/);
  });

  it('skips the delta check but keeps the ceilings when the baseline is missing', () => {
    const measured = { page: base.page, worker: kb(4400) };
    const { failures, notes, rows } = checkFirstLoad(limits, measured, null);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/SKIPPED/);
    expect(rows.every((r) => r.deltaKb === null)).toBe(true);
    // Degraded, not silently green.
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/ceiling/);
  });

  it('fails when the limits file is missing maxDeltaKb', () => {
    const { failures } = checkFirstLoad({ ...limits, maxDeltaKb: undefined }, base, base);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/maxDeltaKb/);
  });

  it('fails when the limits file is missing a ceiling', () => {
    const { failures } = checkFirstLoad({ ...limits, workerEagerCeilingKb: undefined }, base, base);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/workerEagerCeilingKb/);
  });

  it('reports headroom to the ceiling for each graph', () => {
    const { rows } = checkFirstLoad(limits, base, base);
    expect(rows.map((r) => [r.graph, r.kb, r.headroomKb])).toEqual([
      ['page', 731, 37],
      ['worker', 4160, 128],
    ]);
  });
});

describe('ceilingKeyFor / bytesToKb', () => {
  it('maps a graph name to its ceiling key', () => {
    expect(ceilingKeyFor('page')).toBe('pageEagerCeilingKb');
    expect(ceilingKeyFor('worker')).toBe('workerEagerCeilingKb');
  });

  it('rounds bytes to whole kB', () => {
    expect(bytesToKb(4259702)).toBe(4160);
    expect(bytesToKb(0)).toBe(0);
  });
});
