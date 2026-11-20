import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  curatedShikiBundlePlugin,
  isCuratedShikiSpecifier,
  isPierreHighlightsSpecifier,
  omitPierreHighlightsPlugin,
  PIERRE_HIGHLIGHTS_SHIM,
  SHIKI_BUNDLE_SHIM,
} from '../../vite-plugins/pierre-diffs-size-guards.js';

/**
 * The size guards in `vite-plugins/pierre-diffs-size-guards.ts`
 * (`curatedShikiBundlePlugin`, `omitPierreHighlightsPlugin`) intercept specific import specifiers. When a
 * `@pierre/diffs` upgrade changes WHERE it gets Shiki's language map, the
 * full 332-grammar set slips past the plugin and ships again (1.6 moved it
 * from `shiki` to `shiki/langs`: +5 MB). These tests pin the specifiers the
 * library actually imports so that drift fails here, not in bundle-size.
 */

// npm workspaces hoist `@pierre/diffs` to the repo root. (`node:module` is
// shimmed in this project's test config, so `createRequire` is unavailable.)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const diffsDist = join(repoRoot, 'node_modules/@pierre/diffs/dist');

function listJs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    // The prebuilt worker bundles are not imported by SLICC.
    if (entry.isDirectory()) {
      if (entry.name !== 'worker') out.push(...listJs(path));
    } else if (entry.name.endsWith('.js')) out.push(path);
  }
  return out;
}

function importedSpecifiers(prefix: RegExp): Set<string> {
  const specifiers = new Set<string>();
  const pattern = /(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g;
  for (const file of listJs(diffsDist)) {
    for (const match of readFileSync(file, 'utf8').matchAll(pattern)) {
      if (prefix.test(match[1])) specifiers.add(match[1]);
    }
  }
  return specifiers;
}

describe('@pierre/diffs import surface the size guards rely on', () => {
  it('reaches Shiki only through specifiers that cannot pull the full grammar set', () => {
    // Anything that is not redirected must be a grammar-free entry point.
    // A new specifier here (e.g. `shiki/bundle/full`, `@shikijs/langs`) must be
    // routed through the shim before the upgrade lands.
    const grammarFree = new Set([
      'shiki/core',
      'shiki/textmate',
      'shiki/wasm',
      'shiki/engine/javascript',
      'shiki/engine/oniguruma',
    ]);
    const seen = [...importedSpecifiers(/^(shiki|@shikijs\/)/)];
    expect(seen.filter((s) => !isCuratedShikiSpecifier(s) && !grammarFree.has(s))).toEqual([]);
    // 1.6 takes the language map from `shiki/langs`; it must be redirected.
    expect(seen).toContain('shiki/langs');
  });

  it('imports @pierre/highlights only by specifiers the omit plugin covers', () => {
    const seen = [...importedSpecifiers(/^@pierre\/highlights/)];
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((s) => !isPierreHighlightsSpecifier(s))).toEqual([]);
  });
});

describe('size-guard plugins', () => {
  it('redirects only the language-map specifiers to the curated shim', () => {
    const { resolveId } = curatedShikiBundlePlugin();
    expect(resolveId('shiki')).toBe(SHIKI_BUNDLE_SHIM);
    expect(resolveId('shiki/langs')).toBe(SHIKI_BUNDLE_SHIM);
    // The shim imports these itself; redirecting them would recurse.
    for (const real of [
      'shiki/bundle/web',
      'shiki/langs/go.mjs',
      'shiki/core',
      'shiki/engine/javascript',
    ]) {
      expect(resolveId(real)).toBeUndefined();
    }
  });

  it('omits @pierre/highlights and its subpaths, and nothing else', () => {
    const { resolveId } = omitPierreHighlightsPlugin();
    for (const s of [
      '@pierre/highlights',
      '@pierre/highlights/themes/loader',
      '@pierre/highlights/themes/nord',
    ]) {
      expect(resolveId(s)).toBe(PIERRE_HIGHLIGHTS_SHIM);
    }
    for (const s of ['@pierre/highlightsx', '@pierre/diffs', '@pierre/theming']) {
      expect(resolveId(s)).toBeUndefined();
    }
  });

  it('points at shim files that exist', () => {
    expect(existsSync(SHIKI_BUNDLE_SHIM)).toBe(true);
    expect(existsSync(PIERRE_HIGHLIGHTS_SHIM)).toBe(true);
  });
});

describe('curated shiki bundle shim', () => {
  it('serves bundle/web plus the repo languages, not the full set', async () => {
    const { bundledLanguages } = await import('../../src/shims/shiki-bundle.js');
    for (const lang of [
      'typescript',
      'javascript',
      'json',
      'go',
      'rust',
      'swift',
      'toml',
      'diff',
    ]) {
      expect(bundledLanguages).toHaveProperty(lang);
    }
    // A grammar from the full bundle only.
    expect(bundledLanguages).not.toHaveProperty('abap');
    expect(Object.keys(bundledLanguages).length).toBeLessThan(120);
  });

  it('loads an extra language through the same lazy loader shape', async () => {
    const { bundledLanguages } = await import('../../src/shims/shiki-bundle.js');
    const mod = await bundledLanguages.go();
    expect(Array.isArray(mod.default)).toBe(true);
  });
});

describe('pierre-highlights shim', () => {
  it('exposes the names @pierre/diffs imports and fails loudly when used', async () => {
    const mod = await import('../../src/shims/pierre-highlights.js');
    expect(() => mod.isSupportedLanguage('ts')).toThrow(mod.PIERRE_HIGHLIGHTS_UNAVAILABLE);
    expect(() => mod.codeToTokens('x')).toThrow(/not bundled/);
    expect(() => new mod.LiveTokenizer({})).toThrow(/not bundled/);
  });

  it('presents an empty theme catalog so the highlights resolver finds nothing', async () => {
    const { themes } = await import('../../src/shims/pierre-highlights.js');
    expect(Object.keys(themes)).toEqual([]);
    expect(Object.isFrozen(themes)).toBe(true);
  });
});
