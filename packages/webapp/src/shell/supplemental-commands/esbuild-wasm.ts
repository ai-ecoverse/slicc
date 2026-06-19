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
import { splitPath } from '../../fs/path-utils.js';
import { type ModuleReader, resolve } from '../ipk/resolver.js';
import { unpkgUrl } from './cdn-url-builder.js';
import { isExtensionRuntime, isNodeRuntime } from './shared.js';

/** Version string read off the installed `esbuild-wasm` package. */
export const ESBUILD_VERSION = esbuild.version;

/**
 * Public CDN URL for `esbuild.wasm`. Pinned to the installed
 * wrapper's version so the wasm asset always matches the JS
 * wrapper that's about to consume it.
 */
export const ESBUILD_WASM_CDN_URL = unpkgUrl(
  'esbuild-wasm',
  ESBUILD_VERSION,
  'esbuild.wasm'
).toString();

const CACHE_NAME = `slicc-esbuild-${ESBUILD_VERSION}`;

/**
 * Read-only VFS context the loader needs to prefer an ipk-installed
 * `esbuild-wasm/esbuild.wasm` over the CDN path. `reader` is the
 * resolver's `ModuleReader` (used to find the package via the standard
 * `node_modules` walk); `readBytes` reads the resolved `.wasm` as raw
 * bytes (the resolver's `readFile` is text-only). `fromDir` is the
 * starting directory for the `node_modules` walk — typically the
 * shell `cwd` of the calling command.
 */
export interface IpkResolutionContext {
  reader: ModuleReader;
  readBytes(absolutePath: string): Promise<Uint8Array>;
  fromDir: string;
}

let esbuildPromise: Promise<typeof esbuild> | null = null;

/**
 * Public entry point. Idempotent across calls within a session —
 * `esbuild.initialize` may only be called once per realm, so the
 * loader memoizes the underlying promise and re-throws the same
 * failure if init was rejected (a fresh import would still reject).
 *
 * `ipk` (optional) lets the browser path prefer an installed copy of
 * `esbuild-wasm` in the VFS `node_modules` (via the ipk resolver)
 * over the hardcoded CDN. When omitted or when nothing is installed,
 * the CDN+Cache fallback runs unchanged.
 */
export async function getEsbuild(
  options: { onProgress?: (msg: string) => void; ipk?: IpkResolutionContext } = {}
): Promise<typeof esbuild> {
  if (!esbuildPromise) {
    esbuildPromise = loadEsbuild(options.onProgress, options.ipk).catch((err) => {
      esbuildPromise = null;
      throw err;
    });
  }
  return esbuildPromise;
}

/**
 * Try to read `esbuild.wasm` from an ipk-installed `esbuild-wasm` in
 * the VFS. Resolves `esbuild-wasm/package.json` through the shared
 * resolver (so the standard `node_modules` walk and resolution rules
 * apply), derives the package directory from the resolved file, and
 * reads sibling `esbuild.wasm` bytes. Returns `null` on any miss —
 * the caller falls back to the CDN+Cache path.
 *
 * Exported so the loader's resolution behavior is unit-testable
 * without booting the heavy WASM service.
 */
export async function tryLoadEsbuildWasmFromNodeModules(
  ipk: IpkResolutionContext
): Promise<Uint8Array | null> {
  let resolved;
  try {
    resolved = await resolve('esbuild-wasm/package.json', ipk.fromDir, ipk.reader);
  } catch {
    return null;
  }
  if (resolved.type !== 'file') return null;
  const pkgDir = splitPath(resolved.path).dir;
  const wasmPath = `${pkgDir}/esbuild.wasm`;
  if (!(await ipk.reader.exists(wasmPath))) return null;
  try {
    return await ipk.readBytes(wasmPath);
  } catch {
    return null;
  }
}

async function loadEsbuild(
  onProgress?: (msg: string) => void,
  ipk?: IpkResolutionContext
): Promise<typeof esbuild> {
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

  // Browser (standalone OR extension): prefer an ipk-installed copy
  // of `esbuild.wasm` in the VFS `node_modules` when present, falling
  // back to the Cache Storage-backed CDN fetch when nothing is
  // installed (or no ipk context was supplied). The compiled
  // `WebAssembly.Module` path is symmetric across floats.
  let bytes: Uint8Array | null = null;
  if (ipk) {
    bytes = await tryLoadEsbuildWasmFromNodeModules(ipk);
    if (bytes) {
      log(`esbuild.wasm loaded from ipk node_modules (${bytes.byteLength} bytes)`);
    }
  }
  if (!bytes) {
    log('downloading esbuild.wasm (cached after first run)...');
    bytes = await fetchWithCache(ESBUILD_WASM_CDN_URL, 'application/wasm', log);
  }
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
