export const TUNNEL_ASSET_SCHEME = 'slicc-asset:';

export const ASSET_DIR = '/assets/';

export function isAssetSpecifier(spec: string): boolean {
  const bare = spec.split('?')[0]?.split('#')[0] ?? '';
  if (!bare.endsWith('.js')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(bare)) return false;
  return (
    bare.startsWith('./') ||
    bare.startsWith('../') ||
    bare.startsWith('/assets/') ||
    bare.startsWith('assets/')
  );
}

export function resolveAssetPath(spec: string): string | null {
  if (!isAssetSpecifier(spec)) return null;
  const bare = spec.split('?')[0]?.split('#')[0] ?? '';
  const basename = bare.slice(bare.lastIndexOf('/') + 1);
  return `${ASSET_DIR}${basename}`;
}

export function assetKey(assetPath: string): string {
  return `${TUNNEL_ASSET_SCHEME}${assetPath}`;
}

const FROM_RE = /\bfrom(\s*)(["'`])([^"'`]+?)\2/g;
const SIDE_EFFECT_IMPORT_RE = /\bimport(\s*)(["'`])([^"'`]+?)\2/g;
const DYNAMIC_IMPORT_RE = /\bimport\(\s*(["'`])([^"'`]+?)\1\s*\)/g;

export function extractAssetSpecifiers(source: string): string[] {
  const found = new Set<string>();
  const collect = (spec: string) => {
    const resolved = resolveAssetPath(spec);
    if (resolved) found.add(resolved);
  };
  for (const m of source.matchAll(FROM_RE)) collect(m[3]);
  for (const m of source.matchAll(SIDE_EFFECT_IMPORT_RE)) collect(m[3]);
  for (const m of source.matchAll(DYNAMIC_IMPORT_RE)) collect(m[2]);

  for (const m of source.matchAll(/["'`](assets\/[\w.-]+\.js)["'`]/g)) collect(m[1]);
  return [...found];
}

const VITE_MAPDEPS_CALL_RE = /\b__vite__mapDeps\([^)]*\)/g;

export function rewriteModuleSource(source: string): string {
  const rewriteSpec = (spec: string): string => {
    const resolved = resolveAssetPath(spec);
    return resolved ? assetKey(resolved) : spec;
  };
  return source
    .replace(VITE_MAPDEPS_CALL_RE, '[]')
    .replace(FROM_RE, (_all, ws, q, spec) => `from${ws}${q}${rewriteSpec(spec)}${q}`)
    .replace(SIDE_EFFECT_IMPORT_RE, (all, ws, q, spec) => {
      const resolved = resolveAssetPath(spec);
      return resolved ? `import${ws}${q}${assetKey(resolved)}${q}` : all;
    })
    .replace(DYNAMIC_IMPORT_RE, (all, q, spec) => {
      const resolved = resolveAssetPath(spec);
      return resolved ? `import(${q}${assetKey(resolved)}${q})` : all;
    });
}

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

export function buildAssetImportMap(pathToBlob: Map<string, string>): {
  imports: Record<string, string>;
} {
  const imports: Record<string, string> = {};
  for (const [assetPath, blobUrl] of pathToBlob) {
    imports[assetKey(assetPath)] = blobUrl;
  }
  return { imports };
}
