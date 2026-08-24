import { describe, expect, it } from 'vitest';
import {
  checkBudgets,
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
    '_a.js': { file: 'assets/a.js', imports: ['_b.js'], dynamicImports: ['_lazy.js'] },
    '_b.js': { file: 'assets/b.js' },
    '_lazy.js': { file: 'assets/lazy.js' },
  };

  it('walks static imports transitively, excluding dynamic imports', () => {
    expect(manifestEagerClosure(manifest, 'index.html').sort()).toEqual([
      'assets/a.js',
      'assets/b.js',
      'assets/main.js',
    ]);
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

describe('checkBudgets', () => {
  const budgets = { pageEagerKb: 100, workerEagerKb: 1000 };

  it('passes within budget without ratchet hints inside the slack band', () => {
    const { failures, ratchetHints } = checkBudgets(budgets, {
      pageEagerKb: 98,
      workerEagerKb: 990,
    });
    expect(failures).toEqual([]);
    expect(ratchetHints).toEqual([]);
  });

  it('fails when a graph exceeds its budget', () => {
    const { failures } = checkBudgets(budgets, { pageEagerKb: 101, workerEagerKb: 1 });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/pageEagerKb/);
  });

  it('hints to tighten when headroom exceeds the slack percentage', () => {
    const { failures, ratchetHints } = checkBudgets(budgets, {
      pageEagerKb: 50,
      workerEagerKb: 999,
    });
    expect(failures).toEqual([]);
    expect(ratchetHints).toHaveLength(1);
    expect(ratchetHints[0]).toMatch(/pageEagerKb/);
  });

  it('fails when the budget file is missing a key', () => {
    const { failures } = checkBudgets({ pageEagerKb: 100 }, { pageEagerKb: 1, workerEagerKb: 1 });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/workerEagerKb/);
  });
});
