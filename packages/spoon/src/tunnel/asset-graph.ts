// Pure helpers for the CDP virtual-network overlay loader (`tunnel-loader-entry.ts`).
//
// When an Electron app blocks all renderer network egress (e.g. Signal denies
// every request with `net::ERR_ACCESS_DENIED`, beneath the layer where
// `Page.setBypassCSP` or CDP `Fetch` interception operate), the hosted follower
// overlay iframe can never load over the network. Instead the controller opens
// a `srcdoc` frame and the loader boots the real Vite app from **blob URLs**,
// fetching every module over a CDP-tunnelled `fetch`. These functions turn the
// app's ES-module graph into a self-contained blob graph:
//
// 1. `extractHtmlModuleUrls` — seed the crawl from the entry HTML.
// 2. `crawlAssetGraph` — BFS the whole graph (static + dynamic imports) via an
//    injected `fetchText`, so the caller controls the transport (tunnelled in
//    the browser, plain `fetch` in tests).
// 3. `rewriteModuleSource` — rewrite every relative import specifier to a stable
//    `slicc-asset:/assets/<file>` key so a single import map can wire the graph
//    to blob URLs without ordering/cycle problems (relative specifiers can't
//    resolve against a `blob:` base).
// 4. `buildAssetImportMap` — assemble the import map the loader injects
//    before importing the entry module (`tunnel-runtime.ts`).
//
// The assets dir is flat (`/assets/<name>-<hash>.js`), so every specifier
// resolves to `/assets/<basename>` regardless of the importing module.

/** Import-map key scheme for tunnelled asset modules. */
export const TUNNEL_ASSET_SCHEME = 'slicc-asset:';

/** Canonical directory every hashed chunk lives under on the hosted origin. */
export const ASSET_DIR = '/assets/';

/**
 * True when `spec` refers to a same-origin JS asset chunk (a relative `./x.js`,
 * an absolute `/assets/x.js`, or a bare `assets/x.js` as emitted in Vite's
 * `__vite__mapDeps`). Bare package specifiers and absolute `http(s)` URLs are
 * left untouched so externalised imports keep resolving normally.
 */
export function isAssetSpecifier(spec: string): boolean {
  const bare = spec.split('?')[0]?.split('#')[0] ?? '';
  if (!bare.endsWith('.js')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(bare)) return false; // has a scheme (http:, data:, slicc-asset:, …)
  return (
    bare.startsWith('./') ||
    bare.startsWith('../') ||
    bare.startsWith('/assets/') ||
    bare.startsWith('assets/')
  );
}

/**
 * Resolve any asset specifier to its canonical `/assets/<basename>` path. The
 * flat assets dir makes the importing module's location irrelevant, so this
 * only needs the basename. Returns `null` for non-asset specifiers.
 */
export function resolveAssetPath(spec: string): string | null {
  if (!isAssetSpecifier(spec)) return null;
  const bare = spec.split('?')[0]?.split('#')[0] ?? '';
  const basename = bare.slice(bare.lastIndexOf('/') + 1);
  return `${ASSET_DIR}${basename}`;
}

/** The import-map key (`slicc-asset:/assets/<basename>`) for an asset path. */
export function assetKey(assetPath: string): string {
  return `${TUNNEL_ASSET_SCHEME}${assetPath}`;
}

// Import/export specifier positions in (minified) ESM. Each captures the quote
// (group 1) and the specifier (group 2) so a single replacer can rewrite them.
const FROM_RE = /\bfrom(\s*)(["'`])([^"'`]+?)\2/g;
const SIDE_EFFECT_IMPORT_RE = /\bimport(\s*)(["'`])([^"'`]+?)\2/g;
const DYNAMIC_IMPORT_RE = /\bimport\(\s*(["'`])([^"'`]+?)\1\s*\)/g;

/**
 * Extract every asset specifier a module source references — static `from`
 * imports, bare side-effect imports, dynamic `import(...)`, and the
 * `"assets/x.js"` entries Vite lists in `__vite__mapDeps` for preloading. Used
 * to discover the transitive graph. Over-inclusive by design (a bare filename
 * string that happens to end in `.js` is cheap to fetch); the import map only
 * wires what the app actually imports.
 */
export function extractAssetSpecifiers(source: string): string[] {
  const found = new Set<string>();
  const collect = (spec: string) => {
    const resolved = resolveAssetPath(spec);
    if (resolved) found.add(resolved);
  };
  for (const m of source.matchAll(FROM_RE)) collect(m[3]);
  for (const m of source.matchAll(SIDE_EFFECT_IMPORT_RE)) collect(m[3]);
  for (const m of source.matchAll(DYNAMIC_IMPORT_RE)) collect(m[2]);
  // __vite__mapDeps: "assets/foo-hash.js"
  for (const m of source.matchAll(/["'`](assets\/[\w.-]+\.js)["'`]/g)) collect(m[1]);
  return [...found];
}

// A `__vite__mapDeps([...])` CALL (not the definition, which is `=(`). Vite's
// preload helper turns the returned `/assets/<file>` paths into `<link
// rel=modulepreload>`s and, in some builds, eager `import()`s. Both compute an
// ABSOLUTE `/assets/x.js` specifier at runtime, which a `blob:`-based module
// can't resolve ("base scheme isn't hierarchical") — and being computed, they
// escape static specifier rewriting. Neutralizing the deps list to `[]` drops
// the (network-bound, doomed) preloads; the actual relative `import("./x.js")`
// still loads the chunk and its own static deps through the import map.
const VITE_MAPDEPS_CALL_RE = /\b__vite__mapDeps\([^)]*\)/g;

/**
 * Rewrite a module's import specifiers to `slicc-asset:` keys so the import map
 * resolves them to blob URLs, and neutralize Vite's `__vite__mapDeps` preload
 * calls (see {@link VITE_MAPDEPS_CALL_RE}). Only touches genuine
 * import/from/dynamic-import positions (never arbitrary `.js` strings used as
 * data) and only asset specifiers (bare/URL specifiers are left as-is).
 */
export function rewriteModuleSource(source: string): string {
  const rewriteSpec = (spec: string): string => {
    const resolved = resolveAssetPath(spec);
    return resolved ? assetKey(resolved) : spec;
  };
  return source
    .replace(VITE_MAPDEPS_CALL_RE, '[]')
    .replace(FROM_RE, (_all, ws, q, spec) => `from${ws}${q}${rewriteSpec(spec)}${q}`)
    .replace(SIDE_EFFECT_IMPORT_RE, (all, ws, q, spec) => {
      // `import(` dynamic form is handled separately; guard against it here.
      const resolved = resolveAssetPath(spec);
      return resolved ? `import${ws}${q}${assetKey(resolved)}${q}` : all;
    })
    .replace(DYNAMIC_IMPORT_RE, (all, q, spec) => {
      const resolved = resolveAssetPath(spec);
      return resolved ? `import(${q}${assetKey(resolved)}${q})` : all;
    });
}

/**
 * Extract the entry module URL(s) from the app's index HTML: the
 * `<script type="module" src>` entry plus every `<link rel="modulepreload">`.
 * These seed the graph crawl. Returned as canonical `/assets/<basename>` paths.
 */
export function extractHtmlModuleUrls(html: string): { entry: string | null; seeds: string[] } {
  const seeds = new Set<string>();
  let entry: string | null = null;

  const scriptRe = /<script\b[^>]*\btype\s*=\s*["']module["'][^>]*>/gi;
  for (const tag of html.matchAll(scriptRe)) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag[0])?.[1];
    if (src) {
      const resolved = resolveAssetPath(src);
      if (resolved) {
        entry ??= resolved;
        seeds.add(resolved);
      }
    }
  }
  const linkRe = /<link\b[^>]*\brel\s*=\s*["']modulepreload["'][^>]*>/gi;
  for (const tag of html.matchAll(linkRe)) {
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag[0])?.[1];
    if (href) {
      const resolved = resolveAssetPath(href);
      if (resolved) seeds.add(resolved);
    }
  }
  return { entry, seeds: [...seeds] };
}

/**
 * BFS the full module graph from `seeds`, fetching each module's source via the
 * injected `fetchText` (tunnelled `fetch` in the browser). `originResolve` maps
 * a canonical `/assets/<basename>` path to the absolute URL to fetch. Modules
 * that fail to fetch are skipped (logged by the caller) so one bad chunk can't
 * abort the whole boot. Returns path → source for every reachable module.
 */
export async function crawlAssetGraph(opts: {
  seeds: string[];
  fetchText: (url: string) => Promise<string>;
  originResolve: (assetPath: string) => string;
  onError?: (assetPath: string, error: unknown) => void;
}): Promise<Map<string, string>> {
  const graph = new Map<string, string>();
  const queue = [...new Set(opts.seeds)];
  const seen = new Set<string>(queue);

  while (queue.length > 0) {
    // Fetch this wave concurrently — the graph is dozens of small chunks.
    const wave = queue.splice(0, queue.length);
    const fetched = await Promise.all(
      wave.map(async (assetPath) => {
        try {
          const source = await opts.fetchText(opts.originResolve(assetPath));
          return { assetPath, source };
        } catch (error) {
          opts.onError?.(assetPath, error);
          return { assetPath, source: null as string | null };
        }
      })
    );
    for (const { assetPath, source } of fetched) {
      if (source === null) continue;
      graph.set(assetPath, source);
      for (const dep of extractAssetSpecifiers(source)) {
        if (!seen.has(dep)) {
          seen.add(dep);
          queue.push(dep);
        }
      }
    }
  }
  return graph;
}

/**
 * Build the import-map `imports` object from asset paths to their blob URLs.
 * Keys are `slicc-asset:/assets/<basename>` so rewritten specifiers resolve to
 * blobs regardless of the (blob:) referrer.
 */
export function buildAssetImportMap(pathToBlob: Map<string, string>): {
  imports: Record<string, string>;
} {
  const imports: Record<string, string> = {};
  for (const [assetPath, blobUrl] of pathToBlob) {
    imports[assetKey(assetPath)] = blobUrl;
  }
  return { imports };
}
