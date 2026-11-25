import * as diffs from '@pierre/diffs';
import { describe, expect, it, vi } from 'vitest';
import {
  type DiffsLanguageApi,
  withPlainTextFallback,
} from '../../src/quick-look/highlight-language.js';

/**
 * A stand-in for the two `@pierre/diffs` functions the guard calls: inference
 * by extension, and a `resolveLanguage` that only knows `available`.
 */
function fakeDiffs(available: readonly string[]) {
  const byExtension: Partial<Record<string, string>> = {
    ts: 'typescript',
    abap: 'abap',
    md: 'markdown',
  };
  return {
    getFiletypeFromFileName: (name: string) => byExtension[name.split('.').pop() ?? ''] ?? 'text',
    resolveLanguage: vi.fn(async (lang: string) => {
      if (!available.includes(lang)) throw new Error(`resolveLanguage: "${lang}" not found`);
      return { name: lang, data: [] };
    }),
  } satisfies DiffsLanguageApi;
}

describe('withPlainTextFallback', () => {
  it('hands loadable files through untouched, so they still highlight', async () => {
    const api = fakeDiffs(['typescript']);
    const oldFile = { name: 'main.ts', contents: 'a' };
    const newFile = { name: 'main.ts', contents: 'b' };

    const [outOld, outNew] = await withPlainTextFallback(api, [oldFile, newFile]);

    expect(outOld).toBe(oldFile);
    expect(outNew).toBe(newFile);
    expect(outNew?.lang).toBeUndefined();
  });

  it('forces every target to plain text when a grammar is missing', async () => {
    const api = fakeDiffs(['typescript']);
    const files = [
      { name: 'report.abap', contents: 'a' },
      { name: 'report.abap', contents: 'b' },
    ];

    const out = await withPlainTextFallback(api, files);

    expect(out.map((f) => f.lang)).toEqual(['text', 'text']);
    expect(out.map((f) => f.contents)).toEqual(['a', 'b']);
    // Copies — the caller's objects (a sprinkle's `el.oldFile`) stay as given.
    expect(files[0]).not.toHaveProperty('lang');
  });

  it('falls back when only ONE side of a diff is missing', async () => {
    // The render's language comes from the new side's `lang`, else both names
    // are inferred, so a half-fixed pair would still request `abap`.
    const api = fakeDiffs(['typescript']);
    const out = await withPlainTextFallback(api, [
      { name: 'report.ts', contents: 'a' },
      { name: 'report.abap', contents: 'b' },
    ]);
    expect(out.map((f) => f.lang)).toEqual(['text', 'text']);
  });

  it("checks a parsed patch's pre-rename name as well", async () => {
    const api = fakeDiffs(['typescript']);
    const [fileDiff] = await withPlainTextFallback(api, [
      { name: 'report.ts', prevName: 'report.abap' },
    ]);
    expect(fileDiff?.lang).toBe('text');
  });

  it('checks an explicit lang instead of inferring from the name', async () => {
    const api = fakeDiffs(['typescript']);
    const [explicitMissing] = await withPlainTextFallback(api, [{ name: 'a.ts', lang: 'abap' }]);
    expect(explicitMissing?.lang).toBe('text');

    const pinned = { name: 'a.abap', lang: 'typescript' };
    const [explicitPresent] = await withPlainTextFallback(api, [pinned]);
    expect(explicitPresent).toBe(pinned);
  });

  it('never probes for the grammar-less languages', async () => {
    const api = fakeDiffs([]);
    const file = { name: 'LICENSE', contents: 'MIT' };
    const [out] = await withPlainTextFallback(api, [file, { name: 'x.log', lang: 'ansi' }]);
    expect(out).toBe(file);
    expect(api.resolveLanguage).not.toHaveBeenCalled();
  });

  it('probes each distinct grammar once', async () => {
    const api = fakeDiffs(['typescript']);
    await withPlainTextFallback(api, [
      { name: 'a.ts', contents: '' },
      { name: 'b.ts', contents: '' },
    ]);
    expect(api.resolveLanguage).toHaveBeenCalledTimes(1);
  });

  it('agrees with the grammar set @pierre/diffs actually resolves against', async () => {
    // `vitest.config.ts` serves the library the shipped set (Shiki's
    // `bundle/web`, the webapp's curated base): TypeScript is in it, ABAP is
    // not — exactly the pair that broke in production.
    const [ts] = await withPlainTextFallback(diffs, [{ name: 'main.ts', contents: '' }]);
    expect(ts?.lang).toBeUndefined();
    const [abap] = await withPlainTextFallback(diffs, [{ name: 'report.abap', contents: '' }]);
    expect(abap?.lang).toBe('text');
  });
});
