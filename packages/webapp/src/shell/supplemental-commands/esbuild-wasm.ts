/**
 * Shared esbuild-wasm loader. Bundled as the small `esbuild-wasm`
 * JS wrapper; the heavy `esbuild.wasm` binary (~10 MB) is NOT
 * bundled in the browser builds — it is fetched on demand the
 * first time `esbuild` runs in a session, mirroring the
 * `ffmpeg-wasm.ts` pattern.
 *
 * Caching: downloaded bytes are stored via the Cache Storage API
 * under a versioned name so subsequent loads (same session OR
 * across reloads) skip the network. The HTTP cache alone is too
 * volatile for a multi-MB asset.
 *
 * Extension mode: the wasm bytes are materialized through Cache
 * Storage, compiled to a `WebAssembly.Module`, and handed to
 * `initialize({ wasmModule })` — sidestepping any blob-URL or
 * `wasmURL` CSP differences between extension and standalone.
 *
 * Standalone CLI: same path. `initialize` accepts either a
 * `wasmURL` or a `wasmModule`; passing the compiled module keeps
 * the loader symmetric across floats.
 *
 * Vitest / Node: the `esbuild-wasm` npm package's Node entry
 * (`lib/main.js`, picked when `"main"` resolves) spawns a wasm
 * subprocess via `node bin/esbuild` and explicitly REJECTS the
 * `wasmURL` / `wasmModule` / `worker` options on `initialize`.
 * The Node path therefore must not call `initialize` at all —
 * `esbuild.build()` lazily boots the service on first call.
 *
 * Renovate compatibility: the loader has no hand-maintained
 * version constant — the CDN URL derives from the installed
 * package's runtime `esbuild.version`, so a renovate bump of
 * `esbuild-wasm` rolls the wasm asset URL in lockstep.
 */

import * as esbuild from 'esbuild-wasm';
import { isExtensionRuntime, isNodeRuntime } from './shared.js';

/** Version string read off the installed `esbuild-wasm` package. */
export const ESBUILD_VERSION = esbuild.version;

/**
 * Public CDN URL for `esbuild.wasm`. Pinned to the installed
 * wrapper's version so the wasm asset always matches the JS
 * wrapper that's about to consume it.
 */
export const ESBUILD_WASM_CDN_URL = `https://unpkg.com/esbuild-wasm@${ESBUILD_VERSION}/esbuild.wasm`;

const CACHE_NAME = `slicc-esbuild-${ESBUILD_VERSION}`;

let esbuildPromise: Promise<typeof esbuild> | null = null;

/**
 * Public entry point. Idempotent across calls within a session —
 * `esbuild.initialize` may only be called once per realm, so the
 * loader memoizes the underlying promise and re-throws the same
 * failure if init was rejected (a fresh import would still reject).
 */
export async function getEsbuild(
  options: { onProgress?: (msg: string) => void } = {}
): Promise<typeof esbuild> {
  if (!esbuildPromise) {
    esbuildPromise = loadEsbuild(options.onProgress).catch((err) => {
      esbuildPromise = null;
      throw err;
    });
  }
  return esbuildPromise;
}

async function loadEsbuild(onProgress?: (msg: string) => void): Promise<typeof esbuild> {
  const log = onProgress ?? (() => {});

  if (isNodeRuntime()) {
    // Node / vitest: the package entry (`lib/main.js`) ships a
    // subprocess-based service that boots lazily on the first
    // `build` / `transform` call. Calling `initialize` here would
    // throw (see file header). Nothing to do — return the module
    // as-is; the service will spin up on demand.
    log('esbuild ready (node service)');
    return esbuild;
  }

  // Browser (standalone OR extension): fetch the wasm bytes through
  // the Cache Storage-backed path, compile to a module, and hand it
  // to `initialize` as `wasmModule`. Symmetric across floats.
  const url = ESBUILD_WASM_CDN_URL;
  log('downloading esbuild.wasm (cached after first run)...');
  const bytes = await fetchWithCache(url, 'application/wasm', log);
  // Materialize the underlying ArrayBuffer explicitly so the
  // WebAssembly.compile typings don't trip on the
  // `SharedArrayBuffer | ArrayBuffer` union that Uint8Array<...>
  // carries under newer lib.dom.d.ts.
  const wasmBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(wasmBuffer).set(bytes);
  const wasmModule = await WebAssembly.compile(wasmBuffer);
  // Run the wasm in a web worker by default to keep the calling
  // thread responsive. The extension's offscreen document opts out
  // because spawning a worker that imports `https://...` source
  // bumps into the extension origin's CSP; running on the offscreen
  // thread is fine because the offscreen document is already
  // dedicated to the agent runtime.
  await esbuild.initialize({ wasmModule, worker: !isExtensionRuntime() });
  log('esbuild ready');
  return esbuild;
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
    throw new Error(`esbuild-wasm fetch ${url} failed: HTTP ${res.status}`);
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
 * Drop the cached esbuild promise so the next `getEsbuild` call
 * rebuilds from scratch. Test-only — production callers share the
 * single loaded instance for the lifetime of the realm.
 */
export function resetEsbuildForTests(): void {
  esbuildPromise = null;
}
