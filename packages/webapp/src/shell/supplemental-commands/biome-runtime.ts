/**
 * Shared Biome runtime loader. Mirrors `esbuild-wasm.ts` in shape:
 * a single memoized promise resolves to a ready-to-use `Biome`
 * instance plus the freshly-opened `projectKey` that every
 * `formatContent` / `lintContent` call needs.
 *
 * Two paths:
 *
 *  - **Node / vitest** — `@biomejs/js-api/nodejs` is consumed, which
 *    transitively imports `@biomejs/wasm-nodejs`. That distribution
 *    loads the wasm bytes synchronously via `fs.readFileSync`, so
 *    `new Biome()` works the moment the dynamic import resolves.
 *
 *  - **Browser (standalone + extension)** — the ~33 MB
 *    `biome_wasm_bg.wasm` binary is fetched from a versioned CDN URL
 *    on first call, cached through the Cache Storage API, compiled to
 *    a `WebAssembly.Module`, and handed to the wasm-bindgen entry
 *    (`@biomejs/wasm-web`'s default export). The `@biomejs/js-api/web`
 *    wrapper is then constructed over the now-initialized module. Same
 *    flow in standalone and extension floats — using a compiled
 *    `WebAssembly.Module` sidesteps the blob-URL / extension-origin CSP
 *    differences that bit esbuild.
 *
 *    Because we always pass that compiled module, wasm-bindgen's
 *    zero-config `new URL('biome_wasm_bg.wasm', import.meta.url)`
 *    fallback is dead code — but Vite still statically emits the 33 MB
 *    binary as a build asset, which trips Cloudflare's 25 MiB per-asset
 *    cap on the worker deploy. `packages/webapp/vite-plugins/strip-biome-wasm-asset.ts`
 *    strips that dead asset from the build output and repoints the
 *    reference at this same CDN URL.
 *
 *  Memoization mirrors `esbuild-wasm.ts` — a failed init clears the
 *  cached promise so a retry re-attempts the load. Without that, a
 *  single transient network blip would poison the rest of the
 *  session.
 *
 *  Renovate compatibility: the CDN URL derives from the installed
 *  `@biomejs/wasm-web` package's `version` field (read off its
 *  `package.json`), so a renovate bump rolls the wasm asset URL in
 *  lockstep.
 */

import type { Biome } from '@biomejs/js-api';
import type { ProjectKey } from '@biomejs/wasm-web';
import wasmWebPkg from '@biomejs/wasm-web/package.json' with { type: 'json' };
import { splitPath } from '../../fs/path-utils.js';
import { type ModuleReader, resolve } from '../ipk/resolver.js';
import { unpkgUrl } from './cdn-url-builder.js';
import { isNodeRuntime, resolvePinnedPackageVersion } from './shared.js';

export const BIOME_VERSION = resolvePinnedPackageVersion(
  '@biomejs/wasm-web',
  (wasmWebPkg as { version?: unknown }).version
);

export const BIOME_WASM_CDN_URL = unpkgUrl(
  '@biomejs/wasm-web',
  BIOME_VERSION,
  'biome_wasm_bg.wasm'
).toString();

const CACHE_NAME = `slicc-biome-${BIOME_VERSION}`;

export interface BiomeRuntime {
  biome: Biome;
  projectKey: ProjectKey;
  version: string;
}

/**
 * Read-only VFS context the loader needs to prefer an ipk-installed
 * `@biomejs/wasm-web/biome_wasm_bg.wasm` over the CDN path. `reader`
 * is the resolver's `ModuleReader` (used to find the package via the
 * standard `node_modules` walk); `readBytes` reads the resolved
 * `.wasm` as raw bytes (the resolver's `readFile` is text-only).
 * `fromDir` is the starting directory for the `node_modules` walk —
 * typically the shell `cwd` of the calling command.
 */
export interface IpkResolutionContext {
  reader: ModuleReader;
  readBytes(absolutePath: string): Promise<Uint8Array>;
  fromDir: string;
}

let runtimePromise: Promise<BiomeRuntime> | null = null;

/**
 * `ipk` (optional) lets the browser path prefer an installed copy of
 * `@biomejs/wasm-web` in the VFS `node_modules` (via the ipk
 * resolver) over the hardcoded CDN. When omitted or when nothing is
 * installed, the CDN+Cache fallback runs unchanged.
 */
export async function getBiome(
  options: { onProgress?: (msg: string) => void; ipk?: IpkResolutionContext } = {}
): Promise<BiomeRuntime> {
  if (!runtimePromise) {
    runtimePromise = loadBiome(options.onProgress, options.ipk).catch((err) => {
      runtimePromise = null;
      throw err;
    });
  }
  return runtimePromise;
}

/**
 * Try to read `biome_wasm_bg.wasm` from an ipk-installed
 * `@biomejs/wasm-web` in the VFS. Resolves
 * `@biomejs/wasm-web/package.json` through the shared resolver (so
 * the standard `node_modules` walk applies), derives the package
 * directory from the resolved file, and reads sibling
 * `biome_wasm_bg.wasm` bytes. Returns `null` on any miss — the
 * caller falls back to the CDN+Cache path.
 *
 * Exported so the loader's resolution behavior is unit-testable
 * without booting the heavy WASM workspace.
 */
export async function tryLoadBiomeWasmFromNodeModules(
  ipk: IpkResolutionContext
): Promise<Uint8Array | null> {
  let resolved;
  try {
    resolved = await resolve('@biomejs/wasm-web/package.json', ipk.fromDir, ipk.reader);
  } catch {
    return null;
  }
  if (resolved.type !== 'file') return null;
  const pkgDir = splitPath(resolved.path).dir;
  const wasmPath = `${pkgDir}/biome_wasm_bg.wasm`;
  if (!(await ipk.reader.exists(wasmPath))) return null;
  try {
    return await ipk.readBytes(wasmPath);
  } catch {
    return null;
  }
}

async function loadBiome(
  onProgress?: (msg: string) => void,
  ipk?: IpkResolutionContext
): Promise<BiomeRuntime> {
  const log = onProgress ?? (() => {});

  if (isNodeRuntime()) {
    // Node / vitest: `@biomejs/wasm-nodejs` loads the wasm at import
    // time via `fs.readFileSync`. Nothing to do — return the
    // workspace-ready Biome instance immediately.
    log('biome ready (node wasm)');
    const { Biome } = await import('@biomejs/js-api/nodejs');
    const biome = new Biome();
    const { projectKey } = biome.openProject();
    return { biome, projectKey, version: BIOME_VERSION };
  }

  // Browser (standalone OR extension): prefer an ipk-installed copy
  // of `biome_wasm_bg.wasm` in the VFS `node_modules` when present,
  // falling back to the Cache Storage-backed CDN fetch when nothing
  // is installed (or no ipk context was supplied).
  let bytes: Uint8Array | null = null;
  if (ipk) {
    bytes = await tryLoadBiomeWasmFromNodeModules(ipk);
    if (bytes) {
      log(`biome_wasm_bg.wasm loaded from ipk node_modules (${bytes.byteLength} bytes)`);
    }
  }
  if (!bytes) {
    log('downloading biome_wasm_bg.wasm (cached after first run)...');
    bytes = await fetchWithCache(BIOME_WASM_CDN_URL, 'application/wasm', log);
  }
  // Materialize the underlying ArrayBuffer explicitly so the
  // WebAssembly.compile typings don't trip on the
  // `SharedArrayBuffer | ArrayBuffer` union that Uint8Array carries.
  const wasmBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(wasmBuffer).set(bytes);
  const wasmModule = await WebAssembly.compile(wasmBuffer);

  const wasmWeb = await import('@biomejs/wasm-web');
  // wasm-bindgen accepts an init-options object whose
  // `module_or_path` may be a `WebAssembly.Module`; the older
  // positional form is logged as deprecated. Hand the compiled
  // module in via the object form.
  const init = (
    wasmWeb as { default: (input: { module_or_path: WebAssembly.Module }) => Promise<unknown> }
  ).default;
  await init({ module_or_path: wasmModule });

  const { Biome } = await import('@biomejs/js-api/web');
  const biome = new Biome();
  const { projectKey } = biome.openProject();
  log('biome ready');
  return { biome, projectKey, version: BIOME_VERSION };
}

async function fetchWithCache(
  url: string,
  contentType: string,
  log: (msg: string) => void
): Promise<Uint8Array> {
  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(url);
      if (hit) {
        return new Uint8Array(await hit.arrayBuffer());
      }
    } catch {
      /* fall through to network */
    }
  }
  log(`fetching ${shortUrl(url)}...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`@biomejs/wasm-web fetch ${url} failed: HTTP ${res.status}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(CACHE_NAME);
      const stored = new Response(bytes, { headers: { 'content-type': contentType } });
      await cache.put(url, stored);
    } catch {
      /* best-effort */
    }
  }
  return bytes;
}

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').slice(0, 64);
}

/**
 * Drop the cached runtime promise so the next `getBiome` call
 * rebuilds from scratch. Test-only — production callers share the
 * single initialized workspace for the lifetime of the realm.
 */
export function resetBiomeForTests(): void {
  runtimePromise = null;
}
