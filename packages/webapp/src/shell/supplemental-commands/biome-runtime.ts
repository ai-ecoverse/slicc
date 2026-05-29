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
import { isNodeRuntime, resolvePinnedPackageVersion } from './shared.js';

export const BIOME_VERSION = resolvePinnedPackageVersion(
  '@biomejs/wasm-web',
  (wasmWebPkg as { version?: unknown }).version
);

export const BIOME_WASM_CDN_URL = `https://unpkg.com/@biomejs/wasm-web@${BIOME_VERSION}/biome_wasm_bg.wasm`;

const CACHE_NAME = `slicc-biome-${BIOME_VERSION}`;

export interface BiomeRuntime {
  biome: Biome;
  projectKey: ProjectKey;
  version: string;
}

let runtimePromise: Promise<BiomeRuntime> | null = null;

export async function getBiome(
  options: { onProgress?: (msg: string) => void } = {}
): Promise<BiomeRuntime> {
  if (!runtimePromise) {
    runtimePromise = loadBiome(options.onProgress).catch((err) => {
      runtimePromise = null;
      throw err;
    });
  }
  return runtimePromise;
}

async function loadBiome(onProgress?: (msg: string) => void): Promise<BiomeRuntime> {
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

  // Browser (standalone OR extension): fetch the wasm bytes through
  // the Cache Storage-backed path, compile to a module, hand it to
  // the wasm-bindgen init, then construct the high-level wrapper.
  log('downloading biome_wasm_bg.wasm (cached after first run)...');
  const bytes = await fetchWithCache(BIOME_WASM_CDN_URL, 'application/wasm', log);
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
