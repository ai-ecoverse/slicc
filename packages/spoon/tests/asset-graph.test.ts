import {
  ASSET_DIR,
  assetKey,
  buildAssetImportMap,
  crawlAssetGraph,
  extractAssetSpecifiers,
  extractHtmlModuleUrls,
  isAssetSpecifier,
  resolveAssetPath,
  rewriteModuleSource,
  TUNNEL_ASSET_SCHEME,
} from '../src/tunnel/asset-graph.js';

describe('isAssetSpecifier', () => {
  it('accepts relative, absolute, and bare assets/ chunk specifiers', () => {
    expect(isAssetSpecifier('./main-abc.js')).toBe(true);
    expect(isAssetSpecifier('../main-abc.js')).toBe(true);
    expect(isAssetSpecifier('/assets/main-abc.js')).toBe(true);
    expect(isAssetSpecifier('assets/main-abc.js')).toBe(true);
  });

  it('rejects bare package specifiers, non-js, and URLs with a scheme', () => {
    expect(isAssetSpecifier('react')).toBe(false);
    expect(isAssetSpecifier('./styles.css')).toBe(false);
    expect(isAssetSpecifier('https://cdn.example.com/x.js')).toBe(false);
    expect(isAssetSpecifier('data:text/javascript,0')).toBe(false);
    expect(isAssetSpecifier(`${TUNNEL_ASSET_SCHEME}/assets/x.js`)).toBe(false);
  });

  it('ignores query and hash when classifying', () => {
    expect(isAssetSpecifier('./main-abc.js?v=1')).toBe(true);
    expect(isAssetSpecifier('/assets/main-abc.js#frag')).toBe(true);
  });
});

describe('resolveAssetPath', () => {
  it('normalizes every asset specifier to a flat /assets/<basename> path', () => {
    expect(resolveAssetPath('./main-abc.js')).toBe('/assets/main-abc.js');
    expect(resolveAssetPath('../chunk-xy.js')).toBe('/assets/chunk-xy.js');
    expect(resolveAssetPath('/assets/deep-Z.js')).toBe('/assets/deep-Z.js');
    expect(resolveAssetPath('assets/deep-Z.js')).toBe('/assets/deep-Z.js');
    expect(resolveAssetPath('./x.js?v=2')).toBe('/assets/x.js');
  });

  it('returns null for non-asset specifiers', () => {
    expect(resolveAssetPath('react')).toBeNull();
    expect(resolveAssetPath('https://x/y.js')).toBeNull();
  });

  it('uses the shared ASSET_DIR constant', () => {
    expect(resolveAssetPath('./x.js')?.startsWith(ASSET_DIR)).toBe(true);
  });
});

describe('extractAssetSpecifiers', () => {
  it('finds static from-imports, side-effect imports, and dynamic imports', () => {
    const src = [
      'import{a,b}from"./account-store-fsZiMtXd.js";',
      'import"./modulepreload-polyfill-P2Xu9kJm.js";',
      'export*from"./providers-CvRdyDpX.js";',
      'const x=()=>import(`./setup-feature-flags-remote-B1tLs0mW.js`);',
      'const y=()=>import("./wc-shell-CdxYnLU8.js");',
    ].join('\n');
    const specs = extractAssetSpecifiers(src).sort();
    expect(specs).toEqual(
      [
        '/assets/account-store-fsZiMtXd.js',
        '/assets/modulepreload-polyfill-P2Xu9kJm.js',
        '/assets/providers-CvRdyDpX.js',
        '/assets/setup-feature-flags-remote-B1tLs0mW.js',
        '/assets/wc-shell-CdxYnLU8.js',
      ].sort()
    );
  });

  it('captures __vite__mapDeps preload entries (bare assets/ paths)', () => {
    const src =
      'const d=(m.f||(m.f=["assets/feature-flags-Cf-Bv5AK.js","assets/src-CAWTvdAa.js"]));';
    expect(extractAssetSpecifiers(src).sort()).toEqual([
      '/assets/feature-flags-Cf-Bv5AK.js',
      '/assets/src-CAWTvdAa.js',
    ]);
  });

  it('ignores bare package specifiers and non-js strings', () => {
    const src = 'import x from"react";import"./real-Ab.js";const s="notimport-x.js";';
    // "notimport-x.js" is a bare filename with no ./ or assets/ prefix → not an asset.
    expect(extractAssetSpecifiers(src)).toEqual(['/assets/real-Ab.js']);
  });
});

describe('rewriteModuleSource', () => {
  it('rewrites import specifiers to the slicc-asset scheme, leaving code intact', () => {
    const src =
      'import{a}from"./dep-Ab.js";const p=import("./lazy-Cd.js");export*from"./re-Ef.js";';
    const out = rewriteModuleSource(src);
    expect(out).toContain(`from"${TUNNEL_ASSET_SCHEME}/assets/dep-Ab.js"`);
    expect(out).toContain(`import("${TUNNEL_ASSET_SCHEME}/assets/lazy-Cd.js")`);
    expect(out).toContain(`from"${TUNNEL_ASSET_SCHEME}/assets/re-Ef.js"`);
  });

  it('leaves bare/external specifiers untouched', () => {
    const src = 'import React from"react";import"https://cdn/x.js";';
    expect(rewriteModuleSource(src)).toBe(src);
  });

  it('does not rewrite non-import .js string literals used as data', () => {
    const src = 'const name="config.js";log("./thing.js is data");';
    // Neither is an import position; "config.js" is bare (not an asset), and the
    // logged string is not in a from/import position.
    expect(rewriteModuleSource(src)).toBe(src);
  });

  it('is idempotent-safe: already-rewritten specifiers are left alone', () => {
    const once = rewriteModuleSource('import"./a-1.js";');
    expect(rewriteModuleSource(once)).toBe(once);
  });

  it('neutralizes __vite__mapDeps CALLS (computed absolute preloads) to []', () => {
    const src = 'const p=__vitePreload(()=>import("./chunk-Ab.js"),__vite__mapDeps([0,1,2]));';
    const out = rewriteModuleSource(src);
    expect(out).toContain('__vite__mapDeps([0,1,2])'.replace('__vite__mapDeps([0,1,2])', '[]'));
    expect(out).not.toContain('__vite__mapDeps([0,1,2])');
    // the real relative chunk import is still rewritten to a resolvable key
    expect(out).toContain(`import("${TUNNEL_ASSET_SCHEME}/assets/chunk-Ab.js")`);
  });

  it('leaves the __vite__mapDeps DEFINITION (=(...)) intact', () => {
    // Definition uses `__vite__mapDeps=(` — must not be mistaken for a call.
    const def =
      'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/x-Ab.js"])))=>i.map(j=>d[j]);';
    // The definition body's inner `["assets/x-Ab.js"]` data array stays; only
    // CALL sites collapse. No `__vite__mapDeps(<args>)` call appears here.
    expect(rewriteModuleSource(def)).toBe(def);
  });
});

describe('extractHtmlModuleUrls', () => {
  const html = `<!DOCTYPE html><html><head>
    <script type="module" crossorigin src="/assets/main-C1z-umpk.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/models-DgdVqaw5.js">
    <link rel="modulepreload" crossorigin href="/assets/logger-DDBAeTLF.js">
    <link rel="icon" href="/logos/x.png">
  </head><body><div id="app"></div></body></html>`;

  it('finds the module entry and all modulepreload seeds', () => {
    const { entry, seeds } = extractHtmlModuleUrls(html);
    expect(entry).toBe('/assets/main-C1z-umpk.js');
    expect(seeds.sort()).toEqual([
      '/assets/logger-DDBAeTLF.js',
      '/assets/main-C1z-umpk.js',
      '/assets/models-DgdVqaw5.js',
    ]);
  });

  it('ignores non-module scripts and non-modulepreload links', () => {
    const { entry, seeds } = extractHtmlModuleUrls(
      '<script src="/assets/classic.js"></script><link rel="icon" href="/assets/nope.js">'
    );
    expect(entry).toBeNull();
    expect(seeds).toEqual([]);
  });
});

describe('crawlAssetGraph', () => {
  it('BFS-collects the transitive graph via the injected fetchText', async () => {
    const modules: Record<string, string> = {
      '/assets/main.js': 'import"./a.js";import("./b.js");',
      '/assets/a.js': 'import"./c.js";',
      '/assets/b.js': 'export const b=1;',
      '/assets/c.js': 'export const c=1;',
    };
    const fetched: string[] = [];
    const graph = await crawlAssetGraph({
      seeds: ['/assets/main.js'],
      originResolve: (p) => `https://host${p}`,
      fetchText: async (url) => {
        const path = url.replace('https://host', '');
        fetched.push(path);
        return modules[path] ?? '';
      },
    });
    expect([...graph.keys()].sort()).toEqual([
      '/assets/a.js',
      '/assets/b.js',
      '/assets/c.js',
      '/assets/main.js',
    ]);
    // every module fetched exactly once
    expect(fetched.length).toBe(4);
  });

  it('skips modules that fail to fetch and reports them, without aborting', async () => {
    const errors: string[] = [];
    const graph = await crawlAssetGraph({
      seeds: ['/assets/main.js', '/assets/bad.js'],
      originResolve: (p) => p,
      fetchText: async (p) => {
        if (p === '/assets/bad.js') throw new Error('ERR_ACCESS_DENIED');
        return 'export const ok=1;';
      },
      onError: (assetPath) => errors.push(assetPath),
    });
    expect(graph.has('/assets/main.js')).toBe(true);
    expect(graph.has('/assets/bad.js')).toBe(false);
    expect(errors).toEqual(['/assets/bad.js']);
  });
});

describe('buildAssetImportMap', () => {
  it('maps slicc-asset keys to blob URLs', () => {
    const map = buildAssetImportMap(
      new Map([
        ['/assets/main.js', 'blob:null/1'],
        ['/assets/a.js', 'blob:null/2'],
      ])
    );
    expect(map).toEqual({
      imports: {
        [assetKey('/assets/main.js')]: 'blob:null/1',
        [assetKey('/assets/a.js')]: 'blob:null/2',
      },
    });
  });
});
